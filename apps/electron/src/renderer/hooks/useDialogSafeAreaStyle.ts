/**
 * 居中弹窗避开原生覆盖层（受管浏览器）的定位样式。
 *
 * 见 `@/lib/dialog-safe-area` 的完整背景：`WebContentsView` 天然压在 DOM 之上且吞掉鼠标事件，
 * 开着浏览器时窗口正中的弹窗右半（含靠右的确认按钮）既看不见也点不着（0.18.67）。
 * 无浏览器时返回 `undefined`，弹窗保持原有的 `left-[50%]` 居中，**行为零变化**。
 *
 * ⚠️ 必须每次渲染后重测，不能只在挂载时测一次（dev 实测踩坑）：这些弹窗的 Content 在应用
 * 启动时就已挂载，用户「打开弹窗」只是让它重新渲染、**不会重新挂载**。带恒定依赖数组的
 * layout effect 因此只在启动那一刻跑过一次——那时右侧浏览器还没起来，量到的障碍物恒为空，
 * 表现为修了等于没修。改成每次渲染后重测，并靠值相等判断避免无限循环。
 */
import * as React from 'react'
import { readNativeOverlayRects, resolveDialogPlacement } from '@/lib/dialog-safe-area'

/** 与 `max-w-lg` 对齐 */
const DEFAULT_DIALOG_MAX_WIDTH = 512
/** 与视口/覆盖层边缘的留白 */
const EDGE_MARGIN = 16
/** 压到这个宽度还放不下就不让位了，免得弹窗窄得没法用 */
const MIN_DIALOG_WIDTH = 320

interface SafeAreaStyle {
  left: string
  maxWidth: string
}

function isSameStyle(a: SafeAreaStyle | undefined, b: SafeAreaStyle | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.left === b.left && a.maxWidth === b.maxWidth
}

export function useDialogSafeAreaStyle(dialogMaxWidth: number = DEFAULT_DIALOG_MAX_WIDTH): React.CSSProperties | undefined {
  const [style, setStyle] = React.useState<SafeAreaStyle | undefined>(undefined)

  const measure = React.useCallback((): void => {
    const placement = resolveDialogPlacement({
      viewportWidth: window.innerWidth,
      dialogMaxWidth,
      obstacles: readNativeOverlayRects(),
      margin: EDGE_MARGIN,
      minWidth: MIN_DIALOG_WIDTH,
    })
    const next = placement
      ? { left: `${placement.centerX}px`, maxWidth: `${placement.maxWidth}px` }
      : undefined
    // 只有真的变了才写 state，否则「每次渲染后重测」会变成无限循环。
    setStyle((previous) => (isSameStyle(previous, next) ? previous : next))
  }, [dialogMaxWidth])

  // 无依赖数组：每次渲染后都重测。用 layout effect 是为了在首帧绘制前定好位，
  // 避免弹窗先在网页底下闪一下再跳过来。
  React.useLayoutEffect(measure)

  React.useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return style
}
