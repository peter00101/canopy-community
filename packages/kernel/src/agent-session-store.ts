/**
 * Agent 会话存储（Runtime 无关部分）
 *
 * 负责 Agent 会话的 CRUD 操作、索引缓存、消息持久化与检索——从
 * apps/electron/src/main/lib/agent-session-manager.ts 迁出，剥离 fork/rewind
 * （那部分是 Pi SessionManager 专属，留在 packages/runtime-pi 的
 * agent-session-fork.ts）。路径解析 / 工作区查询 / 思考设置读取通过
 * configureAgentSessionStore() 一次性注入（与 apps/electron 的
 * agent-service.ts 现有的「模块级单例装配」惯例一致），因为这些能力
 * 本身是 Electron 强耦合（config-paths.ts 经 getConfigDir() 依赖
 * `require('electron')`），kernel 不能直接 import 它们。
 *
 * - 会话索引：~/.canopy/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.canopy/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 */

import { readFileSync, appendFileSync, existsSync, readdirSync, createReadStream, statSync, openSync, closeSync, readSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { writeJsonFileAtomic, writeTextFileAtomic, readJsonFileSafe, removeFileWithCompanions } from './safe-file'
import {
  applySkillActivationSidecar,
  readSkillActivationSidecar,
  removeSkillActivationSidecar,
  upsertSkillActivations,
} from './agent-session-skill-activations'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import type {
  AgentSessionMeta,
  AgentMessage,
  SDKMessage,
  SkillActivation,
  AgentWorkspace,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
  AgentCwdMode,
  AgentActiveWorktree,
  SessionWorkbenchLayout,
  AgentEffort,
  AgentThinkingLevel,
  ThinkingConfig,
  SDKAssistantMessage,
  SDKResultMessage,
} from '@canopy/shared'
import { migratePermissionMode, findBestSearchMatch, insertTopSearchResult, calculateContextUsageRatio, inferContextWindow } from '@canopy/shared'
// 旧格式 → SDKMessage 的转换逻辑下沉到 @canopy/session-core 作为唯一真源，避免主进程与渲染层各存一份。
import { convertLegacyMessage } from '@canopy/session-core'

/**
 * 会话路径解析——本质是 config-paths.ts 里贯穿全文件的 7 个函数。
 * config-paths.ts 经 getConfigDir() 依赖 `require('electron')`，kernel 不能直接 import，
 * 由调用方（apps/electron 的 agent-session-manager.ts shim）在启动时注入真实实现。
 */
export interface AgentSessionPathResolver {
  getAgentSessionsIndexPath(): string
  getAgentSessionsDir(): string
  getAgentSessionMessagesPath(id: string): string
  getAgentSessionSkillActivationsPath(id: string): string
  getAgentWorkspacePath(slug: string): string
  getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string
  getSdkConfigDir(): string
}

/** agent-workspace-manager.ts 里被本文件用到的 3 个函数。 */
export interface AgentSessionWorkspaceLookup {
  getAgentWorkspace(id: string): AgentWorkspace | undefined
  getProjectFilesPath(workspaceSlug: string): string
  listAgentWorkspaces(): AgentWorkspace[]
}

/** createAgentSession 里用到的 settings-service.getSettings() 的窄切片。 */
export interface AgentSessionThinkingSettings {
  agentThinking?: ThinkingConfig
  agentEffort?: AgentEffort
  defaultOpenAIThinkingLevel?: AgentThinkingLevel
}

export interface AgentSessionStoreDeps {
  paths: AgentSessionPathResolver
  workspaces: AgentSessionWorkspaceLookup
  getThinkingSettings(): AgentSessionThinkingSettings
}

let storeDeps: AgentSessionStoreDeps | null = null

/** 由调用方（electron shim）在模块加载时调用一次；未调用前使用任何导出函数都会抛错。 */
export function configureAgentSessionStore(deps: AgentSessionStoreDeps): void {
  storeDeps = deps
}

function requireDeps(): AgentSessionStoreDeps {
  if (!storeDeps) {
    throw new Error('[Agent 会话] configureAgentSessionStore 尚未调用')
  }
  return storeDeps
}

/**
 * 会话索引文件格式
 */
interface AgentSessionsIndex {
  /** 配置版本号 */
  version: number
  /** 会话元数据列表 */
  sessions: AgentSessionMeta[]
  /** 是否已将旧版默认关闭的 OpenAI 推理会话升级为默认开启。 */
  openAIThinkingDefaultEnabledMigrationCompleted?: boolean
}

/** 当前索引版本：v2 将 Claude runtime 退役为 Pi-only。 */
const INDEX_VERSION = 2

/**
 * 删除墓碑（收上游 #2074）。删除中的会话 id 在本次应用生命周期内不可复用：
 * 先写墓碑，能让仍在异步预检 / 终止 / 持久化阶段的旧运行安全收束，
 * 而不会在文件已被删除之后又把 JSONL 重新创建出来（用户侧表现为「删掉的会话又冒出来」）。
 */
const deletingAgentSessionIds = new Set<string>()

export function markAgentSessionDeleting(id: string): void {
  deletingAgentSessionIds.add(id)
}

export function isAgentSessionDeleting(id: string): boolean {
  return deletingAgentSessionIds.has(id)
}

/**
 * 会话引用最大返回数。
 *
 * 无搜索词时只返回索引中的轻量元数据，200 条可以显著扩大可选范围，
 * 同时避免极端会话数量下向渲染进程传输过大列表。
 */
const MAX_SESSION_REFERENCE_LIMIT = 200

/** 全局 Agent 会话正文搜索的结果预算。 */
const MAX_SEARCH_SESSIONS = 100
const MAX_SEARCH_HITS_PER_SESSION = 2

/**
 * 会话引用的正文搜索是输入框补全路径，必须有独立 I/O 预算。
 * 标题检索仍覆盖全部会话；仅正文 JSONL 检索优先服务最近会话。
 */
const MAX_SESSION_REFERENCE_BODY_SCANS = 50
const MAX_SESSION_REFERENCE_BODY_BYTES_PER_FILE = 256 * 1024

interface JsonlParseError {
  lineNumber: number
  message: string
}

/**
 * 逐行解析 JSONL，调用方按业务场景决定容错或严格失败。
 */
function parseJsonlLines<T>(lines: string[]): { records: T[]; errors: JsonlParseError[] } {
  const records: T[] = []
  const errors: JsonlParseError[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T)
    } catch (err) {
      errors.push({
        lineNumber: i + 1,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, errors }
}

/**
 * 展示/检索类读取：跳过损坏行，保留其它可读消息。
 */
export function parseJsonlLenient<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  for (const error of errors) {
    console.warn(`[Agent 会话] ${context} — JSONL 第 ${error.lineNumber} 行解析失败，已跳过:`, error.message)
  }
  return records
}

/**
 * 回退/文件恢复类读取：任何损坏行都可能破坏消息顺序或快照完整性，必须停止。
 *
 * 供 packages/runtime-pi 的 fork/rewind 复用（同一道防线）。
 */
export function parseJsonlStrict<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${context} 失败：JSONL 第 ${first.lineNumber} 行解析失败: ${first.message}`)
  }
  return records
}

/** 供 packages/runtime-pi 的 fork/rewind 复用，保证旧格式转换逻辑只有一处。 */
export function normalizePersistedSDKMessage(parsed: unknown): SDKMessage {
  // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
  if (parsed && typeof parsed === 'object' && 'role' in parsed && !('type' in parsed)) {
    return convertLegacyMessage(parsed as AgentMessage)
  }
  return parsed as SDKMessage
}

function migrateLegacyPermissionMode(index: AgentSessionsIndex): boolean {
  let changed = false
  for (const session of index.sessions) {
    const rawMode = session.permissionMode as string | undefined
    if (!rawMode) continue
    const nextMode = migratePermissionMode(rawMode)
    if (nextMode !== rawMode) {
      session.permissionMode = nextMode
      changed = true
    }
  }
  return changed
}

/**
 * 在此版本前，所有新建 OpenAI Agent 会话都会写入 off，无法与用户主动关闭区分。
 * 因此仅执行一次历史升级；之后用户手动关闭会保留 off。
 */
function migrateLegacyOpenAIThinkingDefault(index: AgentSessionsIndex): boolean {
  if (index.openAIThinkingDefaultEnabledMigrationCompleted) return false

  for (const session of index.sessions) {
    if (session.openAIThinkingLevel === 'off') {
      session.openAIThinkingLevel = 'high'
    }
  }
  index.openAIThinkingDefaultEnabledMigrationCompleted = true
  return true
}

/** 会话默认标题（新建 / 标题非法时的兜底） */
export const DEFAULT_AGENT_SESSION_TITLE = '新 Agent 会话'
/** 标题上限，与会话头编辑框 maxLength 一致 */
export const MAX_AGENT_SESSION_TITLE_LENGTH = 100

/**
 * 会话标题消毒：任何进入索引的标题都必须是干净的单行字符串。
 * 侧栏 / 会话头直接把 title 塞进 <span>，标题若是对象会让整棵 React 树炸掉且无错误边界、
 * 重载也白屏直到删会话（踩过）。IPC 入参、自动命名、桥接创建、磁盘旧数据都走这里。
 * - 字符串：去首尾空白、把换行/连续空白压成单个空格、截断到上限；清完为空则用兜底
 * - `{ text: string }`：取 text（与标题模型的内容块形态兼容）
 * - 其余（对象 / 数组 / 数字 / null / undefined）：用兜底
 */
export function normalizeSessionTitle(value: unknown, fallback: string = DEFAULT_AGENT_SESSION_TITLE): string {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { text?: unknown }).text === 'string'
      ? (value as { text: string }).text
      : ''
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_AGENT_SESSION_TITLE_LENGTH).trim()
  return cleaned || fallback
}

/** 磁盘上的旧索引若混入非法标题（对象 / 空串 / 多行），加载时就地修正，避免坏数据一路传到渲染层 */
function migrateInvalidSessionTitles(index: AgentSessionsIndex): boolean {
  let changed = false
  for (const session of index.sessions) {
    const normalized = normalizeSessionTitle((session as { title?: unknown }).title)
    if (session.title !== normalized) {
      session.title = normalized
      changed = true
    }
  }
  return changed
}

/**
 * Claude runtime 已退役。历史 transcript 仍由 Canopy JSONL 展示，但 Claude session
 * artifact 不能交给 Pi SessionManager 恢复，否则会被误识别为 Pi JSONL。
 */
function migrateRetiredClaudeRuntime(index: AgentSessionsIndex): boolean {
  let changed = false
  const treatMissingRuntimeAsLegacy = index.version < INDEX_VERSION
  for (const session of index.sessions) {
    const raw = session as AgentSessionMeta & { agentRuntime?: unknown }
    const runtime = raw.agentRuntime

    // Pi records written by the previous dual-runtime version keep their artifact.
    if (runtime === 'pi') {
      delete raw.agentRuntime
      changed = true
      continue
    }
    if (session.legacyTranscript?.sourceRuntime === 'claude') continue
    // New Pi-only records intentionally have no runtime field. Only pre-v2 absence means
    // legacy Claude, whose artifacts are not interoperable with Pi.
    if (runtime === undefined && !treatMissingRuntimeAsLegacy) continue

    session.legacyTranscript = { sourceRuntime: 'claude', continuationRequired: true }
    delete raw.agentRuntime
    session.sdkSessionId = undefined
    session.piSessionFile = undefined
    session.piEntryBindings = undefined
    delete (raw as { forkSourceSdkSessionId?: unknown }).forkSourceSdkSessionId
    delete (raw as { resumeAtMessageUuid?: unknown }).resumeAtMessageUuid
    changed = true
  }
  return changed
}

/**
 * 会话索引的进程内缓存（0.17.24，审查报告 P-1 / P-3）。
 *
 * 此前每次 readIndex() 都是「全量读文件 + JSON.parse + 三趟迁移扫描」，而每轮对话至少调两次
 * （getAgentSessionMeta + updateAgentSessionMeta），索引随 piEntryBindings 只增不减——重度使用后
 * 每轮约 15ms 的同步阻塞全花在重复解析同一份文件上。
 *
 * 做法：按文件签名（size + mtimeMs）判新鲜——签名没变就复用上次解析结果；我们自己 writeIndex 后
 * 立刻用新文件签名刷新缓存；外部改写（人工编辑、readJsonFileSafe 的 .tmp/.bak 恢复、测试直接写文件）
 * 会让签名变化而自然失效。迁移只在真正加载时跑，不再每次都扫。
 *
 * **不做延迟落盘**：写仍是同步写透（每次 updateAgentSessionMeta 都立刻落盘），因为进程被杀时
 * 丢掉最后一轮的 piEntryBindings / 标题 / 归档态是真实代价，而省掉的两次全量读已经拿到大头。
 *
 * 契约：readIndex() 返回的是缓存对象本身，**只供本模块内部使用**——内部调用方要么只读，要么改完
 * 立刻 writeIndex()。对外的 getAgentSessionMeta / listAgentSessions 一律返回副本，外部拿到后
 * 怎么改都不会污染缓存（想改元数据请走 updateAgentSessionMeta）。
 */
let indexCache: { path: string; signature: string; data: AgentSessionsIndex } | null = null

function indexFileSignature(indexPath: string): string {
  try {
    const st = statSync(indexPath)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/** 仅供测试观测缓存命中；生产代码不要用。 */
export function __getAgentSessionIndexCacheStateForTest(): { loaded: boolean; signature: string | null } {
  return { loaded: indexCache !== null, signature: indexCache?.signature ?? null }
}

/**
 * 读取会话索引（带缓存；返回缓存对象本身，见上方契约）
 */
function readIndex(): AgentSessionsIndex {
  const indexPath = requireDeps().paths.getAgentSessionsIndexPath()
  const signature = indexFileSignature(indexPath)
  if (indexCache && indexCache.path === indexPath && indexCache.signature === signature) {
    return indexCache.data
  }

  const data = readJsonFileSafe<AgentSessionsIndex>(indexPath)
  if (data) {
    const permissionModeMigrated = migrateLegacyPermissionMode(data)
    const thinkingDefaultMigrated = migrateLegacyOpenAIThinkingDefault(data)
    const retiredClaudeRuntimeMigrated = migrateRetiredClaudeRuntime(data)
    const invalidTitlesMigrated = migrateInvalidSessionTitles(data)
    if (permissionModeMigrated || thinkingDefaultMigrated || retiredClaudeRuntimeMigrated || invalidTitlesMigrated || data.version < INDEX_VERSION) {
      data.version = INDEX_VERSION
      writeIndex(data) // 落盘并刷新缓存签名
      if (permissionModeMigrated) {
        console.log('[Agent 会话] 已迁移历史权限模式 auto → bypassPermissions')
      }
      if (thinkingDefaultMigrated) {
        console.log('[Agent 会话] 已将历史 OpenAI 会话的思考深度默认值升级为高')
      }
      if (retiredClaudeRuntimeMigrated) {
        console.log('[Agent 会话] 已将历史 Claude 会话迁移为 Pi transcript-only 会话')
      }
      if (invalidTitlesMigrated) {
        console.warn('[Agent 会话] 已修正索引中的非法会话标题')
      }
      return data
    }
    // readJsonFileSafe 可能刚从 .tmp/.bak 恢复并重写了主文件，签名要在读之后取
    indexCache = { path: indexPath, signature: indexFileSignature(indexPath), data }
    return data
  }

  const empty: AgentSessionsIndex = {
    version: INDEX_VERSION,
    sessions: [],
    openAIThinkingDefaultEnabledMigrationCompleted: true,
  }
  indexCache = { path: indexPath, signature: indexFileSignature(indexPath), data: empty }
  return empty
}

/**
 * 写入会话索引文件（同步写透，随后用新文件签名刷新缓存）
 */
function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = requireDeps().paths.getAgentSessionsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 会话] 写入索引文件失败:', error)
    throw new Error('写入 Agent 会话索引失败')
  }
  indexCache = { path: indexPath, signature: indexFileSignature(indexPath), data: index }
}

/** 对外返回元数据副本：调用方随意改动都不会漏进缓存（改元数据请走 updateAgentSessionMeta）。 */
function cloneMeta(meta: AgentSessionMeta): AgentSessionMeta {
  return structuredClone(meta)
}

export type AgentSessionListScope = 'active' | 'archived' | 'all'

/**
 * 获取会话（按 updatedAt 降序，返回副本）。主进程内部默认 all；renderer 应显式请求 active，
 * 归档列表仅在用户打开归档视图时按需读取。
 */
export function listAgentSessions(scope: AgentSessionListScope = 'all'): AgentSessionMeta[] {
  const index = readIndex()
  return index.sessions
    .filter((session) => scope === 'all' || (scope === 'archived' ? !!session.archived : !session.archived))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(cloneMeta)
}

/** 获取未归档会话，供侧栏 active 视图按需读取（上游 #1713 的 API 名，复用我方 scope 实现，返回副本）。 */
export function listActiveAgentSessions(): AgentSessionMeta[] {
  return listAgentSessions('active')
}

/** 获取归档会话，只有用户进入归档视图时才调用。 */
export function listArchivedAgentSessions(): AgentSessionMeta[] {
  // #1907 起排除草稿会话（isDraft）：草稿只出现在 active 视图，归档列表与计数同口径。
  return listAgentSessions('archived').filter((session) => !session.isDraft)
}

/** 活跃 / 归档会话计数（我方 API，主进程内部与测试使用；renderer 侧栏用上游的 countArchivedAgentSessions）。 */
export function getAgentSessionCounts(): { active: number; archived: number } {
  return readIndex().sessions.reduce(
    (counts, session) => {
      if (session.archived) counts.archived++
      else counts.active++
      return counts
    },
    { active: 0, archived: 0 },
  )
}

/** 获取归档数量，不把归档会话元数据传到 renderer（#1907 起排除草稿会话，与归档列表口径一致）。 */
export function countArchivedAgentSessions(): number {
  const index = readIndex()
  return index.sessions.reduce((count, session) => count + (session.archived && !session.isDraft ? 1 : 0), 0)
}

/**
 * 获取单个会话的元数据
 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  const index = readIndex()
  const meta = index.sessions.find((s) => s.id === id)
  return meta ? cloneMeta(meta) : undefined
}

/** 缺少标记的存量会话必须保持升级前的私有 workbench cwd。 */
export function getAgentCwdMode(meta?: Pick<AgentSessionMeta, 'agentCwdMode'>): AgentCwdMode {
  return meta?.agentCwdMode ?? 'session'
}

/** 只接受仍存在的绝对目录；Git 归属校验由调用主进程在启动 Agent 前完成。 */
export function getActiveWorktreePath(
  meta?: Pick<AgentSessionMeta, 'activeWorktree'>,
): string | undefined {
  const activeWorktree = meta?.activeWorktree
  if (!activeWorktree?.path || !isAbsolute(activeWorktree.path)) return undefined
  try {
    return statSync(activeWorktree.path).isDirectory() ? activeWorktree.path : undefined
  } catch {
    return undefined
  }
}

/** 缺少标记的历史会话继续使用 `.context/`，避免失效的计划和工具历史路径。 */
export function getSessionWorkbenchLayout(
  meta?: Pick<AgentSessionMeta, 'sessionWorkbenchLayout'>,
): SessionWorkbenchLayout {
  return meta?.sessionWorkbenchLayout ?? 'legacy-context'
}

/**
 * 会话私有资料目录；新布局直接使用 workbench 根，旧布局保留 `.context/`。
 *
 * 底层 `getAgentSessionWorkspacePath` 带 mkdir 副作用（曾因此把本函数当死导出删掉）。
 * 现由编排层在每轮 run 启动时调用一次、用来钉住计划模式的 plan/ 目录——同一轮里
 * `collectAttachedDirectories` 本就会创建该会话目录，这里不额外增加高频只读路径的副作用；
 * 构建 system prompt 的 agent-prompt-builder 仍用自己的无副作用内联计算，两者路径公式一致。
 */
export function resolveSessionWorkbenchContextDir(
  workspace: Pick<AgentWorkspace, 'slug'> | undefined,
  sessionId: string,
  layout?: SessionWorkbenchLayout,
): string | undefined {
  if (!workspace) return undefined
  const sessionDir = requireDeps().paths.getAgentSessionWorkspacePath(workspace.slug, sessionId)
  return layout === 'root' ? sessionDir : join(sessionDir, '.context')
}

/** Agent 运行 cwd 与 Canopy 会话 sidecar 工作台目录解析。 */
export function resolveAgentCwd(
  workspace: Pick<AgentWorkspace, 'slug'> | undefined,
  sessionId: string,
  agentCwdMode?: AgentCwdMode,
  activeWorktree?: AgentActiveWorktree,
): string | undefined {
  if (!workspace) return undefined
  const activeWorktreePath = getActiveWorktreePath({ activeWorktree })
  if (activeWorktreePath) return activeWorktreePath
  return getAgentCwdMode({ agentCwdMode }) === 'project'
    ? requireDeps().workspaces.getProjectFilesPath(workspace.slug)
    : requireDeps().paths.getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

export function resolveAgentWorkbenchDir(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'> | undefined,
  sessionId: string,
): string | undefined {
  if (!workspace) return undefined
  return requireDeps().paths.getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
  agentCwdMode?: AgentCwdMode,
  sessionWorkbenchLayout?: SessionWorkbenchLayout,
  isDraft?: boolean,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  const settings = requireDeps().getThinkingSettings()
  const defaultThinkingLevel = settings.defaultOpenAIThinkingLevel
    ?? resolvePiThinkingLevel(settings, undefined, 'openai-codex')
  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: normalizeSessionTitle(title),
    channelId,
    modelId,
    workspaceId,
    agentCwdMode: workspaceId ? agentCwdMode ?? 'project' : undefined,
    sessionWorkbenchLayout: workspaceId ? sessionWorkbenchLayout ?? 'root' : undefined,
    // 仅由会话入口显式创建的临时输入会话设置；必须跨重启保留。
    isDraft: isDraft || undefined,
    // 新会话继承已持久化的全局思考偏好，之后仍可按会话单独调整。
    reasoningLevel: defaultThinkingLevel,
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  requireDeps().paths.getAgentSessionsDir()

  // 若有工作区，创建 session 级别子文件夹和 Canopy 工作台目录。
  if (workspaceId) {
    const ws = requireDeps().workspaces.getAgentWorkspace(workspaceId)
    if (ws) {
      // sessionDir 已由 getAgentSessionWorkspacePath 创建。新会话将私有资料直接
      // 放在 workbench 根；计划和附件目录按需创建，避免每个会话都有空 `.context/`。
      requireDeps().paths.getAgentSessionWorkspacePath(ws.slug, meta.id)
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return cloneMeta(meta)
}

/**
 * 会话正文（JSONL）的绝对路径。
 *
 * 给同包内需要自己逐行扫正文的模块用（用量统计要按行字符串预筛，走
 * getAgentSessionSDKMessages 会把每行都 JSON.parse 一遍，白花几倍时间）。
 * 只暴露这一个路径，不把整个注入的 deps 放出去。
 */
export function getAgentSessionMessagesFilePath(id: string): string {
  return requireDeps().paths.getAgentSessionMessagesPath(id)
}

/**
 * 读取会话的所有消息
 */
export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<AgentMessage>(lines, `读取会话消息 (${id})`)
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 追加一条消息到会话的 JSONL 文件
 */
export function appendAgentMessage(id: string, message: AgentMessage): void {
  // 已停止 / 已删除的 runtime 迟到的输出，绝不能把它的 JSONL 重新创建出来
  if (isAgentSessionDeleting(id) || !getAgentSessionMeta(id)) return

  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)

  try {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.sessions.findIndex((s) => s.id === id)
    if (idx !== -1) {
      const session = index.sessions[idx]!
      session.updatedAt = Date.now()
      if (session.archived) session.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error)
    throw new Error('追加 Agent 消息失败')
  }
}

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 追加 SDKMessage 到会话的 JSONL 文件（Phase 4 新持久化格式）
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return

  // appendFileSync 会把缺失的文件创建出来：DELETE_SESSION 删掉元数据与文件之后，
  // 迟到的 runtime 输出绝不能借此把 transcript 重新变出来
  if (isAgentSessionDeleting(id) || !getAgentSessionMeta(id)) return

  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)

  try {
    // 整批只做一次同步追写：逐条 appendFileSync 会为每条消息各做一次 open/write/close，
    // 一轮输出常见几十条消息，在多 Agent 并发下会持续阶段性阻塞主进程，
    // 进而延迟键盘事件的 IPC 转发（表现为 renderer 内无长任务但输入延迟高）。
    let payload = ''
    for (const message of messages) {
      payload += serializeSDKMessageForStorage(message) + '\n'
    }
    appendFileSync(filePath, payload, 'utf-8')
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 * 处理三类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`
  const truncationThreshold = MAX_SDK_MESSAGE_LENGTH / 2

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = JSON.parse(JSON.stringify(msg))
  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        // 剥离 base64 图片数据：兼容 Anthropic 形态（source.data）与 Pi / 内置工具形态（data + mimeType，
        // BrowserScreenshot / PsdInspect / PsdCompose 的结果都是后者，一张预览图 300KB 起）
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            if (item?.type !== 'image') return item
            const sourceData = (item.source as Record<string, unknown> | undefined)?.data
            const inlineData = typeof item.data === 'string' ? item.data : undefined
            if (sourceData) {
              return { type: 'image', _truncated: true, _originalLength: String(sourceData).length }
            }
            if (inlineData) {
              return { type: 'image', _truncated: true, _originalLength: inlineData.length, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}) }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 将一段字符串中所有出现的 sourceDir 替换为 destDir。
 *
 * 用于 fork 会话时把历史中嵌入的源会话绝对路径迁移到新会话目录。
 * 处理 JSON 字符串中可能出现的两种编码形式：
 * 1. 原始路径（如 /Users/a/b）
 * 2. JSON 字符串编码后的形式（路径中的 `/` JSON 标准下不会转义，所以通常与 1 一致；
 *    但保留对反斜杠的处理以兼容 Windows 路径）
 *
 * sourceDir 和 destDir 都会规范化去除末尾斜杠，避免不同形式导致漏替换。
 */
