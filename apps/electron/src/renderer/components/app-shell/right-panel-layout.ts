import type { LayoutSize } from '@/lib/layout-scale'

export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 3 / 5
export const MIN_MAIN_AREA_WIDTH = 320

/**
 * 右面板占视口的上限按尺寸档走（比例系统，layout-scale.ts）：
 * 13 寸本上从 1920 带过来的持久化宽度（如 580）会吃掉四成多屏幕，紧凑档压到 42%；
 * 宽屏维持原来的 3/5。分屏 / 浏览器等宽工作区在左栏折叠后仍可用全部可用宽（allowFullAvailableWidth）。
 */
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO_BY_SIZE: Record<LayoutSize, number> = {
  compact: 0.42,
  standard: 0.5,
  wide: RIGHT_PANEL_MAX_VIEWPORT_RATIO,
}

export function getRightPanelMaxWidth(
  viewportWidth: number,
  leftSidebarOccupiedWidth: number,
  allowFullAvailableWidth = false,
  maxViewportRatio: number = RIGHT_PANEL_MAX_VIEWPORT_RATIO,
): number {
  const availableWidth = viewportWidth - leftSidebarOccupiedWidth - MIN_MAIN_AREA_WIDTH
  return Math.max(
    0,
    allowFullAvailableWidth
      ? availableWidth
      : Math.min(
        Math.floor(viewportWidth * maxViewportRatio),
        availableWidth,
      ),
  )
}

export function clampRightPanelWidth(
  width: number,
  viewportWidth: number,
  minimumWidth: number,
  leftSidebarOccupiedWidth: number,
  allowFullAvailableWidth = false,
  maxViewportRatio: number = RIGHT_PANEL_MAX_VIEWPORT_RATIO,
): number {
  const maximumWidth = getRightPanelMaxWidth(
    viewportWidth,
    leftSidebarOccupiedWidth,
    allowFullAvailableWidth,
    maxViewportRatio,
  )
  const effectiveMinimumWidth = Math.min(minimumWidth, maximumWidth)
  return Math.max(effectiveMinimumWidth, Math.min(maximumWidth, width))
}
