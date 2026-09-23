/**
 * Pi Agent 会话 fork / rewind。
 *
 * 迁出自 apps/electron/src/main/lib/agent-session-manager.ts——这是该文件里
 * 唯一真正 Pi 专属的部分（依赖 Pi SessionManager 的 append-only session tree），
 * 其余索引/分页/CRUD 已下沉到 packages/kernel 的 agent-session-store.ts。
 *
 * 路径解析 / 工作区查询 / 模型校验同样是 Electron 强耦合，通过
 * configureAgentSessionFork() 一次性注入（与 agent-session-store.ts 的
 * "配置一次" 模式一致），由 apps/electron 的 agent-session-manager.ts shim
 * 在模块加载时装配。
 */

import { existsSync, readFileSync, createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import {
  parseJsonlStrict,
  normalizePersistedSDKMessage,
  serializeSDKMessageForStorage,
  getAgentSessionMeta,
  updateAgentSessionMeta,
  createAgentSession,
  deleteAgentSessionCore,
  getAgentCwdMode,
  getSessionWorkbenchLayout,
  getActiveWorktreePath,
  resolveAgentCwd,
  resolveAgentWorkbenchDir,
  copySkillActivationSidecar,
  pruneSkillActivationSidecar,
  writeTextFileAtomic,
} from '@canopy/kernel'
import type { AgentSessionMeta, AgentWorkspace, ForkSessionInput, SDKMessage, AgentMessage } from '@canopy/shared'
// 旧格式 → SDKMessage 的转换逻辑下沉到 @canopy/session-core 作为唯一真源，避免主进程与渲染层各存一份。
import { convertLegacyMessage } from '@canopy/session-core'
import { copyForkWorkspaceFiles } from './agent-fork-workspace-copy'
import { CANOPY_BRAND } from '@canopy/brand'

/** fork/rewind 需要的路径解析——与 kernel 的 AgentSessionPathResolver 同源，同一份真实实现注入两处。 */
export interface AgentSessionForkPathResolver {
  getAgentSessionMessagesPath(id: string): string
  getAgentSessionSkillActivationsPath(id: string): string
  getSdkConfigDir(): string
}

/** fork/rewind 需要的工作区查询——与 kernel 的 AgentSessionWorkspaceLookup 同源。 */
export interface AgentSessionForkWorkspaceLookup {
  getAgentWorkspace(id: string): AgentWorkspace | undefined
}

export interface AgentSessionForkDeps {
  paths: AgentSessionForkPathResolver
  workspaces: AgentSessionForkWorkspaceLookup
  assertEnabledModelForChannel(input: { channelId?: string; modelId?: string; purpose: string }): string | undefined
}

let forkDeps: AgentSessionForkDeps | null = null

/** 由调用方（electron shim）在模块加载时调用一次；未调用前 fork/rewind 都会抛错。 */
export function configureAgentSessionFork(deps: AgentSessionForkDeps): void {
  forkDeps = deps
}

function requireForkDeps(): AgentSessionForkDeps {
  if (!forkDeps) {
    throw new Error('[Agent 会话] configureAgentSessionFork 尚未调用')
  }
  return forkDeps
}

/**
 * 分叉 Pi Agent 会话。
 *
 * 退役 Claude transcript 仅可阅读，不能映射为 Pi session artifact 后续执行。
 */
export async function forkAgentSession(input: ForkSessionInput): Promise<AgentSessionMeta> {
  const sourceMeta = getAgentSessionMeta(input.sessionId)
  if (!sourceMeta) throw new Error(`源 Agent 会话不存在: ${input.sessionId}`)
  if (sourceMeta.legacyTranscript) {
    throw new Error('历史 Claude transcript 为只读，不能分叉；请新建 Pi 会话继续')
  }
  return forkPiAgentSession(sourceMeta, input)
}

/**
 * Pi 的 session 是 append-only tree。分叉必须由 SessionManager 导出目标 branch，
 * 不能只复制 Canopy 的展示 JSONL，否则下一轮 resume 仍会看到被截断的上下文。
 */
async function forkPiAgentSession(sourceMeta: AgentSessionMeta, input: ForkSessionInput): Promise<AgentSessionMeta> {
  const targetUuid = input.upToMessageUuid
  if (!targetUuid) throw new Error('Pi 分叉需要指定一条已完成的 assistant 消息')
  const entryId = sourceMeta.piEntryBindings?.[targetUuid]
  if (!entryId) throw new Error(`该 Pi 历史消息尚无 entry ID 映射，无法安全分叉；请在新版 ${CANOPY_BRAND.productName} 中继续一次对话后再试`)
  if (!sourceMeta.piSessionFile || !existsSync(sourceMeta.piSessionFile)) {
    throw new Error('未找到 Pi session artifact，无法安全分叉')
  }

  const deps = requireForkDeps()
  const forkModelId = input.modelId !== undefined
    ? deps.assertEnabledModelForChannel({ channelId: sourceMeta.channelId, modelId: input.modelId, purpose: '分叉 Pi Agent 会话' })
    : sourceMeta.modelId
  const workspace = sourceMeta.workspaceId ? deps.workspaces.getAgentWorkspace(sourceMeta.workspaceId) : undefined
  const sourceCwdMode = getAgentCwdMode(sourceMeta)
  const sourceWorkbenchLayout = getSessionWorkbenchLayout(sourceMeta)
  const sourceActiveWorktree = getActiveWorktreePath(sourceMeta) ? sourceMeta.activeWorktree : undefined
  const sourceDir = resolveAgentCwd(workspace, sourceMeta.id, sourceCwdMode, sourceActiveWorktree)
  const sourceWorkbenchDir = resolveAgentWorkbenchDir(workspace, sourceMeta.id)
  const newMeta = createAgentSession(
    `${sourceMeta.title} (fork)`,
    sourceMeta.channelId,
    sourceMeta.workspaceId,
    forkModelId,
    sourceCwdMode,
    sourceWorkbenchLayout,
  )
  const destDir = resolveAgentCwd(workspace, newMeta.id, newMeta.agentCwdMode, sourceActiveWorktree)
  const destWorkbenchDir = resolveAgentWorkbenchDir(workspace, newMeta.id)

  try {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const sessionDir = join(deps.paths.getSdkConfigDir(), 'sessions')
    const sourceManager = sdk.SessionManager.open(sourceMeta.piSessionFile, sessionDir, sourceDir)
    const branchFile = sourceManager.createBranchedSession(entryId)
    if (!branchFile || !existsSync(branchFile)) {
      throw new Error('Pi 未能生成分叉 session artifact')
    }
    const forkedManager = sdk.SessionManager.forkFrom(branchFile, destDir ?? sourceDir ?? process.cwd(), sessionDir)
    const piSessionFile = forkedManager.getSessionFile()
    if (!piSessionFile || !existsSync(piSessionFile)) throw new Error('Pi 分叉 artifact 校验失败')
    // 新 branch 只包含分叉点之前的 entry；不能把源树后续 turn 的映射带入 metadata。
    const branchBindings = Object.fromEntries(
      Object.entries(sourceMeta.piEntryBindings ?? {})
        .filter(([, mappedEntryId]) => Boolean(forkedManager.getEntry(mappedEntryId))),
    )

    const explorationMeta = input.explorationSourceLabel ? {
      explorationParentSessionId: sourceMeta.id,
      explorationSourceMessageId: targetUuid,
      explorationSourceLabel: input.explorationSourceLabel,
    } : {}
    updateAgentSessionMeta(newMeta.id, {
      sdkSessionId: forkedManager.getSessionId(),
      piSessionFile,
      piEntryBindings: branchBindings,
      activeWorktree: sourceActiveWorktree,
      forkSourceDir: sourceDir,
      ...explorationMeta,
    })
    newMeta.sdkSessionId = forkedManager.getSessionId()
    newMeta.piSessionFile = piSessionFile
    newMeta.piEntryBindings = branchBindings
    newMeta.activeWorktree = sourceActiveWorktree
    Object.assign(newMeta, explorationMeta)

    // 上游 v0.19.26（#1926）把 copyForkWorkspaceFiles 改为异步以免阻塞探索 fork；
    // 该调用点在我方 0.18.51 重构中已迁出 apps/electron，故此处手工补 await（合并轮翻译）。
    if (sourceWorkbenchDir && destWorkbenchDir) await copyForkWorkspaceFiles(sourceWorkbenchDir, destWorkbenchDir)
    await copyForkStoredSDKMessages({
      sourceSessionId: sourceMeta.id,
      destSessionId: newMeta.id,
      upToMessageUuid: targetUuid,
      sourceDir,
      destDir,
    })
    return newMeta
  } catch (error) {
    // 尚未对外返回的新 session 可安全清理，避免留下会被侧栏打开的半成品。
    try { deleteAgentSessionCore(newMeta.id) } catch { /* 保留原始错误 */ }
    throw error
  }
}

/**
 * 将当前 Pi 会话切换到指定 assistant turn 的新 branch artifact（持久化回退）。
 *
 * Canopy JSONL 和 Pi branch artifact 是两个事实源：先完整校验 JSONL，再创建 branch；
 * JSONL 写入成功后才提交 metadata。metadata 写入失败时会恢复原 JSONL，避免两边分叉。
 */
export async function rewindPiAgentSession(sessionId: string, assistantMessageUuid: string): Promise<number> {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('Agent 会话不存在')
  if (meta.legacyTranscript) throw new Error('历史 Claude transcript 为只读，不能回退；请新建 Pi 会话继续')
  const entryId = meta.piEntryBindings?.[assistantMessageUuid]
  if (!entryId) throw new Error('该 Pi 历史消息尚无 entry ID 映射，无法安全回退')
  if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) throw new Error('未找到 Pi session artifact，无法安全回退')

  const deps = requireForkDeps()
  const filePath = deps.paths.getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) throw new Error(`[Agent 会话] 截断失败: 会话消息文件不存在, sessionId=${sessionId}`)
  const originalContent = readFileSync(filePath, 'utf-8')
  const originalMessages = parseJsonlStrict<unknown>(originalContent.split('\n').filter((line) => line.trim()), `截断读取 SDKMessage (${sessionId})`).map(normalizePersistedSDKMessage)
  const cutIndex = originalMessages.findIndex((message) => 'uuid' in message && (message as { uuid?: string }).uuid === assistantMessageUuid)
  if (cutIndex < 0) throw new Error(`[Agent 会话] 截断失败: 未找到 uuid=${assistantMessageUuid}, sessionId=${sessionId}`)
  const kept = originalMessages.slice(0, cutIndex + 1)
  const truncatedContent = kept.map((message) => JSON.stringify(message)).join('\n') + (kept.length > 0 ? '\n' : '')

  const workspace = meta.workspaceId ? deps.workspaces.getAgentWorkspace(meta.workspaceId) : undefined
  const cwd = resolveAgentCwd(workspace, meta.id, meta.agentCwdMode, meta.activeWorktree) ?? process.cwd()
  const sdk = await import('@earendil-works/pi-coding-agent')
  const manager = sdk.SessionManager.open(meta.piSessionFile, join(deps.paths.getSdkConfigDir(), 'sessions'), cwd)
  const branchFile = manager.createBranchedSession(entryId)
  if (!branchFile || !existsSync(branchFile)) throw new Error('Pi 未能生成回退 session artifact')
  const rewindManager = sdk.SessionManager.open(branchFile, join(deps.paths.getSdkConfigDir(), 'sessions'), cwd)
  const retainedAssistantUuids = new Set(
    kept.flatMap((message) => {
      const candidate = message as { uuid?: unknown; type?: unknown }
      return candidate.type === 'assistant' && typeof candidate.uuid === 'string' ? [candidate.uuid] : []
    }),
  )
  const retainedBindings = Object.fromEntries(
    Object.entries(meta.piEntryBindings ?? {}).filter(([messageUuid, mappedEntryId]) =>
      retainedAssistantUuids.has(messageUuid) && Boolean(rewindManager.getEntry(mappedEntryId))),
  )

  // 全量重写前 writeTextFileAtomic 会把回退前的完整正文留成 .bak——
  // 若此处与下方元数据提交之间进程被杀，那是找回被截掉消息的唯一线索。
  writeTextFileAtomic(filePath, truncatedContent)
  try {
    updateAgentSessionMeta(sessionId, {
      sdkSessionId: rewindManager.getSessionId(),
      piSessionFile: branchFile,
      piEntryBindings: retainedBindings,
    })
  } catch (error) {
    // 回滚是在恢复原文，跳过备份：让 .bak 继续保存回退前的原文，而不是被截断版覆盖
    try { writeTextFileAtomic(filePath, originalContent, true) } catch { /* 保留原始 metadata 错误 */ }
    throw error
  }

  // 被截掉的 user 消息对应的 Skill 激活条目顺手修剪（留着也无害，只是整洁）
  try {
    const keptUserUuids = new Set(kept.flatMap((message) => {
      const candidate = message as { uuid?: unknown; type?: unknown }
      return candidate.type === 'user' && typeof candidate.uuid === 'string' ? [candidate.uuid] : []
    }))
    pruneSkillActivationSidecar(deps.paths.getAgentSessionSkillActivationsPath(sessionId), keptUserUuids)
  } catch (error) {
    console.warn(`[Agent 会话] 修剪 Skill 激活 sidecar 失败 (${sessionId}):`, error)
  }
  console.log(`[Agent 会话] Pi 会话已回退: sessionId=${sessionId}, 保留 ${kept.length}/${originalMessages.length} 条`)
  return kept.length
}