function rewriteSourceToDest(content: string, sourceDir: string, destDir: string): string {
  const normalizedSource = sourceDir.replace(/[\\/]+$/, '')
  const normalizedDest = destDir.replace(/[\\/]+$/, '')
  if (!normalizedSource || normalizedSource === normalizedDest) return content
  let rewritten = content.split(normalizedSource).join(normalizedDest)
  // Windows 路径在 JSON 中会被转义为双反斜杠，单独处理一次
  if (normalizedSource.includes('\\')) {
    const sourceEscaped = normalizedSource.replace(/\\/g, '\\\\')
    const destEscaped = normalizedDest.replace(/\\/g, '\\\\')
    rewritten = rewritten.split(sourceEscaped).join(destEscaped)
  }
  return rewritten
}

/**
 * 序列化单条 SDKMessage 供落盘；超限时自动截断。
 *
 * 供 packages/runtime-pi 的 fork 复制历史消息时复用（sourceDir/destDir 用于路径重写）。
 */
export function serializeSDKMessageForStorage(
  msg: SDKMessage,
  sourceDir?: string,
  destDir?: string,
): string {
  let serialized = JSON.stringify(msg)
  if (sourceDir && destDir) {
    serialized = rewriteSourceToDest(serialized, sourceDir, destDir)
  }
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized

  let sanitized = JSON.stringify(sanitizeOversizedMessage(msg, serialized.length))
  if (sourceDir && destDir) {
    sanitized = rewriteSourceToDest(sanitized, sourceDir, destDir)
  }
  if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
    console.warn(`[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars)`)
  }
  return sanitized
}

