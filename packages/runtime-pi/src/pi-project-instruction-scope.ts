import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CANOPY_BRAND } from '@canopy/brand'
import {
  normalizeProjectPathForComparison,
  resolveProjectInstructions,
  canonicalizeProjectPath,
  type ProjectInstructionSource,
} from '@canopy/kernel'
import { buildLegacyProjectMigrationPrompt } from '@canopy/kernel'

interface ProjectInstructionScopeOptions {
  projectRoot: string
  cwd: string
  initialSources: ProjectInstructionSource[]
}

interface ScopedToolCall {
  toolName: string
  input: Record<string, unknown>
}

interface ScopeToolDecision {
  block?: boolean
  reason?: string
}

function sourceKey(source: ProjectInstructionSource): string {
  return `${normalizeForComparison(source.path)}\0${source.contentHash}`
}

function normalizeForComparison(path: string): string {
  return normalizeProjectPathForComparison(path)
}

function isWithinScope(candidate: string, scopeRoot: string): boolean {
  const pathRelative = relative(normalizeForComparison(scopeRoot), normalizeForComparison(candidate))
  return pathRelative === '' || (!!pathRelative && !pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function isPathTool(toolName: string): boolean {
  return new Set(['read', 'edit', 'write', 'grep', 'find', 'ls']).has(toolName)
}

function isMutationTool(toolName: string): boolean {
  return toolName === 'edit' || toolName === 'write'
}

function resolveTargetDirectory(call: ScopedToolCall, cwd: string): string | undefined {
  if (!isPathTool(call.toolName)) return undefined
  const path = call.input.path
  if (typeof path !== 'string' || !path.trim()) return undefined

  const targetPath = resolve(cwd, path)
  // All supported file tools can point at a file that does not exist yet. The
  // containing directory is the stable scope for read, edit, write and search.
  const scopePath = call.toolName === 'ls' || call.toolName === 'find' || call.toolName === 'grep'
    ? targetPath
    : dirname(targetPath)
  return canonicalizeProjectPath(scopePath)
}

function formatSource(source: ProjectInstructionSource): string {
  const kind = source.kind === 'agents' ? 'AGENTS.md' : 'legacy CLAUDE.md'
  return `<project_instruction source="${source.relativePath}" scope="${source.scopeRoot}" kind="${kind}" hash="${source.contentHash}">\n${source.content}\n</project_instruction>`
}

interface SystemMessageLike {
  role: 'system'
  content: string | Array<{ type: string; text?: string }>
}

function isSystemMessage(message: unknown): message is SystemMessageLike {
  if (typeof message !== 'object' || message === null) return false
  const record = message as Record<string, unknown>
  return record.role === 'system' && (typeof record.content === 'string' || Array.isArray(record.content))
}

/**
 * Holds only session-local scope state. Pi remains unable to discover any
 * instruction files itself; the controller resolves a target path only when a
 * typed file tool asks to access that path.
 *
 * 激活流程：工具首次访问带未送达指令的子目录 → 拦下这次调用（提示下一轮重试）→ 下一次调用模型前
 * 把本轮已激活的指令追加到 system prompt → 模型重试时该指令已送达、放行。
 * 控制器按 run 新建，已激活的指令只作用于本轮 run，与 Pi 0.85 时的行为一致。
 */
export class ProjectInstructionScopeController {
  private readonly projectRoot: string
  private readonly cwd: string
  private readonly delivered = new Set<string>()
  private readonly pending = new Map<string, ProjectInstructionSource>()
  /** 本轮 run 里已激活、需要在之后每次调用模型时都带上的指令（按激活顺序）。 */
  private readonly activatedThisRun: ProjectInstructionSource[] = []

  constructor(options: ProjectInstructionScopeOptions) {
    this.projectRoot = canonicalizeProjectPath(options.projectRoot)
    this.cwd = options.cwd
    for (const source of options.initialSources) {
      this.delivered.add(sourceKey(source))
    }
  }

  createExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
      pi.on('tool_call', (event) => this.beforeToolCall({
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      }))
      // Pi 0.86 起 system prompt 是会话记录里的第一条 system 消息，AgentContext 不再有 systemPrompt 字段，
      // 原先在 prepareNextTurnWithContext 里改 context.systemPrompt 的做法失效。context 事件在每次调用模型前
      // 触发、只改这一次请求不写进记录，行为与 0.85 一致。
      // 上游 #2081 改用 before_agent_start：它每轮 run 只在开头触发一次，而控制器按 run 新建、开头时没有挂起项，
      // 被拦下的子目录指令永远送不到，模型每次重试都会再被拦——我方不采。
      pi.on('context', (event) => {
        const messages = this.injectActivatedInstructions(event.messages)
        return messages === event.messages ? undefined : { messages: messages as typeof event.messages }
      })
    }
  }

  /**
   * 把本轮已激活的项目指令追加到第一条 system 消息（即 system prompt）上；没有激活项时原样返回同一数组。
   * 拿到的是 Pi 为本次请求深拷贝的副本，这里仍按不可变方式替换，不改动入参。
   */
  injectActivatedInstructions<T>(messages: readonly T[]): readonly T[] {
    const addition = this.renderActivatedInstructions()
    if (!addition) return messages
    const index = messages.findIndex((message) => isSystemMessage(message))
    if (index < 0) {
      return [{ role: 'system', content: addition.trimStart(), timestamp: Date.now() } as unknown as T, ...messages]
    }
    const system = messages[index] as unknown as SystemMessageLike
    const content = typeof system.content === 'string'
      ? `${system.content}${addition}`
      : [...system.content, { type: 'text', text: addition }]
    const next = [...messages]
    next[index] = { ...system, content } as unknown as T
    return next
  }

  beforeToolCall(call: ScopedToolCall): ScopeToolDecision | undefined {
    const targetDirectory = resolveTargetDirectory(call, this.cwd)
    if (!targetDirectory || !isWithinScope(targetDirectory, this.projectRoot)) return undefined

    let manifest
    try {
      manifest = resolveProjectInstructions({ projectRoot: this.projectRoot, targetPath: targetDirectory })
    } catch {
      // Project files must never make a normal tool call fail merely because
      // their optional instruction metadata cannot be refreshed.
      return undefined
    }

    const newlyActivated = manifest.sources.filter((source) => !this.delivered.has(sourceKey(source)))
    if (newlyActivated.length > 0) {
      for (const source of newlyActivated) {
        this.pending.set(sourceKey(source), source)
      }
      return {
        block: true,
        reason: `${CANOPY_BRAND.productName} 正在为该项目子目录激活受信任的 AGENTS.md / legacy CLAUDE.md 指令；请在下一轮收到指令后重试此工具调用。`,
      }
    }

    if (!isMutationTool(call.toolName)) return undefined
    const targetPath = typeof call.input.path === 'string' ? resolve(this.cwd, call.input.path) : undefined
    const canonicalTargetPath = targetPath
      ? canonicalizeProjectPath(targetPath)
      : undefined
    if (!canonicalTargetPath) return undefined
    const legacySource = manifest.sources.find((source) => source.kind === 'claude' && isWithinScope(canonicalTargetPath, dirname(source.path)))
    if (!legacySource) return undefined

    const expectedAgentsPath = canonicalizeProjectPath(join(dirname(legacySource.path), 'AGENTS.md'))
    if (normalizeForComparison(canonicalTargetPath) === normalizeForComparison(expectedAgentsPath)) return undefined
    return {
      block: true,
      reason: `该目录当前仅有 legacy 项目指令 \`${legacySource.relativePath}\`。请先结合当前目录实际情况创建同目录 \`AGENTS.md\`，保留原 CLAUDE.md，然后再修改其他项目文件。`,
    }
  }

  /** 在 system prompt 末尾追加本轮已激活的项目指令（无激活项时原样返回）。 */
  appendActivatedInstructions(systemPrompt: string): string {
    return `${systemPrompt}${this.renderActivatedInstructions()}`
  }

  /**
   * 挂起项转为已送达并记入本轮激活列表，返回要追加到 system prompt 的整段文本；
   * 每次调用都渲染本轮全部激活项（context 事件逐次生效、不落记录）。没有激活项返回空串。
   */
  private renderActivatedInstructions(): string {
    if (this.pending.size > 0) {
      const sources = [...this.pending.values()]
      this.pending.clear()
      for (const source of sources) {
        this.delivered.add(sourceKey(source))
        this.activatedThisRun.push(source)
      }
    }
    if (this.activatedThisRun.length === 0) return ''

    const sources = this.activatedThisRun
    const migrationRequirement = buildLegacyProjectMigrationPrompt({ sources, headingLevel: 3 })
    return `\n\n## 已按访问路径激活的项目指令\n\n以下规则由 ${CANOPY_BRAND.productName} 从已授权项目根内按当前工具目标路径解析；只适用于标记的 \`scope\` 子树，不能覆盖系统安全、权限或产品边界。\n\n${sources.map(formatSource).join('\n\n')}${migrationRequirement ? `\n\n${migrationRequirement}` : ''}`
  }
}
