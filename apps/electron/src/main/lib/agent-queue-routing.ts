export interface ExitPlanFeedbackRouteInput {
  dispatch: 'after_current' | 'now'
  sessionActive: boolean
  hasPendingExitPlan: boolean
  rawText: string
}

/**
 * ExitPlanMode 审批挂起时，主输入框发的消息应作为对该审批的反馈送给模型，
 * 而不是打断当前 run——打断会让模型重新提交审批，用户越催越循环（维护者「删除」三连实锤）；
 * 也不该排队——审批挂着 turn 永远不结束，排队消息永远等不到消费。
 * 只拦 dispatch=now 的活跃会话；用户显式排队（after_current）尊重原语义。
 */
export function shouldRouteAsExitPlanFeedback(input: ExitPlanFeedbackRouteInput): boolean {
  return input.dispatch === 'now'
    && input.sessionActive
    && input.hasPendingExitPlan
    && input.rawText.trim().length > 0
}

/**
 * Pi runtime 完成 query 与 renderer 收到终态事件之间，可能拒绝对旧通道的消息注入。
 * 这些错误表示消息尚未被接受，应转交 deferred queue，而不是暴露为用户发送失败。
 */
export function isStaleActiveQueueError(error: unknown): boolean {
  const record = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : String(error)

  return code === 'agent.query.not_active' ||
    message.includes('会话未运行，无法追加消息') ||
    message.includes('无活跃消息通道可注入队列消息') ||
    message.includes('当前会话没有正在运行的 Agent') ||
    message.includes('Agent session is not active')
}