/**
 * 读取会话的所有 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 */
export function getAgentSessionSDKMessages(id: string): SDKMessage[] {
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    const messages = parseJsonlLenient<unknown>(lines, `读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
    return applySkillActivationSidecar(messages, readSkillActivationSidecar(requireDeps().paths.getAgentSessionSkillActivationsPath(id)))
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 失败 (${id}):`, error)
    return []
  }
}

interface UsageTokens {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 与渲染层一致的"已用上下文 token"口径：base input + 两类 cache token。
 */
function sumUsedTokens(usage: UsageTokens): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * 从 SDK result.modelUsage 多 entry 中选择代表性的 contextWindow。
 *
 * SDK 0.3.142+ Task 工具默认启用后，单次 result 可能包含多个模型（主对话 + 子 agent），
 * modelUsage 会有多个 entry。result.usage 是聚合值，其中大头通常属于主模型，
 * 所以用**最大** contextWindow 作为分母最接近"主模型视角的占用率"——这样：
 *   - 单 entry（常态）：行为与从前一致
 *   - 多 entry：避免被子 agent 的小窗口拉低、过早误触发 daily 切换阈值
 *
 * 每个 entry 优先用 SDK 实测的 contextWindow，缺失时按本次 Agent provider 的运行窗口推断。
 */
function pickResultContextWindow(result: SDKResultMessage): number | undefined {
  if (!result.modelUsage) return undefined
  let best: number | undefined
  for (const [modelId, info] of Object.entries(result.modelUsage)) {
    const fallbackModelId = result._channelModelId ?? modelId
    const fallbackWindow = inferContextWindow(fallbackModelId)
    const win = Math.max(info?.contextWindow ?? 0, fallbackWindow ?? 0) || undefined
    if (win === undefined) continue
    if (best === undefined || win > best) best = win
  }
  return best
}

/**
 * 读取一个 Agent session 当前的上下文占用率。
 *
 * 用途：业务层（如自动化调度）在决定是否要切到新会话时参考——
 * 同一自然日内即便上次运行成功，如果上下文已经接近窗口上限，
 * 继续往里塞会导致本次运行刚开始就触发 SDK 自动压缩，得不偿失。
 *
 * 数据来源：会话 JSONL 里最后一条带 usage 的消息。优先级：
 * 1. SDK result 消息（subtype=success/error_*）：usage + modelUsage[?].contextWindow
 * 2. SDK assistant 消息：message.usage + 按 message.model 推断 contextWindow
 * 3. 都拿不到：返回 undefined（占用率未知），调用方按"保守复用"处理
 *
 * 性能：从文件尾部反向逐行惰性解析，命中第一条带 usage 的消息即返回，
 * 避免对整份会话 JSONL 全量 JSON.parse。
 */
export function getSessionContextUsageRatio(sessionId: string): number | undefined {
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  let lines: string[]
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n')
  } catch {
    return undefined
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const msg = parsed as { type?: string }

    if (msg.type === 'result') {
      const result = parsed as SDKResultMessage
      if (!result.usage) continue
      const usedTokens = sumUsedTokens(result.usage)
      const contextWindow = pickResultContextWindow(result)
      return calculateContextUsageRatio(usedTokens, contextWindow)
    }

    if (msg.type === 'assistant') {
      const asst = parsed as SDKAssistantMessage
      const usage = asst.message?.usage
      if (!usage) continue
      const usedTokens = sumUsedTokens(usage)
      const modelId = asst._channelModelId ?? asst.message?.model
      const contextWindow = inferContextWindow(modelId)
      return calculateContextUsageRatio(usedTokens, contextWindow)
    }
  }