interface CopyForkStoredSDKMessagesInput {
  sourceSessionId: string
  destSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}

function getStoredMessageUuid(msg: SDKMessage): string | undefined {
  return 'uuid' in msg ? (msg as { uuid?: string }).uuid : undefined
}

async function writeJsonlLine(stream: WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line + '\n', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function endWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

async function copyForkStoredSDKMessages({
  sourceSessionId,
  destSessionId,
  upToMessageUuid,
  sourceDir,
  destDir,
}: CopyForkStoredSDKMessagesInput): Promise<number> {
  const deps = requireForkDeps()
  const sourcePath = deps.paths.getAgentSessionMessagesPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0

  const destPath = deps.paths.getAgentSessionMessagesPath(destSessionId)
  const out = createWriteStream(destPath, { flags: 'a', encoding: 'utf-8' })
  let copiedCount = 0

  const copiedUserUuids = new Set<string>()
  try {
    for await (const msg of readStoredSDKMessages(sourcePath)) {
      await writeJsonlLine(out, serializeSDKMessageForStorage(msg, sourceDir, destDir))
      copiedCount += 1
      const uuid = getStoredMessageUuid(msg)
      if (msg.type === 'user' && typeof uuid === 'string') copiedUserUuids.add(uuid)

      if (upToMessageUuid && uuid === upToMessageUuid) {
        break
      }
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    throw err
  }

  // 被复制过去的 user 消息，其 Skill 激活 sidecar 条目也一并带到新会话
  try {
    copySkillActivationSidecar(
      deps.paths.getAgentSessionSkillActivationsPath(sourceSessionId),
      deps.paths.getAgentSessionSkillActivationsPath(destSessionId),
      copiedUserUuids,
    )
  } catch (error) {
    console.warn(`[Agent 会话] 复制 Skill 激活 sidecar 失败 (${sourceSessionId} → ${destSessionId}):`, error)
  }

  return copiedCount
}

async function* readStoredSDKMessages(filePath: string): AsyncGenerator<SDKMessage> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ('role' in parsed && !('type' in parsed)) {
        yield convertLegacyMessage(parsed as AgentMessage)
      } else {
        yield parsed as SDKMessage
      }
    } catch (err) {
      console.warn(`[Agent 会话] 跳过无法解析的 SDKMessage 行 (${filePath}):`, err)
    }
  }
}
