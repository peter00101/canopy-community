/**
 * 让居中弹窗避开原生覆盖层（受管浏览器的 WebContentsView）。
 *
 * 背景（0.18.67 修，维护者 mac 报障）：`WebContentsView` 是原生子视图，**天然盖在
 * renderer DOM 之上，CSS z-index 无法反转**；鼠标事件也会落到原生视图上被网页吃掉。
 * 因此开着内置浏览器时，窗口正中的确认弹窗右半（含靠右的「回退」按钮）不只是看不见，
 * 而是**点不着**——1512 宽窗口下弹窗横跨 x=500~1012，而浏览器走宽布局时左缘只有 752。
 *
 * ⚠️ 不能用「浮层出现就隐藏浏览器」来解决：`BrowserSlot.tsx` 顶部注释写明该行为当年是为
 * 治右侧浏览器白屏而**主动去掉**的，加回去白屏会复发。所以改成弹窗自己让位。
 *
 * 障碍物矩形直接量 `BrowserSlot` 渲染的那个 div（带 `data-native-overlay`）——它就是原生
 * 视图的边界来源，比另建一套状态更准，也不必改动可见性链路。
 */

/** 标记「此 DOM 节点背后是一个原生覆盖层」。BrowserSlot 的容器带上它。 */
export const NATIVE_OVERLAY_ATTR = 'data-native-overlay'

export interface OverlayRect {
  x: number
  width: number
  height: number
}

export interface DialogPlacementInput {
  /** 视口宽度 */
  viewportWidth: number
  /** 弹窗设计宽度（Tailwind `max-w-lg` = 512） */
  dialogMaxWidth: number
  /** 当前可见的原生覆盖层 */
  obstacles: readonly OverlayRect[]
  /** 与视口/障碍物边缘的最小留白 */
  margin: number
  /** 让位后允许压缩到的最小宽度；压不到就放弃让位 */
  minWidth: number
}

export interface DialogPlacement {
  /** 弹窗中心的 x，配合 `translateX(-50%)` 使用 */
  centerX: number
  /** 让位后实际可用的最大宽度 */
  maxWidth: number
}

/** 宽高都太小的视为不可见（与 BrowserSlot 判 visible 的 >4 阈值一致）。 */
function isVisibleOverlay(rect: OverlayRect): boolean {
  return rect.width > 4 && rect.height > 4
}

/**
 * 算出弹窗该放哪。返回 `null` 表示保持默认居中（无障碍物、默认位置本就不被遮，或让不出位置）。
 *
 * 只做横向判定：受管浏览器占据右侧面板的整个高度，而弹窗垂直居中，两者在纵向上必然相交，
 * 再算纵向只是徒增复杂度。
 */
export function resolveDialogPlacement(input: DialogPlacementInput): DialogPlacement | null {
  const { viewportWidth, dialogMaxWidth, margin, minWidth } = input
  if (viewportWidth <= 0 || dialogMaxWidth <= 0) return null

  const obstacles = input.obstacles.filter(isVisibleOverlay)
  if (obstacles.length === 0) return null

  // 默认居中时弹窗占据的横向区间
  const defaultWidth = Math.min(dialogMaxWidth, viewportWidth)
  const defaultLeft = (viewportWidth - defaultWidth) / 2
  const defaultRight = defaultLeft + defaultWidth

  const overlapsDefault = obstacles.some((rect) => (
    rect.x < defaultRight && rect.x + rect.width > defaultLeft
  ))
  if (!overlapsDefault) return null

  // 取所有障碍物的横向包络，两侧各留一段自由区，选更宽的那侧
  const blockedLeft = Math.min(...obstacles.map((rect) => rect.x))
  const blockedRight = Math.max(...obstacles.map((rect) => rect.x + rect.width))

  const leftRegion = { start: 0, width: Math.max(0, blockedLeft) }
  const rightRegion = { start: blockedRight, width: Math.max(0, viewportWidth - blockedRight) }
  const region = leftRegion.width >= rightRegion.width ? leftRegion : rightRegion

  const usable = region.width - margin * 2
  if (usable < minWidth) return null

  return {
    centerX: region.start + region.width / 2,
    maxWidth: Math.min(dialogMaxWidth, usable),
  }
}

/** 从文档里读出所有原生覆盖层的矩形。 */
export function readNativeOverlayRects(doc: Document = document): OverlayRect[] {
  return Array.from(doc.querySelectorAll(`[${NATIVE_OVERLAY_ATTR}]`)).map((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, width: rect.width, height: rect.height }
  })
}