  return undefined
}

/** 渲染器首次展示的历史消息上限；更早历史由用户按需向前加载。 */
const AGENT_SESSION_MESSAGE_PAGE_SIZE = 400
const AGENT_SESSION_MESSAGE_PAGE_MAX_SIZE = 500
const AGENT_SESSION_MESSAGE_READ_CHUNK_SIZE = 64 * 1024

export interface AgentSessionSDKMessagesPage {
  messages: SDKMessage[]
  /** 下一页的文件字节上界；缺失表示已经到达文件开头。 */
  nextBefore?: number
}

interface JsonlTailLine {
  line: string
  start: number
}

/**
 * 从 JSONL 尾部按行读取，避免打开长会话时把整份 transcript 读入主进程和 IPC。
 *
 * 返回的行按文件原始顺序排列；`nextBefore` 可直接作为下一次请求的 before。
 */
function readJsonlTailLines(filePath: string, before: number | undefined, limit: number): {
  lines: JsonlTailLine[]
  hasMore: boolean
} {
  const fileSize = statSync(filePath).size
  let position = Math.min(Math.max(before ?? fileSize, 0), fileSize)
  let trailing = Buffer.alloc(0)
  const newestFirst: JsonlTailLine[] = []
  const fileDescriptor = openSync(filePath, 'r')

  try {
    while (position > 0 && newestFirst.length <= limit) {
      const chunkSize = Math.min(AGENT_SESSION_MESSAGE_READ_CHUNK_SIZE, position)
      position -= chunkSize
      const chunk = Buffer.allocUnsafe(chunkSize)
      readSync(fileDescriptor, chunk, 0, chunkSize, position)

      const combined = Buffer.concat([chunk, trailing])
      let lineEnd = combined.length
      for (let index = combined.length - 1; index >= 0 && newestFirst.length <= limit; index--) {
        if (combined[index] !== 0x0a) continue
        const lineBuffer = combined.subarray(index + 1, lineEnd)
        if (lineBuffer.toString('utf-8').trim()) {
          newestFirst.push({
            line: lineBuffer.toString('utf-8'),
            start: position + index + 1,
          })
        }
        lineEnd = index
      }
      trailing = combined.subarray(0, lineEnd)
    }

    if (newestFirst.length <= limit && position === 0 && trailing.toString('utf-8').trim()) {
      newestFirst.push({ line: trailing.toString('utf-8'), start: 0 })
    }
  } finally {
    closeSync(fileDescriptor)
  }

  const pageNewestFirst = newestFirst.slice(0, limit)
  return {
    lines: pageNewestFirst.reverse(),
    hasMore: newestFirst.length > limit,
  }
}

