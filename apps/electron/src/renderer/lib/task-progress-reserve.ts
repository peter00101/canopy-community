/**
 * 会话尾部给任务进度浮层预留的净空（维护者 2026-08-22 报障）。
 *
 * `TaskProgressOverlay` 是绝对定位的浮块（外层 `bottom-[22px]`，触发按钮 `min-h-10`），而
 * `ConversationContent` 的底部 padding 只有 16px（`py-4`）——贴底时浮块会压住尾部 46px 的内容。
 * 8 分钟长任务提示（`agent-long-run-hint.ts`，实测高 42px）正好落在这条带里，整段文案被盖掉一半；
 * 任何尾部内容（最后一行回复、工具行）同样会被盖，只是提示框够高才被看见。
 *
 * 这里把「浮层需要多高的净空」与「预留用的 Tailwind 类」放在一处，避免两边各改各的漂移；
 * 类名必须写成字面量，Tailwind JIT 只扫描源码里真实出现的字符串。
 */

/** 浮层外层距滚动容器底边的距离 —— `TaskProgressOverlay` 的 `bottom-[22px]` */
export const TASK_PROGRESS_OVERLAY_BOTTOM_PX = 22
/** 浮层触发按钮的高度 —— `min-h-10`；文案 `truncate` 恒为单行，所以是定值 */
export const TASK_PROGRESS_OVERLAY_HEIGHT_PX = 40
/** 浮层顶边与最后一条内容之间的呼吸间距 */
export const TASK_PROGRESS_OVERLAY_GAP_PX = 6

/** 最后一条内容下方需要的总净空（px） */
export const TASK_PROGRESS_CLEARANCE_PX =
  TASK_PROGRESS_OVERLAY_BOTTOM_PX + TASK_PROGRESS_OVERLAY_HEIGHT_PX + TASK_PROGRESS_OVERLAY_GAP_PX

/**
 * 预留用的类。数值必须等于 {@link TASK_PROGRESS_CLEARANCE_PX}，由测试钉死；
 * 与 `ConversationContent` 自带的 `py-4` 冲突时由 `cn()`（tailwind-merge）取本类。
 */
export const TASK_PROGRESS_RESERVE_CLASS = 'pb-[68px]'

/**
 * 浮层展示任务进度（或压缩进度）时才预留；只剩「回到最下方」箭头的场景不预留——
 * 那个箭头只在未贴底时出现，此时尾部内容本就不在视口里。
 */
export function getTaskProgressReserveClass(overlayShown: boolean): string | undefined {
  return overlayShown ? TASK_PROGRESS_RESERVE_CLASS : undefined
}
