/**
 * 比例系统（layout scale）：按窗口宽度分三档，外壳的列宽 / 控件高 / 留白都从这里取值。
 *
 * 全渲染层此前没有任何随窗口宽度变化的规则（106 处 sm:/md: 断点全在次级视图，且 640/768
 * 在最小 800 宽的窗口里永远命中），所以 1920 上阅读列两边空一大片、1366 上三栏互挤。
 * 这里是唯一的判档处：AppShell 算出档位挂到 html[data-layout-size]，样式层只认 CSS 变量
 * （globals.css 的 --layout-*），不在组件里撒断点类。
 *
 * 三档：
 * - compact  ≤1399：13 寸笔记本（1366×768 / 1280×800）
 * - standard 1400~1679：主流 1440 / 1536（1920 @125%）有效宽
 * - wide     ≥1680：1920 及以上
 * 字号不随档位变（桌面工具惯例），变的是间距与控件高。对话列宽不走档位：Agent / Chat 按上游原版 72rem 居中（维护者定）。
 */
export type LayoutSize = 'compact' | 'standard' | 'wide'

export const COMPACT_MAX_VIEWPORT_WIDTH = 1399
export const WIDE_MIN_VIEWPORT_WIDTH = 1680

export function resolveLayoutSize(viewportWidth: number): LayoutSize {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 'standard'
  if (viewportWidth <= COMPACT_MAX_VIEWPORT_WIDTH) return 'compact'
  if (viewportWidth >= WIDE_MIN_VIEWPORT_WIDTH) return 'wide'
  return 'standard'
}

export interface SidebarAutoCollapseInput {
  size: LayoutSize
  /** 上一次判档结果；首次挂载传 null */
  previousSize: LayoutSize | null
  /** 当前左栏是否折叠（含用户手动折叠，持久化） */
  collapsed: boolean
  /** 当前折叠是否由本逻辑自动做的（与 collapsed 成对持久化，重载后来历不丢） */
  autoCollapsed: boolean
}

export interface SidebarAutoCollapsePlan {
  collapsed: boolean
  autoCollapsed: boolean
}

/**
 * 紧凑档自动把左栏折成 rail，离开紧凑档时还原；用户在紧凑档里手动展开过就不再自动折。
 * 用户在别的档位手动折叠的，进出紧凑档都原样保留（不是我们折的，不由我们展开）。
 */
export function planSidebarAutoCollapse(input: SidebarAutoCollapseInput): SidebarAutoCollapsePlan {
  const { size, previousSize, collapsed, autoCollapsed } = input
  const enteringCompact = size === 'compact' && previousSize !== 'compact'

  if (enteringCompact && !collapsed) return { collapsed: true, autoCollapsed: true }
  // 不在紧凑档却还挂着「自动折」标记（拉宽了窗口，或上次在小窗自动折叠后关了应用、这次在大窗打开）：还原
  if (size !== 'compact' && autoCollapsed) return { collapsed: false, autoCollapsed: false }
  // 紧凑档里由我们折的，用户又手动展开了：放弃自动语义，之后都听用户的
  if (size === 'compact' && autoCollapsed && !collapsed) return { collapsed: false, autoCollapsed: false }
  return { collapsed, autoCollapsed }
}
