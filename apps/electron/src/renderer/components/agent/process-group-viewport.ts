/**
 * 执行过程块在流式期间的「小视口」参数（纯常量与纯函数，便于单测钉住决策）。
 *
 * 维护者 2026-09-14 报：长任务几十次工具调用时，过程块被钉在 320px 且滚动条隐藏，
 * 「执行过程隐藏了很多，执行长一点压根滑不到」。改法三条：视口抬到 480、滚动条显示为细条、
 * 标题行加「展开全部」开关让用户随时脱离小视口看全量。
 */

/** 流式期间过程块的最大高度（px）。480 ≈ 一屏的一半，能看到最近 8～10 条工具调用。 */
export const PROCESS_GROUP_VIEWPORT_HEIGHT = 480

/** 小视口开关的按钮文案：钉在小视口时提供「展开全部」，已展开时提供「收回小窗」。 */
export function getProgressViewportToggleLabel(keepProgressViewport: boolean): string {
  return keepProgressViewport ? '展开全部' : '收回小窗'
}

/** 只有流式进行中且内容已渲染时才需要这个开关；跑完后点开本来就是全高。 */
export function shouldShowProgressViewportToggle(isStreaming: boolean, contentRendered: boolean): boolean {
  return isStreaming && contentRendered
}
