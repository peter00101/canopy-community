import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

export interface VirtualSidebarRow {
  id: string
  /** 预估高度只影响首帧；实际挂载后由 measureElement 自动校正。 */
  estimateSize: number
  content: React.ReactNode
}

interface VirtualSidebarListProps {
  rows: VirtualSidebarRow[]
  className?: string
  /** 选中行离开挂载范围时，自动定位后再挂载，保持原侧栏的选中项可见行为。 */
  activeRowId?: string | null
  /** 额外提前挂载的行数，保证触控板快速滚动时不会露白。 */
  overscan?: number
}

/**
 * 左侧栏统一虚拟列表容器。
 *
 * 保持原生 overflow 滚动、可变行高和 DOM 测量；仅让视口附近行挂载，避免会话
 * 数量增长后 ContextMenu、Tooltip、hover hook 等交互树长期占据 DOM。
 */
export function VirtualSidebarList({
  rows,
  className,
  activeRowId,
  overscan = 10,
}: VirtualSidebarListProps): React.ReactElement {
  const parentRef = React.useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => rows[index]?.estimateSize ?? 34,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan,
  })
  const items = virtualizer.getVirtualItems()
  const lastAutoScrolledRowIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!activeRowId) {
      lastAutoScrolledRowIdRef.current = null
      return
    }
    // 列表行会因状态更新或归档加载重建；这些变化不应打断用户手动滚动。
    if (lastAutoScrolledRowIdRef.current === activeRowId) return

    const index = rows.findIndex((row) => row.id === activeRowId)
    if (index < 0) return

    lastAutoScrolledRowIdRef.current = activeRowId
    virtualizer.scrollToIndex(index, { align: 'auto', behavior: 'auto' })
  }, [activeRowId, rows, virtualizer])

  // 滚动容器由不可见（如设置页覆盖时祖先 display:none）恢复可见时，强制重挂载该
  // DOM 节点以逼 react-virtual 重新订阅 ResizeObserver 并同步测量一次真实尺寸。
  // 起因：缩放层级（Ctrl+滚轮）刚变化又叠加 display:none 隐藏期间，Chromium/Electron
  // 的 ResizeObserver 有概率漏报"恢复可见"这次尺寸变化，容器测量停留在 0 高度，
  // 虚拟列表判定视口内无可渲染行，对话列表整体空白。用 key 变化换新节点绕开这个漏报，
  // 不依赖可能失效的 ResizeObserver 回调。
  const [visibilityEpoch, setVisibilityEpoch] = React.useState(0)
  const wasVisibleRef = React.useRef(false)
  const hasObservedRef = React.useRef(false)
  // 重挂载会丢掉滚动位置（新 DOM 节点 scrollTop 归零），这里跨重挂载把它带回来，
  // 否则「进设置页再返回」会把列表弹回顶部——比原 bug 更常被用户碰到。
  const scrollTopBeforeRemountRef = React.useRef(0)

  React.useEffect(() => {
    const node = parentRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      const isVisible = !!entry?.isIntersecting
      if (!hasObservedRef.current) {
        hasObservedRef.current = true
        wasVisibleRef.current = isVisible
        return
      }
      if (isVisible && !wasVisibleRef.current) {
        scrollTopBeforeRemountRef.current = parentRef.current?.scrollTop ?? 0
        setVisibilityEpoch((n) => n + 1)
      }
      wasVisibleRef.current = isVisible
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [visibilityEpoch])

  React.useLayoutEffect(() => {
    if (visibilityEpoch === 0) return
    const node = parentRef.current
    const saved = scrollTopBeforeRemountRef.current
    if (node && saved > 0) node.scrollTop = saved
  }, [visibilityEpoch])

  return (
    <div key={visibilityEpoch} ref={parentRef} className={cn('min-h-0 overflow-y-auto scrollbar-thin titlebar-no-drag', className)}>
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {items.map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.content}
            </div>
          )
        })}
      </div>
    </div>
  )
}