/**
 * 分页读取会话历史。默认只读取最后 400 条 JSONL 记录，避免长会话阻塞主进程与 renderer。
 */
export function getAgentSessionSDKMessagesPage(
  id: string,
  input: { before?: number; limit?: number } = {},
): AgentSessionSDKMessagesPage {
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) return { messages: [] }

  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? AGENT_SESSION_MESSAGE_PAGE_SIZE), 1),
    AGENT_SESSION_MESSAGE_PAGE_MAX_SIZE,
  )

  try {
    const { lines, hasMore } = readJsonlTailLines(filePath, input.before, limit)
    const messages = applySkillActivationSidecar(
      parseJsonlLenient<unknown>(
        lines.map((item) => item.line),
        `分页读取 SDKMessage (${id})`,
      ).map(normalizePersistedSDKMessage),
      readSkillActivationSidecar(requireDeps().paths.getAgentSessionSkillActivationsPath(id)),
    )
    const earliestLine = lines[0]
    return {
      messages,
      nextBefore: hasMore && earliestLine ? earliestLine.start : undefined,
    }
  } catch (error) {
    console.error(`[Agent 会话] 分页读取 SDKMessage 失败 (${id}):`, error)
    return { messages: [] }
  }
}

/**
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'channelId' | 'modelId' | 'sdkSessionId' | 'piSessionFile' | 'piEntryBindings' | 'codexFastMode' | 'reasoningLevel' | 'openAIThinkingLevel' | 'workspaceId' | 'activeWorktree' | 'pinned' | 'starred' | 'archived' | 'isDraft' | 'attachedDirectories' | 'attachedFiles' | 'forkSourceDir' | 'explorationParentSessionId' | 'explorationSourceMessageId' | 'explorationSourceLabel' | 'explorationTitleInitializedAt' | 'stoppedByUser' | 'permissionMode' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'automationGraduated' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'delegationRole' | 'delegationStatus' | 'delegationDepth' | 'delegationGoal'>>,
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  if ('title' in updates) {
    // 标题来自 IPC / 自动命名 / 桥接，一律消毒；非法时保留原标题而不是写入 undefined
    updates = { ...updates, title: normalizeSessionTitle(updates.title, existing.title) }
  }
  const updateKeys = Object.keys(updates)
  // 星标只是侧栏的视觉标记，不应改变会话的新鲜度或归档状态。
  const isStarredOnly = updateKeys.every((key) => key === 'starred')
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 或 starred 不触发解归档）
  const isStoppedByUserOnly = updateKeys.every((key) => key === 'stoppedByUser')
  const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly && !isStarredOnly
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: isStarredOnly ? existing.updatedAt : Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return cloneMeta(updated)
}

/**
 * 删除会话（核心部分：索引 + 消息文件 + session 工作目录）。
 *
 * 不含 Nano Banana 生图历史清理——那是业务侧副作用，由 electron 侧
 * `deleteAgentSession` 包一层调用 `clearNanoBananaAgentHistory` 完成。
 */
