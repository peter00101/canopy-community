/**
 * Agent 长时间运行的界面提示（纯逻辑，可测）——第二层。
 *
 * 第一层是提示词纪律（模型自觉），第三层是 bash 默认超时兜底（10 分钟）；这一层给用户一个可见的
 * 判断依据：跑得久不等于在干活，Agent 可能在原地等一个永远不会到的外部状态。文案刻意写成
 * 条件句（「若…」），因为多步长任务合法地跑 20 分钟也很常见，不能一刀切说它卡了。
 */

/** 超过这个时长开始提示（秒）；与 bash 默认超时同一量级，早于它出现，让用户先于工具超时看到 */
export const LONG_RUN_HINT_AFTER_SECONDS = 8 * 60
/** 再超过这个时长换更强的措辞（秒） */
export const LONG_RUN_STRONG_HINT_AFTER_SECONDS = 25 * 60

export type LongRunHintLevel = 'none' | 'notice' | 'strong'

export interface LongRunHint {
  level: Exclude<LongRunHintLevel, 'none'>
  minutes: number
  text: string
}

export function buildLongRunHint(elapsedSeconds: number): LongRunHint | null {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < LONG_RUN_HINT_AFTER_SECONDS) return null
  const minutes = Math.floor(elapsedSeconds / 60)
  if (elapsedSeconds >= LONG_RUN_STRONG_HINT_AFTER_SECONDS) {
    return {
      level: 'strong',
      minutes,
      text: `已运行 ${minutes} 分钟。若最近一直没有新的工具调用或输出，Agent 很可能在原地等待一个不会到来的外部结果——可点「停止」，然后让它改用带超时的短轮询检查，或直接告诉它当前状态。`,
    }
  }
  return {
    level: 'notice',
    minutes,
    text: `已运行 ${minutes} 分钟。若 Agent 在等待外部结果（下载、编译、他人操作），可能是在原地空等：可随时点「停止」并让它改用带超时的短轮询检查。`,
  }
}
