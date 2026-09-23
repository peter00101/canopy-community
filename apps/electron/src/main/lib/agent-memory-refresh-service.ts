import type { AgentLifecycleHook } from '@canopy/kernel'
import { listAgentSessions } from './agent-session-manager'
import {
  getWorkspaceMemoryReviewLastPromptAt,
  getWorkspaceMemorySummary,
  recordWorkspaceMemoryReviewInvitation,
} from './agent-workspace-manager'

const DAY_MS = 24 * 60 * 60 * 1000
/** Internal-only cadence. Users are invited, never automatically scanned. */
export const WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS = 3

export interface WorkspaceMemoryRefreshOpportunity {
  /** The latest memory update before which new workspace sessions accumulated. */
  memoryUpdatedAt?: number
  newestSessionAt: number
  newerSessionCount: number
}

/**
 * 注入依赖，供测试用假实现驱动——真实调用方（生命周期钩子）永远用默认值，
 * 行为与直接 import 完全一致。避免在测试里对 `agent-session-manager.ts`/
 * `agent-workspace-manager.ts` 做 `mock.module`：这两个文件被大量其他模块
 * 和测试依赖，wholesale mock 会在全量测试跑批时造成模块级串扰（已实测踩坑）。
 */
export interface ClaimWorkspaceMemoryRefreshOpportunityDeps {
  getWorkspaceMemoryReviewLastPromptAt: (workspaceSlug: string) => number | undefined
  getWorkspaceMemorySummary: (workspaceSlug: string) => { autoMemory: { updatedAt?: number } }
  listAgentSessions: () => Array<{ workspaceId?: string; updatedAt: number }>
  recordWorkspaceMemoryReviewInvitation: (workspaceSlug: string, at: number) => void
}

const defaultDeps: ClaimWorkspaceMemoryRefreshOpportunityDeps = {
  getWorkspaceMemoryReviewLastPromptAt,
  getWorkspaceMemorySummary,
  listAgentSessions,
  recordWorkspaceMemoryReviewInvitation,
}

/**
 * Lazily checks a workspace during a foreground Agent run. Archived sessions are
 * deliberately included: archival is a navigation choice, not evidence deletion.
 */
export function claimWorkspaceMemoryRefreshOpportunity(
  workspaceSlug: string | undefined,
  now = Date.now(),
  deps: ClaimWorkspaceMemoryRefreshOpportunityDeps = defaultDeps,
): WorkspaceMemoryRefreshOpportunity | undefined {
  if (!workspaceSlug) return undefined
  const lastPromptAt = deps.getWorkspaceMemoryReviewLastPromptAt(workspaceSlug)

  const summary = deps.getWorkspaceMemorySummary(workspaceSlug)
  const memoryUpdatedAt = summary.autoMemory.updatedAt
  const sessions = deps.listAgentSessions().filter((session) => session.workspaceId === workspaceSlug)
  const newerSessions = sessions.filter((session) => session.updatedAt > (memoryUpdatedAt ?? 0))
  const newestSessionAt = newerSessions[0]?.updatedAt
  if (!newestSessionAt) return undefined

  // Re-prompt no more often than the fixed internal cadence, even if the user skipped it.
  const cooldownFrom = Math.max(memoryUpdatedAt ?? 0, lastPromptAt ?? 0)
  if (now - cooldownFrom < WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS * DAY_MS) return undefined

  deps.recordWorkspaceMemoryReviewInvitation(workspaceSlug, now)
  return { memoryUpdatedAt, newestSessionAt, newerSessionCount: newerSessions.length }
}

/**
 * 生命周期钩子工厂：在构建 system prompt 之前认领一次记忆复查机会，命中时
 * 返回拼接进 system prompt 的邀请文案（原文来自 agent-prompt-builder.ts，
 * 现由本文件自持，orchestrator 不再直接 import claimWorkspaceMemoryRefreshOpportunity）。
 * `deps` 仅供测试注入假实现；生产环境固定使用默认单例 `memoryRefreshLifecycleHook`。
 */
export function createMemoryRefreshLifecycleHook(
  deps: ClaimWorkspaceMemoryRefreshOpportunityDeps = defaultDeps,
): AgentLifecycleHook {
  return {
    id: 'workspace-memory-refresh',
    onBeforeSystemPrompt(ctx) {
      if (ctx.needsCollaborationProfile) return undefined
      const opportunity = claimWorkspaceMemoryRefreshOpportunity(ctx.workspaceSlug, ctx.now, deps)
      if (!opportunity) return undefined
      return `## 项目记忆复查邀请
距离当前工作区长期协作知识上次更新已超过内部复查间隔；期间产生了 ${opportunity.newerSessionCount} 个更新会话（**包括已归档会话**，归档不代表历史无效）。

完成当前用户请求后，使用 \`AskUserQuestion\` 简短询问用户：是否愿意授权你将上次协作记忆更新后的当前工作区会话作为补充证据。用户可选择"本周期跳过"；不要把它当作错误或继续追问。
若获得会话整理授权，先按元信息选择少量近期、高信号会话并分批读取必要片段；不要全量扫描。基于明确证据的协作记忆可直接最小写入并说明结果；仅对删除/大段覆盖、冲突、不确定推断或敏感信息再次请求确认；绝不跨工作区扫描。`
    },
  }
}

export const memoryRefreshLifecycleHook: AgentLifecycleHook = createMemoryRefreshLifecycleHook()
