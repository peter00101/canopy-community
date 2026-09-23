import type { SDKMessage } from '@canopy/shared'

/** 一轮 Agent run 的身份：起始时间 + 会话内单调递增的代际号。 */
export interface LiveRunIdentity {
  startedAt: number
  runGeneration: number
}

/**
 * 给经 EventBus 推往渲染层的实时 SDK 消息打上所属 run 的标记（收上游 #2076）。
 *
 * 只返回浅拷贝、绝不改动入参：同一个消息对象还在 accumulatedMessages 里等着落盘，
 * 运行期标记不能污染 transcript。渲染层据此丢弃旧 run 的迟到消息——用户停止后立刻续跑时，
 * 旧 run 的 adapter 还可能吐出几条消息，直接写进 liveMessages 会把旧 TaskUpdate 显示进新任务。
 */
export function markLiveRunSdkMessage(message: SDKMessage, run: LiveRunIdentity): SDKMessage {
  return {
    ...(message as unknown as Record<string, unknown>),
    _canopyLiveRunStartedAt: run.startedAt,
    _canopyLiveRunGeneration: run.runGeneration,
  } as unknown as SDKMessage
}
