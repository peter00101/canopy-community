/**
 * Chat 消息操作栏「切换到 Agent 模式」的二次确认逻辑。
 *
 * 该图标紧挨「复制」，误点会新建 Agent 会话、复制历史并切走模式，所以点击先确认。
 * AgentRecommendBanner 的横幅按钮是明确意图，不走这里。
 */

/**
 * 确认弹窗文案（按主进程 migrateChatToAgentSession 的真实行为写）：
 * 只复制 user / assistant 的文字内容，附件、工具过程、推理不带；原 Chat 对话不删除。
 */
export const MIGRATE_TO_AGENT_CONFIRM_COPY = {
  title: '切换到 Agent 模式？',
  description: '将新建一个 Agent 会话，并把当前对话的文字记录复制过去（附件和工具过程不会带上）。原 Chat 对话会保留，之后仍可回来继续。',
  cancelLabel: '取消',
  confirmLabel: '切换',
} as const

/** 点击图标后的处理：忽略 / 提示先配渠道 / 弹确认 */
export type MigrateToAgentClickDecision = 'ignore' | 'need-agent-channel' | 'confirm'

export interface MigrateToAgentClickInput {
  /** 正在迁移中 */
  migrating: boolean
  /** 是否已配置 Agent 渠道 */
  hasAgentChannel: boolean
}

export function resolveMigrateToAgentClick(input: MigrateToAgentClickInput): MigrateToAgentClickDecision {
  if (input.migrating) return 'ignore'
  // 没配渠道确认了也切不过去，直接提示，不让用户白点一次「切换」
  if (!input.hasAgentChannel) return 'need-agent-channel'
  return 'confirm'
}
