import * as React from 'react'
import { useAtomValue } from 'jotai'
import { detectIsWindows } from '@/lib/platform'
import { interfaceVariantAtom } from '@/atoms/theme'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
import {
  getWindowTitlebarDragInsetStyle,
  WINDOW_TITLEBAR_CONTROL_WIDTH_PX,
  WINDOW_TITLEBAR_CONTROLS_WIDTH_PX,
  WINDOW_TITLEBAR_HEIGHT_PX,
} from '@/lib/window-titlebar-layout'

/**
 * Windows 标题栏：背景条 + 拖拽区 + 自绘窗口控制按钮。
 *
 * 0.18.5 曾换 WCO 系统原生按钮（修「自绘按钮上沿被系统 resize 带吃掉」），但维护者
 * 2026-08-29 定：系统按钮观感差，换回自绘。本版采上游 #1900 的 hit-test 隔离——
 * 拖拽区 `left:0; right:138px` 与按钮组分属互不重叠的独立矩形，按钮整列 no-drag，
 * 避免高 DPI 下 HTCAPTION 与按钮 hitmask 重叠导致点击被拖拽带吃掉。
 *
 * NCHITTEST 逐像素实测（2026-08-29，真自绘构建）：**最大化态按钮列从屏幕
 * 第 0 行起全 HTCLIENT——甩顶可点**（0.18.5 报障的核心场景不复发）；非最大化态顶部
 * 约 5px 是 HTTOP resize 带（顶缘拖拽缩放的系统行为，网页层改不了），y≈+6 起可点——
 * 非最大化窗口顶不贴屏、无「甩顶」动作，用户瞄准点击按钮中部不受影响。
 */
export function WindowControls(): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  // 设置页自己画顶带（.settings-topband，配色体系）：打开时标题栏底色让开，否则现代风格下它会把顶带盖成内容区色
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const [isMaximized, setIsMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!isWindows) return
    window.electronAPI.windowIsMaximized().then(setIsMaximized)
    const unsub = window.electronAPI.onWindowResize(() => {
      window.electronAPI.windowIsMaximized().then((next) => {
        setIsMaximized((prev) => (prev === next ? prev : next))
      })
    })
    return unsub
  }, [isWindows])

  if (!isWindows) return null

  return (
    <div
      className={cn(
        'window-titlebar fixed inset-x-0 top-0 z-[100] flex select-none',
        (isClassic || settingsOpen) && 'window-titlebar-classic',
      )}
      style={{
        height: WINDOW_TITLEBAR_HEIGHT_PX,
        '--window-titlebar-controls-width': `${WINDOW_TITLEBAR_CONTROLS_WIDTH_PX}px`,
      } as React.CSSProperties}
    >
      <div
        aria-hidden="true"
        className="titlebar-drag-region pointer-events-none absolute inset-y-0 left-0"
        style={getWindowTitlebarDragInsetStyle(isWindows)}
      />
      <div
        className="window-controls relative ml-auto flex"
        style={{ width: WINDOW_TITLEBAR_CONTROLS_WIDTH_PX }}
      >
        <button
          type="button"
          className="window-control-btn"
          style={{ width: WINDOW_TITLEBAR_CONTROL_WIDTH_PX }}
          aria-label="最小化"
          onClick={() => window.electronAPI.windowMinimize()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          type="button"
          className="window-control-btn"
          style={{ width: WINDOW_TITLEBAR_CONTROL_WIDTH_PX }}
          aria-label={isMaximized ? '还原' : '最大化'}
          onClick={() => window.electronAPI.windowMaximize()}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="3" y="0.5" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="1" y="3.5" width="8" height="8" rx="0.5" fill="currentColor" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="window-control-btn window-control-close"
          style={{ width: WINDOW_TITLEBAR_CONTROL_WIDTH_PX }}
          aria-label="关闭"
          onClick={() => window.electronAPI.windowClose()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
