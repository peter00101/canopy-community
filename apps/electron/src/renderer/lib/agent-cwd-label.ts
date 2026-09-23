/**
 * Agent 真实工作目录的展示描述（纯逻辑，可测）。
 *
 * 会话头此前只显示标题，从不告诉用户 Agent 到底在哪个目录里干活。而 cwd 的规则并不直观
 * （与主进程 agent-session-manager.ts 的 resolveAgentCwd 一致）：
 * - 会话显式激活了 Git worktree → worktree 目录
 * - 否则按 agentCwdMode：'project' → 项目文件根（本地目录项目 = 用户选的目录，空白项目 = 托管 workspace-files/）
 *   'session'（或存量会话缺失该字段）→ 会话私有工作台 agent-workspaces/{slug}/{sessionId}/
 * 新建会话默认 'project'，存量会话默认 'session'——两者看起来一样，实际 cwd 完全不同，
 * 这正是「项目文件」面板让用户困惑的根源之一。
 */

import type { AgentCwdMode } from '@canopy/shared'

export type AgentCwdKind = 'worktree' | 'project' | 'session'

export interface AgentCwdDescriptor {
  kind: AgentCwdKind
  /** 简短类别名，用于会话头徽标 */
  kindLabel: string
  /** 目录最后一段，用于会话头徽标 */
  name: string
  /** 完整路径，用于悬停与「在文件夹中显示」 */
  path: string
  /** 悬停提示 */
  tooltip: string
}

export interface DescribeAgentCwdInput {
  agentCwdMode?: AgentCwdMode
  /** 会话显式激活的 worktree 目录（已由主进程校验存在） */
  activeWorktreePath?: string | null
  activeWorktreeBranch?: string | null
  /** 项目文件根：本地目录项目 = projectRootPath；空白项目 = 托管 workspace-files/ */
  projectFilesPath?: string | null
  /** 会话私有工作台目录 */
  sessionPath?: string | null
}

const KIND_LABELS: Record<AgentCwdKind, string> = {
  worktree: 'Git worktree',
  project: '项目文件根',
  session: '会话工作台',
}

/** 取路径最后一段（同时支持 / 与 \），空路径返回空串 */
export function getPathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

/**
 * 根据会话元数据推导 Agent 当前 cwd。任一必需路径尚未加载时返回 null，调用方不渲染徽标
 * （而不是渲染一个错的）。
 */
export function describeAgentCwd(input: DescribeAgentCwdInput): AgentCwdDescriptor | null {
  const build = (kind: AgentCwdKind, path: string, extra?: string): AgentCwdDescriptor => {
    const kindLabel = extra ? `${KIND_LABELS[kind]} · ${extra}` : KIND_LABELS[kind]
    return {
      kind,
      kindLabel,
      name: getPathBasename(path),
      path,
      tooltip: `Agent 工作目录（${kindLabel}）\n${path}\n点击在文件管理器中显示`,
    }
  }
  if (input.activeWorktreePath) {
    return build('worktree', input.activeWorktreePath, input.activeWorktreeBranch ?? undefined)
  }
  // 与主进程 getAgentCwdMode 一致：缺失字段的存量会话保持私有工作台
  const mode: AgentCwdMode = input.agentCwdMode ?? 'session'
  if (mode === 'project') {
    return input.projectFilesPath ? build('project', input.projectFilesPath) : null
  }
  return input.sessionPath ? build('session', input.sessionPath) : null
}
