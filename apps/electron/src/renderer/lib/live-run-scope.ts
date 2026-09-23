/**
 * 实时 SDK 消息的 run 归属判定（收上游 #2076）。
 *
 * 主进程给经 EventBus 推来的每条实时消息都打上 `_canopyLiveRunGeneration`（会话内单调递增的代际）
 * 与 `_canopyLiveRunStartedAt`；旧协议只有渲染层补的 startedAt。用户停止后立刻续跑时，
 * 旧 run 的 adapter 还可能吐出几条消息，必须据此挡在 liveMessages 之外。
 */

/** 当前 run 的身份，取自 AgentStreamState。 */
export interface LiveRunIdentity {
  runGeneration?: number
  startedAt?: number
}

/**
 * 消息是否属于当前 run。新协议按代际比；任一侧缺代际才退回比 startedAt；
 * 两侧任一缺标记一律视为属于——宁可放进来，也不能把新 run 的消息误丢。
 */
export function isLiveMessageInRun(message: unknown, run: LiveRunIdentity | null | undefined): boolean {
  if (!run || typeof message !== 'object' || message === null) return true
  const record = message as Record<string, unknown>
  const generation = record._canopyLiveRunGeneration
  if (run.runGeneration != null && typeof generation === 'number') {
    return generation === run.runGeneration
  }
  const startedAt = record._canopyLiveRunStartedAt
  if (run.startedAt != null && typeof startedAt === 'number') {
    return startedAt === run.startedAt
  }
  return true
}
