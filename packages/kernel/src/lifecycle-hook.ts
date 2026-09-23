/**
 * Agent 生命周期钩子契约
 *
 * 目前只有一个真实触发点（构建 system prompt 之前）、一个真实消费方
 * （`agent-memory-refresh-service.ts` 的记忆复查邀请）。不引入
 * `onTurnEnd`/`onSessionStart` 等尚无真实消费方的钩子类型——等真的出现
 * 第二个触发点/消费方时再加，避免为假设需求做提前抽象。
 */
export interface AgentLifecycleHookContext {
  workspaceSlug: string
  /** 已知尚未建立协作画像时不重复邀请（与既有 memoryGuidance 门槛一致）。 */
  needsCollaborationProfile: boolean
  now?: number
}

/** 在构建 system prompt 之前调用，返回值原样拼接进 system prompt；不产生建议时返回 undefined。 */
export interface AgentLifecycleHook {
  readonly id: string
  onBeforeSystemPrompt(ctx: AgentLifecycleHookContext): string | undefined
}
