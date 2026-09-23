/**
 * DiffPanelTabBar — 右侧工作区的统一顶栏。
 *
 * 文件、改动、预览、问答和每个浏览器网页位于同一层级；网页不再拥有嵌套 Tab 栏。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { getRightWorkspaceDropIndex, getScrollLeftFromThumbDrag, getTabShiftOffsets } from '@/lib/right-workspace-tab-order'

/** 与浏览器标签页一致：移动超过这点距离就认为在拖，而不是点击。 */
const DRAG_START_THRESHOLD = 5
import { Blocks, Brain, CalendarDays, Clock, Columns2, FolderOpen, Globe, ListTodo, MessageCircle, PanelRight, Plus, Repeat2, ServerCog, SquareTerminal, X } from 'lucide-react'
import { OBSIDIAN_NAME, ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { cn } from '@/lib/utils'
import { getScrollLeftToRevealTab } from '@/lib/tab-visibility'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { agentDiffUnseenChangesAtom, agentUnreadSidePanelTabsAtom, currentAgentSessionIdAtom, pinSidePanelTabByUserAtom } from '@/atoms/agent-atoms'
import type { AgentSidePanelTab, WorkspaceComponentTab } from '@/atoms/agent-atoms'
import { groupRightWorkspaceTabs, type RightWorkspacePane } from '@/lib/right-workspace-split'
import { getRightPanelTabCloseButtonClassName } from './right-panel-tab-close-button'
import type { ProductivityToolsSettings } from '@/types/settings'

export interface RightWorkspaceTabDragState {
  tabId: AgentSidePanelTab
  clientX: number
  clientY: number
}

export interface WorkspacePanelTab {
  id: AgentSidePanelTab
  label: string
  icon: React.ReactNode
  closable?: boolean
  activity?: boolean
  /**
   * 悬停提示。预览标签用它显示完整路径——预览工具行不再重复文件名后，
   * 这里是全路径唯一的出口（此前挂在那一行的文件名 span 上）。
   */
  title?: string
}

interface DiffPanelTabBarProps {
  tabs: WorkspacePanelTab[]
  activeTab: AgentSidePanelTab
  onTabChange: (tab: AgentSidePanelTab) => void
  onCloseTab: (tab: AgentSidePanelTab) => void
  onOpenBrowser: () => void
  /** 加号菜单是否展开；供原生浏览器视图临时避让。 */
  onAddTabMenuOpenChange?: (open: boolean) => void
  onOpenFile: () => void
  onOpenTerminal?: () => void
  onOpenWorkspaceComponent?: (component: WorkspaceComponentTab) => void
  onOpenVault?: () => void
  productivityTools?: ProductivityToolsSettings
  onOpenChat?: () => void
  /** 仅当前右侧 Tab 需要的紧凑动作，渲染于标签列表之后，不影响内容区布局。 */
  activeTabAction?: React.ReactNode
  visibleTabs?: Partial<Record<RightWorkspacePane, AgentSidePanelTab>>
  focusedPane?: RightWorkspacePane
  /** 标签栏内横向拖动改顺序（拖出栏向下仍走分屏，见 onTabDrop）。 */
  onReorderTab?: (tab: AgentSidePanelTab, toIndex: number) => void
  onTabDragChange?: (state: RightWorkspaceTabDragState | null) => void
  onTabDrop?: (state: RightWorkspaceTabDragState) => void
  onSplitTab?: (tab: AgentSidePanelTab, pane: RightWorkspacePane) => void
  onCollapseSplit?: () => void
  onClose?: () => void
}

export function DiffPanelTabBar({
  tabs,
  activeTab,
  onTabChange,
  onCloseTab,
  onOpenBrowser,
  onAddTabMenuOpenChange,
  onOpenFile,
  onOpenTerminal,
  onOpenWorkspaceComponent,
  onOpenVault,
  productivityTools = { todosEnabled: true, calendarEnabled: true, obsidianEnabled: true },
  onOpenChat,
  activeTabAction,
  visibleTabs,
  focusedPane,
  onReorderTab,
  onTabDragChange,
  onTabDrop,
  onSplitTab,
  onCollapseSplit,
  onClose,
}: DiffPanelTabBarProps): React.ReactElement {
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const pinSidePanelTabByUser = useSetAtom(pinSidePanelTabByUserAtom)
  const unreadTabsMap = useAtomValue(agentUnreadSidePanelTabsAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  /** 本会话「有动静但没抢焦点」的标签，用于在标签上标未读点 */
  const unreadTabs = currentSessionId ? unreadTabsMap.get(currentSessionId) : undefined
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const [isAddTabMenuOpen, setIsAddTabMenuOpen] = React.useState(false)
  const [isSplitTabGroupHovered, setIsSplitTabGroupHovered] = React.useState(false)
  // 仅鼠标在菜单外取消时抑制 Radix 的回焦；Esc 与键盘选择必须保留可见焦点。
  const suppressPointerDismissFocusRestoreRef = React.useRef(false)
  const tabListRef = React.useRef<HTMLDivElement>(null)
  /** 排序拖动中的插入位置（null = 未在排序）。 */
  const [reorderDropIndex, setReorderDropIndex] = React.useState<number | null>(null)
  /** 正在被拖动的标签 id 与它的水平位移（跟手效果）。 */
  const [draggingTabId, setDraggingTabId] = React.useState<AgentSidePanelTab | null>(null)
  const [dragOffsetX, setDragOffsetX] = React.useState(0)
  /** 拖动中其余标签的让位位移（下标 → px），实现 Chrome 那样的实时重排。 */
  const [shiftOffsets, setShiftOffsets] = React.useState<Map<number, number>>(new Map())
  /** 标签栏横向滚动指示条：{可视比例, 已滚比例}；未溢出时为 null。 */
  const [scrollHint, setScrollHint] = React.useState<{ ratio: number; progress: number } | null>(null)
  const scrollTrackRef = React.useRef<HTMLDivElement>(null)
  const [scrollThumbDragging, setScrollThumbDragging] = React.useState(false)

  /** 滚动条：点轨道跳转、拖滑块滚动。 */
  const handleScrollTrackPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const tabList = tabListRef.current
    const track = scrollTrackRef.current
    if (event.button !== 0 || !tabList || !track) return
    event.preventDefault()
    // 不能冒泡到标签：否则会触发切换 + getScrollLeftToRevealTab 的自动回滚
    event.stopPropagation()

    const trackRect = track.getBoundingClientRect()
    const maxScrollLeft = tabList.scrollWidth - tabList.clientWidth
    const ratio = tabList.clientWidth / tabList.scrollWidth
    const thumbWidth = Math.max(ratio, 0.12) * trackRect.width
    const thumbLeft = trackRect.left + (tabList.scrollLeft / Math.max(maxScrollLeft, 1)) * (trackRect.width - thumbWidth)
    const onThumb = event.clientX >= thumbLeft && event.clientX <= thumbLeft + thumbWidth

    // 点在轨道空白处：先把滑块中心跳到点击点，再进入拖动
    let startScrollLeft = tabList.scrollLeft
    if (!onThumb) {
      const target = ((event.clientX - trackRect.left - thumbWidth / 2) / Math.max(trackRect.width - thumbWidth, 1)) * maxScrollLeft
      startScrollLeft = Math.max(0, Math.min(maxScrollLeft, target))
      tabList.scrollLeft = startScrollLeft
    }

    const startX = event.clientX
    setScrollThumbDragging(true)
    const handleMove = (moveEvent: PointerEvent): void => {
      tabList.scrollLeft = getScrollLeftFromThumbDrag(
        moveEvent.clientX - startX,
        trackRect.width,
        thumbWidth,
        startScrollLeft,
        maxScrollLeft,
      )
    }
    const finish = (): void => {
      setScrollThumbDragging(false)
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
    }
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }, [])
  /** 供拖拽闭包读取当前渲染顺序（orderedTabs 在其后定义，用 ref 避免闭包捕获旧值）。 */
  const orderedTabsRef = React.useRef<WorkspacePanelTab[]>([])
  const tabRefs = React.useRef(new Map<AgentSidePanelTab, HTMLDivElement>())
  const barRef = React.useRef<HTMLDivElement>(null)
  const suppressClickTabRef = React.useRef<AgentSidePanelTab | null>(null)
  const activeTabDragCancelRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => () => onAddTabMenuOpenChange?.(false), [onAddTabMenuOpenChange])
  React.useEffect(() => () => activeTabDragCancelRef.current?.(), [])
  React.useEffect(() => {
    if (!visibleTabs?.left || !visibleTabs.right) setIsSplitTabGroupHovered(false)
  }, [visibleTabs?.left, visibleTabs?.right])

  const handleAddTabMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) suppressPointerDismissFocusRestoreRef.current = false
    setIsAddTabMenuOpen(open)
    onAddTabMenuOpenChange?.(open)
  }, [onAddTabMenuOpenChange])

  // 溢出时在标签栏底部显示一条细滚动指示条：既告诉用户「右边还有」，也指示当前位置。
  React.useEffect(() => {
    const tabList = tabListRef.current
    if (!tabList) return
    const update = (): void => {
      const { scrollWidth, clientWidth, scrollLeft } = tabList
      const overflow = scrollWidth - clientWidth
      if (overflow <= 1) {
        setScrollHint(null)
        return
      }
      setScrollHint({
        ratio: clientWidth / scrollWidth,
        progress: Math.min(1, Math.max(0, scrollLeft / overflow)),
      })
    }
    update()
    tabList.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(tabList)
    return () => {
      tabList.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [tabs.length])

  // 标签溢出时用滚轮横向滚动（与顶部主标签栏 TabBar 行为一致）。
  // 实测右侧工作区常开到 11 个标签、需要 1630px 而可见仅 878px，此前只能靠
  // 「切到某标签时自动滚出来」被动移动，鼠标滚轮完全没反应。
  // 必须走 addEventListener + passive:false —— React 的 onWheel 是 passive 的，preventDefault 无效。
  React.useEffect(() => {
    const tabList = tabListRef.current
    if (!tabList) return
    const handleWheel = (event: WheelEvent): void => {
      if (tabList.scrollWidth <= tabList.clientWidth) return
      event.preventDefault()
      tabList.scrollLeft += event.deltaY || event.deltaX
    }
    tabList.addEventListener('wheel', handleWheel, { passive: false })
    return () => tabList.removeEventListener('wheel', handleWheel)
  }, [])

  React.useLayoutEffect(() => {
    const tabList = tabListRef.current
    const activeTabElement = tabRefs.current.get(activeTab)
    if (!tabList || !activeTabElement) return

    const nextScrollLeft = getScrollLeftToRevealTab(tabList, activeTabElement)
    if (nextScrollLeft !== tabList.scrollLeft) {
      tabList.scrollTo({ left: nextScrollLeft, behavior: 'smooth' })
    }
  }, [activeTab, tabs.length])

  const selectTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (suppressClickTabRef.current === tab) {
      suppressClickTabRef.current = null
      return
    }
    if (tab === 'changes' && currentSessionId) {
      setUnseenMap((previous) => {
        if (previous.get(currentSessionId) === false) return previous
        const next = new Map(previous)
        next.set(currentSessionId, false)
        return next
      })
    }
    // 用户手点标签 = 表态「我要看这个」：锁死本会话焦点，Agent 此后一次都不许抢，
    // 同时清掉该标签的未读点（维护者 2026-09-20）
    if (currentSessionId) pinSidePanelTabByUser({ sessionId: currentSessionId, tab })
    onTabChange(tab)
  }, [currentSessionId, onTabChange, pinSidePanelTabByUser, setUnseenMap])

  const beginTabDrag = React.useCallback((tabId: AgentSidePanelTab, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !onTabDragChange || !onTabDrop) return
    activeTabDragCancelRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    // 是否已向上游发布过分屏拖拽状态（用于在两种意图间切换时正确收起预览）
    let splitPreviewOn = false
    let frame = 0
    let latestState: RightWorkspaceTabDragState = { tabId, clientX: startX, clientY: startY }
    const target = event.currentTarget

    const cleanup = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.removeEventListener('pointercancel', handleCancel)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('blur', cancel)
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* 节点已卸载 */ }
      if (activeTabDragCancelRef.current === cancel) activeTabDragCancelRef.current = null
    }
    const cancel = () => {
      cleanup()
      suppressClickTabRef.current = null
      setReorderDropIndex(null)
      setDragOffsetX(0)
      setDraggingTabId(null)
      setShiftOffsets(new Map())
      if (splitPreviewOn) onTabDragChange(null)
    }
    const publishDrag = () => {
      frame = 0
      onTabDragChange(latestState)
    }
    // 注意：被拖标签带着 translateX 跟手，getBoundingClientRect 拿到的是**位移后**的框，
    // 直接用会把命中判定整体带歪（实测松手在第 3 个标签上却算出 dropIndex=0）。
    // 这里把被拖标签的框按当前位移还原回原位再参与判定。
    const computeDropIndex = (clientX: number, offsetX: number): number => {
      const boxes = orderedTabsRef.current.map((tab) => {
        const el = tabRefs.current.get(tab.id)
        const rect = el?.getBoundingClientRect()
        const shift = tab.id === tabId ? offsetX : 0
        return { id: tab.id, left: (rect?.left ?? 0) - shift, right: (rect?.right ?? 0) - shift }
      })
      return getRightWorkspaceDropIndex(boxes, clientX)
    }

    const handleMove = (moveEvent: PointerEvent) => {
      latestState = { tabId, clientX: moveEvent.clientX, clientY: moveEvent.clientY }
      const rect = barRef.current?.getBoundingClientRect()
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY

      // 浏览器标签页的手感：只要移动超过很小的阈值就「跟手」，不预先锁定意图。
      // 到底是排序还是分屏，等松手时按指针位置决定（见 handleUp）。
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return
        dragging = true
        suppressClickTabRef.current = tabId
        setDraggingTabId(tabId)
      }

      // 指针还在标签栏（含下缘 12px 容差）内 → 排序意图：标签跟随光标 + 显示插入位置
      const insideBar = !rect || moveEvent.clientY <= rect.bottom + 12
      if (insideBar && onReorderTab) {
        const dropIndex = computeDropIndex(moveEvent.clientX, dx)
        setDragOffsetX(dx)
        setReorderDropIndex(dropIndex)
        // 其余标签实时让位：被拖标签的占位宽度＝自身宽 + 间距（gap-1.5 = 6px）
        const fromIndex = orderedTabsRef.current.findIndex((t) => t.id === tabId)
        const slotWidth = (tabRefs.current.get(tabId)?.getBoundingClientRect().width ?? 0) + 6
        setShiftOffsets(getTabShiftOffsets(orderedTabsRef.current.length, fromIndex, dropIndex, slotWidth))
        if (splitPreviewOn) {
          splitPreviewOn = false
          onTabDragChange(null)
        }
        return
      }

      // 拖出标签栏 → 分屏意图：收起排序预览，交给上游的分屏落点高亮
      setDragOffsetX(0)
      setReorderDropIndex(null)
      setShiftOffsets(new Map())
      splitPreviewOn = true
      if (!frame) frame = requestAnimationFrame(publishDrag)
    }
    const handleUp = () => {
      cleanup()
      const wasDragging = dragging
      const rect = barRef.current?.getBoundingClientRect()
      const insideBar = !rect || latestState.clientY <= rect.bottom + 12
      setDragOffsetX(0)
      setDraggingTabId(null)
      setReorderDropIndex(null)
      setShiftOffsets(new Map())
      if (!wasDragging) return

      if (insideBar && onReorderTab) {
        onReorderTab(tabId, computeDropIndex(latestState.clientX, latestState.clientX - startX))
      } else {
        onTabDrop(latestState)
      }
      if (splitPreviewOn) onTabDragChange(null)
      window.setTimeout(() => {
        if (suppressClickTabRef.current === tabId) suppressClickTabRef.current = null
      }, 0)
    }
    const handleCancel = () => cancel()
    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      cancel()
    }

    activeTabDragCancelRef.current = cancel
    target.setPointerCapture(pointerId)
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleCancel)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('blur', cancel)
  }, [onReorderTab, onTabDragChange, onTabDrop])

  const orderedTabs = React.useMemo(() => {
    if (!visibleTabs?.left || !visibleTabs.right) return tabs
    return groupRightWorkspaceTabs(tabs, visibleTabs.left, visibleTabs.right)
  }, [tabs, visibleTabs?.left, visibleTabs?.right])
  orderedTabsRef.current = orderedTabs

  // 背景跟随所在面板：右面板主体在现代风走 --sidebar-surface（辅助层），标签栏若继续
  // 钉死 bg-content-area 就比主体更亮、像浮在上面一层——维护者 2026-09-09 报「右边文件的
  // 滚动条上方没有对比，看着很怪」。改为不画背景、直接透出所在面板底色；经典风下透出的
  // 仍是 content-area，行为不变。（不能用 bg-[inherit]：中间隔着一层透明容器，
  // inherit 只会继承到那层的透明。）
  return (
    <div ref={barRef} className="right-panel-tabbar relative flex h-10 shrink-0 items-center border-b border-border/60">
      <div className="pointer-events-none absolute inset-0 titlebar-drag-region" />
      <div className="relative flex min-w-0 flex-1 items-center titlebar-no-drag">
        <div ref={tabListRef} className="relative flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain px-2 py-1 scrollbar-none" role="tablist" aria-label="右侧工作区">
          {orderedTabs.map((tab, tabIndex) => {
            // 排序拖动中：落点在该标签之前 → 左侧竖条；正在被拖的标签 → 半透明
            const dropBefore = reorderDropIndex === tabIndex
            const isDraggingThisTab = draggingTabId === tab.id
            const selected = activeTab === tab.id
            const isSplitView = visibleTabs?.left !== undefined && visibleTabs.right !== undefined
            const visiblePane = visibleTabs?.left === tab.id ? 'left' : visibleTabs?.right === tab.id ? 'right' : null
            const isSplitTab = isSplitView && visiblePane !== null
            const isFirstSplitTab = isSplitTab && visiblePane === 'left'
            const isLastSplitTab = isSplitTab && visiblePane === 'right'
            const isChangesTab = tab.id === 'changes'
            const isSharedSplitClose = isLastSplitTab && onCollapseSplit !== undefined
            const showsIndividualClose = Boolean(tab.closable && !isSplitTab)
            const tabNode = (
              <div
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element)
                  else tabRefs.current.delete(tab.id)
                }}
                  style={
                  isDraggingThisTab
                    ? { transform: `translateX(${dragOffsetX}px)` }
                    : shiftOffsets.has(tabIndex)
                      ? { transform: `translateX(${shiftOffsets.get(tabIndex)}px)`, transition: 'transform 160ms ease' }
                      : undefined
                }
                  className={cn(
                    'group flex h-7 min-w-[84px] max-w-60 shrink-0 items-center transition-[background-color,color,box-shadow] duration-150',
                    // 排序拖动中：落点在本标签之前 → 左侧竖条；正被拖动的标签 → 半透明
                    dropBefore && 'shadow-[inset_2px_0_0_0_hsl(var(--primary))]',
                    // 跟手中的标签：浮起、压过邻居、去掉过渡以免追不上光标
                    isDraggingThisTab && 'relative z-20 opacity-90 shadow-lg !transition-none',
                    isSplitTab
                      ? cn(
                          'bg-foreground/[0.055] text-foreground/90',
                          isFirstSplitTab && 'rounded-l-lg',
                          isLastSplitTab && 'rounded-r-lg',
                          !isFirstSplitTab && '-ml-1.5',
                        )
                      : cn(
                          'rounded-lg',
                          selected && !isSplitView
                            ? 'bg-foreground/[0.08] text-foreground'
                            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                        ),
                  )}
                data-visible-pane={visiblePane ?? undefined}
                onPointerEnter={() => { if (isSplitTab) setIsSplitTabGroupHovered(true) }}
                onPointerLeave={() => { if (isSplitTab) setIsSplitTabGroupHovered(false) }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-description={visiblePane ? `显示在${visiblePane === 'left' ? '左侧' : '右侧'} Pane` : undefined}
                  onClick={() => selectTab(tab.id)}
                  onPointerDown={(event) => beginTabDrag(tab.id, event)}
                  title={tab.title}
                  className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 text-left text-[13px] outline-none"
                >
                  {tab.activity || (isChangesTab && unseenChanges && !selected) || (unreadTabs?.has(tab.id) && !selected) ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="有未查看更新" />
                  ) : (
                    <span className={cn('shrink-0', selected ? 'text-foreground' : 'text-muted-foreground/80')}>{tab.icon}</span>
                  )}
                  <span className="truncate">{tab.label}</span>
                </button>
                {(showsIndividualClose || isSharedSplitClose) && (
                  <button
                    type="button"
                    onClick={isSharedSplitClose ? onCollapseSplit : () => onCloseTab(tab.id)}
                    // 位置常驻、只变透明度：悬停不能改变标签宽度，否则滚轮滚动标签条时整条会抖（见 right-panel-tab-close-button.ts）
                    className={getRightPanelTabCloseButtonClassName({
                      sharedSplit: isSharedSplitClose,
                      selected,
                      groupHovered: isSplitTabGroupHovered,
                    })}
                    aria-label={isSharedSplitClose ? '退出并排，保留两个标签' : `关闭 ${tab.label}`}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )
            return onSplitTab ? (
              <ContextMenu key={tab.id}>
                <Tooltip delayDuration={700}>
                  <TooltipTrigger asChild>
                    <ContextMenuTrigger asChild>{tabNode}</ContextMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">向下拖拽以并排查看</TooltipContent>
                </Tooltip>
                <ContextMenuContent className="min-w-40">
                  <ContextMenuItem disabled={tab.id === activeTab && !visibleTabs} onSelect={() => onSplitTab(tab.id, 'left')}>
                    在左侧并排
                  </ContextMenuItem>
                  <ContextMenuItem disabled={tab.id === activeTab && !visibleTabs} onSelect={() => onSplitTab(tab.id, 'right')}>
                    在右侧并排
                  </ContextMenuItem>
                  {visibleTabs?.left && visibleTabs.right && onCollapseSplit && (
                    <ContextMenuItem onSelect={onCollapseSplit}>
                      退出并排，保留当前标签
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ) : <React.Fragment key={tab.id}>{tabNode}</React.Fragment>
          })}
        </div>
        {/* 可拖动的横向滚动条：宽度＝可视比例、位置＝滚动进度；不溢出时不渲染。
            轨道可点击跳转，滑块可直接拖。加大命中高度（h-2.5）但视觉只有 2px 细条。 */}
        {scrollHint && (
          <div
            ref={scrollTrackRef}
            // 与标签列表同宽（不覆盖右侧的 + / 并排等按钮）；位于滚动容器外，不随内容平移
            style={{ width: tabListRef.current?.clientWidth ?? undefined }}
            className="absolute bottom-0 left-0 flex h-3.5 cursor-pointer items-end px-2"
            onPointerDown={handleScrollTrackPointerDown}
          >
            <div className="relative h-1.5 w-full rounded-full bg-foreground/[0.08]">
              <div
                className={cn(
                  'absolute inset-y-0 rounded-full bg-foreground/25 hover:bg-foreground/40',
                  scrollThumbDragging ? 'bg-foreground/50' : 'transition-[left,width] duration-150',
                )}
                style={{
                  width: `${Math.max(scrollHint.ratio * 100, 12)}%`,
                  left: `${scrollHint.progress * (100 - Math.max(scrollHint.ratio * 100, 12))}%`,
                }}
              />
            </div>
          </div>
        )}
        {activeTabAction && <div className="ml-1 flex shrink-0 items-center titlebar-no-drag">{activeTabAction}</div>}
        {visibleTabs?.left && visibleTabs.right && onCollapseSplit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="mr-1 inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2 text-foreground transition-[background-color,color,transform] hover:bg-muted active:scale-[0.96]"
                onClick={onCollapseSplit}
                aria-label="退出并排，保留当前标签"
              >
                <Columns2 className="size-3.5" />
                <span className="text-[11px]">退出并排</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">退出并排，保留当前标签</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu open={isAddTabMenuOpen} onOpenChange={handleAddTabMenuOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
                  aria-label="添加右侧工作区标签"
                >
                  <Plus className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">添加标签</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            className="z-[100] min-w-40 titlebar-no-drag"
            onPointerDownOutside={() => { suppressPointerDismissFocusRestoreRef.current = true }}
            onCloseAutoFocus={(event) => {
              if (!suppressPointerDismissFocusRestoreRef.current) return
              suppressPointerDismissFocusRestoreRef.current = false
              event.preventDefault()
            }}
          >
            <DropdownMenuItem onSelect={onOpenBrowser}>
              <Globe className="size-3.5" />
              新建浏览器标签
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenFile}>
              <FolderOpen className="size-3.5" />
              打开文件
            </DropdownMenuItem>
            {onOpenTerminal && (
              <DropdownMenuItem onSelect={onOpenTerminal}>
                <SquareTerminal className="size-3.5" />
                新建终端
              </DropdownMenuItem>
            )}
            {onOpenWorkspaceComponent && (
              <>
                <DropdownMenuSeparator />
                {productivityTools.todosEnabled && (
                  <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('todos')}>
                    <ListTodo className="size-3.5" />
                    打开 Todo
                  </DropdownMenuItem>
                )}
                {productivityTools.calendarEnabled && (
                  <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('calendar')}>
                    <CalendarDays className="size-3.5" />
                    打开日程
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('skills')}>
                  <Blocks className="size-3.5" />
                  打开 Skills
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('mcp')}>
                  <ServerCog className="size-3.5" />
                  打开 MCP
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('memory')}>
                  <Brain className="size-3.5" />
                  打开项目记忆
                </DropdownMenuItem>
              </>
            )}
            {onOpenChat && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenChat}>
                  <MessageCircle className="size-3.5" />
                  打开问答
                </DropdownMenuItem>
              </>
            )}
            {onOpenWorkspaceComponent && (
              <DropdownMenuItem onSelect={() => onOpenWorkspaceComponent('automations')}>
                <Clock className="size-3.5" />
                打开定时任务
              </DropdownMenuItem>
            )}
            {onOpenVault && (
              <DropdownMenuItem onSelect={onOpenVault}>
                <ObsidianIcon className="size-3.5" />
                打开 {OBSIDIAN_NAME}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClose}
                className="mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
                aria-label="折叠右侧工作区"
              >
                <PanelRight className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">折叠右侧工作区 ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
