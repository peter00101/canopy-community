export const WIDE_FILE_PANEL_MIN_WIDTH = 760

export function shouldShowBothFileSources(width: number): boolean {
  return width >= WIDE_FILE_PANEL_MIN_WIDTH
}

/** 打开终端 / 浏览器等扩展工作区时，右侧面板默认吃掉的视口比例（上游取值）。 */
export const EXPANDED_WORKSPACE_DEFAULT_VIEWPORT_RATIO = 2 / 5

/** 中间会话区的舒适宽度：小视口下宽工作区的默认宽先给它让路（用户仍可手动拖宽）。 */
export const COMFORT_MAIN_AREA_WIDTH = 560

/**
 * 扩展工作区（终端 / 浏览器 / 预览等）首次打开时的默认宽度。
 *
 * 上游固定取视口 2/5，1280~1440 的小屏上会把中间会话区压到 500px 上下
 * （输入框、气泡都发紧）。这里让默认值在「2/5 视口」与「保住会话区 560px
 * 舒适宽」之间取小——大屏（≥1920）两者都富余，行为与上游完全一致；小屏
 * 则先保会话可读性。返回值仍会经 clampRightPanelWidth 保住扩展工作区自身
 * 的最小可用宽（480），不会把右侧面板挤到不可用。
 */
export function getDefaultWidePanelWidth(viewportWidth: number, leftSidebarOccupiedWidth: number): number {
  const ratioWidth = Math.floor(viewportWidth * EXPANDED_WORKSPACE_DEFAULT_VIEWPORT_RATIO)
  const comfortCapped = viewportWidth - leftSidebarOccupiedWidth - COMFORT_MAIN_AREA_WIDTH
  return Math.min(ratioWidth, Math.max(0, comfortCapped))
}