export function deleteAgentSessionCore(id: string): void {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    console.warn(`[Agent 会话] 会话不存在，跳过删除: ${id}`)
    return
  }

  const removed = index.sessions.splice(idx, 1)[0]!
  writeIndex(index)

  // 删除消息文件——连同原子写留下的 .bak / .tmp、Skill 激活 sidecar 一起删，用户删会话就是要它彻底消失
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)
  try {
    removeFileWithCompanions(filePath)
    removeSkillActivationSidecar(requireDeps().paths.getAgentSessionSkillActivationsPath(id))
  } catch (error) {
    console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error)
  }

  // 清理 session 工作目录
  if (removed.workspaceId) {
    const ws = requireDeps().workspaces.getAgentWorkspace(removed.workspaceId)
    if (ws) {
      try {
        const sessionDir = requireDeps().paths.getAgentSessionWorkspacePath(ws.slug, id)
        if (existsSync(sessionDir)) {
          rmSyncWithRetry(sessionDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`)
        }
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error)
      }
    }
  }

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)
}

/**
 * 收集会话及其全部委派子会话。
 */
function collectSessionTreeIds(sessions: AgentSessionMeta[], sessionId: string): Set<string> {
  const ids = new Set<string>([sessionId])
  let changed = true

  while (changed) {
    changed = false
    for (const session of sessions) {
      if (ids.has(session.id)) continue
      // 仅收集协作委派子会话。parent/root 负责维护树结构，sourceDelegationId 负责限定来源。
      if (!session.sourceDelegationId) continue
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        ids.add(session.id)
        changed = true
        continue
      }
      if (session.rootSessionId === sessionId) {
        ids.add(session.id)
        changed = true
      }
    }
  }

  return ids
}

function moveSessionWorkspaceDir(session: AgentSessionMeta, targetWorkspaceSlug: string): void {
  if (!session.workspaceId) return

  const sourceWs = requireDeps().workspaces.getAgentWorkspace(session.workspaceId)
  if (!sourceWs || sourceWs.slug === targetWorkspaceSlug) return

  const srcDir = join(requireDeps().paths.getAgentWorkspacePath(sourceWs.slug), session.id)
  if (!existsSync(srcDir)) return

  const destDir = join(requireDeps().paths.getAgentWorkspacePath(targetWorkspaceSlug), session.id)
  // 清理已存在的目标目录，防止 renameSync 抛出 ENOTEMPTY/EEXIST。
  if (existsSync(destDir)) {
    try {
      const contents = readdirSync(destDir)
      rmSyncWithRetry(destDir, { recursive: true, force: true })
      const reason = contents.length === 0 ? '空目标目录' : '非空目标目录（以源目录为准）'
      console.log(`[Agent 会话] 已清理${reason}: ${destDir}`)
    } catch (cleanupError) {
      console.warn('[Agent 会话] 清理目标目录失败，跳过目录迁移:', cleanupError)
      throw cleanupError
    }
  }

  // renameWithRetry：优先 renameSync（原子），跨设备或句柄占用时自动降级 cpSync + rmSyncWithRetry。
  renameWithRetry(srcDir, destDir)
  console.log(`[Agent 会话] 已移动工作目录: ${srcDir} → ${destDir}`)
}

/**
 * 迁移 Agent 会话到另一个工作区
 *
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 收集目标会话及其委派子会话
 * 3. 移动会话工作目录到目标工作区
 * 4. 更新元数据，并清空与旧 cwd 绑定的 Pi artifact / entry bindings
 * 5. JSONL 消息文件保持原位（全局目录）
 */
export function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  const session = index.sessions[idx]!

  const targetWs = requireDeps().workspaces.getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标项目不存在: ${targetWorkspaceId}`)
  }

  const sessionTreeIds = collectSessionTreeIds(index.sessions, sessionId)
  const sessionsToMove = index.sessions.filter((item) => sessionTreeIds.has(item.id) && item.workspaceId !== targetWorkspaceId)
  if (sessionsToMove.length === 0) return cloneMeta(session)

  const now = Date.now()
  let updatedRoot = session
  let movedCount = 0

  for (let i = 0; i < index.sessions.length; i++) {
    const current = index.sessions[i]!
    if (!sessionTreeIds.has(current.id) || current.workspaceId === targetWorkspaceId) continue

    moveSessionWorkspaceDir(current, targetWs.slug)
    // 确保目标工作区下有 session 目录。
    requireDeps().paths.getAgentSessionWorkspacePath(targetWs.slug, current.id)

    const updated: AgentSessionMeta = {
      ...current,
      workspaceId: targetWorkspaceId,
      // Pi artifact 与 entry bindings 都以原 cwd 为根；跨工作区复用会造成错误 resume/fork/rewind。
      sdkSessionId: undefined,
      piSessionFile: undefined,
      piEntryBindings: undefined,
      // 已切换到另一项目，不能沿用旧项目授权下选择的 worktree。
      activeWorktree: undefined,
      updatedAt: now,
    }
    index.sessions[i] = updated
    writeIndex(index)
    movedCount++
    if (current.id === sessionId) {
      updatedRoot = updated
    }
  }

  console.log(`[Agent 会话] 已迁移会话及子会话到工作区: ${updatedRoot.title}（${movedCount} 个）→ ${targetWs.name}`)
  return cloneMeta(updatedRoot)
}

/**
 * 删除指定 UUID 的持久化错误消息。
 *
 * 仅删除 assistant error，避免调用方误删普通回复；找不到时保持幂等。
 */
export function removeSDKErrorMessage(id: string, errorUuid: string): boolean {
  const filePath = requireDeps().paths.getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) return false

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `删除错误消息 (${id})`).map(normalizePersistedSDKMessage)
  const targetIndex = messages.findIndex((message) =>
    message.type === 'assistant'
      && (message as { uuid?: string }).uuid === errorUuid
      && Boolean((message as { error?: unknown }).error),
  )
  if (targetIndex < 0) return false

  const kept = messages.filter((_, index) => index !== targetIndex)
  const content = kept.map((message) => JSON.stringify(message)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeTextFileAtomic(filePath, content)
  console.log(`[Agent 会话] 已删除重试前错误: sessionId=${id}, uuid=${errorUuid}`)
  return true
}

/**
 * 记录 Pi 实际消费的那条 user 消息触发了哪些 Skill。
 *
 * 0.17.24 起写入 sidecar（`{id}.skill-activations.json`），不再为改一个字段全量重写会话 JSONL
 * （审查报告 N-1：每次 Skill 激活 4~8ms 同步阻塞、且写入窗口内无备份）。读取路径会把 sidecar
 * 合并回对应 user 消息；旧会话内联的 `skill_activations` 继续有效。
 *
 * 不再要求目标 user 消息已经落盘（Pi 队列可能让 user 消息晚于激活事件持久化）：sidecar 按 uuid
 * 索引，消息出现时自然合并——因此除空输入外总是返回 true，编排层的「待落盘再补写」兜底成为空转。
 */
export function updateSDKUserMessageSkillActivations(
  id: string,
  userMessageUuid: string,
  activations: SkillActivation[],
): boolean {
  if (activations.length === 0) return false
  upsertSkillActivations(requireDeps().paths.getAgentSessionSkillActivationsPath(id), userMessageUuid, activations)
  return true
}

/**
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 置顶会话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const session of index.sessions) {
    // 草稿没有侧栏入口；自动归档后无法由 Welcome 恢复，会变成不可达记录。
    if (!session.isDraft && !session.pinned && !session.archived && session.updatedAt < threshold) {
      session.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天）`)
  }

  return count
}

/**
 * 启动时收敛遗留的委派子会话状态
 *
 * 委派子会话的运行态只在主进程内存中维护，应用退出后无法续跑。
 * 若上次退出时仍有 delegationStatus 为 'running' 的子会话，本次启动需要
 * 把它们标记为 'interrupted'，避免状态永久卡在 running、父会话也无法收敛。
 *
 * @returns 被标记为中断的子会话数量
 */
export function markRunningDelegationsAsInterrupted(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    if (session.sourceDelegationId && session.delegationStatus === 'running') {
      session.delegationStatus = 'interrupted'
      session.updatedAt = Date.now()
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 启动收敛 ${count} 个遗留的运行中委派子会话为 interrupted`)
  }

  return count
}

/**
 * 搜索 Agent 会话正文。
 * 每个会话最多返回 2 个用户/助手正文命中，最多返回 100 个命中会话。
 */
export async function searchAgentSessionMessages(query: string): Promise<AgentMessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: AgentMessageSearchResult[] = []
  let matchedSessionCount = 0

  const sortedSessions = [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of sortedSessions) {
    if (matchedSessionCount >= MAX_SEARCH_SESSIONS) break

    const filePath = requireDeps().paths.getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hits = await findMatchesInAgentJsonl(filePath, query)
    if (hits.length === 0) continue
    matchedSessionCount++

    for (const hit of hits.slice(0, MAX_SEARCH_HITS_PER_SESSION)) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
        snippet: hit.snippet,
        matchStart: hit.matchStart,
        matchLength: hit.matchLength,
        archived: session.archived,
      })
    }
  }

  return results
}

interface AgentSearchHit {
  messageId: string
  role: Extract<AgentMessageSearchResult['role'], 'user' | 'assistant'>
  snippet: string
  matchStart: number
  matchLength: number
  score: number
}

/** 在单个 Agent JSONL 中收集用户文本和助手 text block 的命中。 */
async function findMatchesInAgentJsonl(
  filePath: string,
  query: string,
): Promise<AgentSearchHit[]> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const hitsByMessageId = new Map<string, AgentSearchHit>()
  const anonymousHits: AgentSearchHit[] = []

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        type?: string
        message?: {
          role?: string
          id?: string
          content?: Array<{ type: string; text?: string }>
        }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      let role: AgentSearchHit['role'] | null = null
      let messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''
      let textContent = ''

      // 兼容旧 AgentMessage：只接受 user/assistant 的顶层 content。
      if (!parsed.type && typeof parsed.content === 'string') {
        if (parsed.role !== 'user' && parsed.role !== 'assistant') continue
        role = parsed.role
        textContent = parsed.content
      } else if (parsed.type === 'user' || parsed.type === 'assistant') {
        role = parsed.type
        if (Array.isArray(parsed.message?.content)) {
          textContent = parsed.message.content
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text!)
            .join('\n')
        }
      }

      if (!role || !textContent) continue
      const match = findBestSearchMatch(textContent, query)
      if (!match) continue

      const snippetStart = Math.max(0, match.matchStart - 40)
      const snippetEnd = Math.min(textContent.length, match.matchStart + match.matchLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = match.matchStart - snippetStart + (snippetStart > 0 ? 3 : 0)
      const hit = { messageId, role, snippet, matchStart, matchLength: match.matchLength, score: match.score }
      if (messageId) {
        const existingHit = hitsByMessageId.get(messageId)
        if (!existingHit) {
          hitsByMessageId.set(messageId, hit)
        } else {
          const bestHit = [existingHit]
          insertTopSearchResult(bestHit, hit, 1)
          hitsByMessageId.set(messageId, bestHit[0]!)
        }
      } else {
        insertTopSearchResult(anonymousHits, hit, MAX_SEARCH_HITS_PER_SESSION)
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  const hits: AgentSearchHit[] = []
  for (const hit of hitsByMessageId.values()) {
    insertTopSearchResult(hits, hit, MAX_SEARCH_HITS_PER_SESSION)
  }
  for (const hit of anonymousHits) {
    insertTopSearchResult(hits, hit, MAX_SEARCH_HITS_PER_SESSION)
  }
  return hits
}

/**
 * 在单个 Agent 会话 JSONL 中按行流式查找第一条匹配。
 *
 * Agent 消息存在两种历史格式（旧 AgentMessage 与新 SDKMessage），都要兼容。
 */
async function findFirstMatchInAgentJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number,
  maxBytes?: number,
): Promise<{ messageId: string; role: AgentMessageSearchResult['role']; snippet: string; matchStart: number } | null> {
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    ...(maxBytes ? { end: maxBytes - 1 } : {}),
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
      // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
      const role: AgentMessageSearchResult['role'] =
        rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
          ? rawRole
          : 'assistant'
      const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

      let textContent = ''
      if (typeof parsed.content === 'string') {
        textContent = parsed.content
      } else if (Array.isArray(parsed.message?.content)) {
        textContent = parsed.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n')
      }
      if (!textContent) continue

      const contentLower = textContent.toLowerCase()
      const matchIndex = contentLower.indexOf(queryLower)
      if (matchIndex === -1) continue

      const snippetStart = Math.max(0, matchIndex - 40)
      const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

      return { messageId, role, snippet, matchStart }
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

async function findSessionMessageSnippet(
  sessionId: string,
  query: string,
  maxBytes?: number,
): Promise<string | undefined> {
  if (!query || query.length < 2) return undefined

  const filePath = requireDeps().paths.getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  try {
    const hit = await findFirstMatchInAgentJsonl(filePath, query.toLowerCase(), query.length, maxBytes)
    return hit?.snippet
  } catch {
    return undefined
  }
}

function createSessionReferenceSearchResult(
  session: AgentSessionMeta,
  workspacesById: ReadonlyMap<string, { name: string; slug: string }>,
  fields: Pick<AgentSessionReferenceSearchResult, 'matchSource' | 'snippet'>,
): AgentSessionReferenceSearchResult {
  const workspace = session.workspaceId ? workspacesById.get(session.workspaceId) : undefined

  return {
    sessionId: session.id,
    title: session.title,
    ...(workspace ? {
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
    } : {}),
    updatedAt: session.updatedAt,
    ...fields,
  }
}

/**
 * 搜索可引用的 Agent 会话。
 *
 * 指定工作区时仅返回该工作区；省略工作区时跨工作区搜索。两种模式都排除已归档和当前会话；无关键词时返回最近更新的会话。
 */
export async function searchAgentSessionReferences(input: AgentSessionReferenceSearchInput): Promise<AgentSessionReferenceSearchResult[]> {
  const workspaceId = input?.workspaceId?.trim()

  const query = (input?.query ?? '').trim()
  const queryLower = query.toLowerCase()
  const requestedLimit = Number.isFinite(input?.limit) ? input.limit! : 20
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SESSION_REFERENCE_LIMIT)
  const workspacesById = new Map(
    requireDeps().workspaces.listAgentWorkspaces().map((workspace) => [workspace.id, workspace]),
  )

  const candidates = listAgentSessions()
    .filter((session) => !workspaceId || session.workspaceId === workspaceId)
    .filter((session) => !session.archived)
    .filter((session) => session.id !== input?.excludeSessionId)

  const results: AgentSessionReferenceSearchResult[] = []
  let bodyScanCount = 0

  for (const session of candidates) {
    if (results.length >= limit) break

    if (!queryLower) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        matchSource: 'recent',
      }))
      continue
    }

    if (session.title.toLowerCase().includes(queryLower)) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        matchSource: 'title',
      }))
      continue
    }

    // 即使正文预算耗尽，仍继续遍历，确保较旧但标题命中的会话不会漏掉。
    if (bodyScanCount >= MAX_SESSION_REFERENCE_BODY_SCANS) continue
    bodyScanCount += 1

    const snippet = await findSessionMessageSnippet(
      session.id,
      query,
      MAX_SESSION_REFERENCE_BODY_BYTES_PER_FILE,
    )
    if (snippet) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        snippet,
        matchSource: 'message',
      }))
    }
  }

  return results
}
