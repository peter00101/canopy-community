/**
 * RightSidePanel — 右侧边栏容器
 *
 * 在 Agent 模式下显示文件面板，样式与 LeftSidebar 一致。
 * 从全局 atom 读取当前会话 ID 和路径。
 * 管理「文件 / 代码改动」视图；文件中包含会话文件与项目文件。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import {
  currentAgentSessionIdAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
  agentTerminalTabsAtom,
  getTerminalSidePanelTab,
  getBrowserSidePanelTab,
  getPreviewSidePanelTab,
  tryStealSidePanelFocusAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { SidePanel } from '@/components/agent/SidePanel'
import { browserFocusRequestMapAtom, browserPanelOpenMapAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import { getPreviewFileId, previewFileMapAtom } from '@/atoms/preview-atoms'

export function RightSidePanel({ width }: { width?: number }): React.ReactElement | null {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const setTerminalTabsMap = useSetAtom(agentTerminalTabsAtom)
  // 面板展开交给 tryStealSidePanelFocus 统一处理，这里不再单独 set
  const tryStealSidePanelFocus = useSetAtom(tryStealSidePanelFocusAtom)
  const browserOpenMap = useAtomValue(browserPanelOpenMapAtom)
  const browserStateMap = useAtomValue(browserStateMapAtom)
  const browserFocusRequestMap = useAtomValue(browserFocusRequestMapAtom)
  const setBrowserFocusRequestMap = useSetAtom(browserFocusRequestMapAtom)
  const browserOpen = currentSessionId ? browserOpenMap.get(currentSessionId) === true : false
  const browserState = currentSessionId ? browserStateMap.get(currentSessionId) ?? null : null
  const browserFocusRequestTabId = currentSessionId ? browserFocusRequestMap.get(currentSessionId) ?? null : null
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const currentPreviewFile = currentSessionId ? previewFileMap.get(currentSessionId) ?? null : null
  const previousBrowserStateRef = React.useRef<{ sessionId: string | null; open: boolean }>({ sessionId: null, open: false })
  const pendingBrowserActivationRef = React.useRef<string | null>(null)

  const setActiveTab = React.useCallback((tab: AgentSidePanelTab) => {
    if (!currentSessionId) return
    setDiffPanelTabMap((prev) => {
      const map = new Map(prev)
      map.set(currentSessionId, tab)
      return map
    })
  }, [currentSessionId, setDiffPanelTabMap])

  // 浏览器 / 终端打开时是否切过去，统一交给 tryStealSidePanelFocus 判定。
  // 原先这里无条件切（注释写的是「即使当前浏览器已打开，也应切换到那个新网页」），
  // 用户正看着「改动」照样被抢走——维护者 2026-09-20 点名推翻该设计。
  React.useEffect(() => {
    const unsubscribeOpen = window.electronAPI.onAgentTerminalOpen((event) => {
      setTerminalTabsMap((previous) => {
        const current = previous.get(event.sessionId) ?? []
        if (current.some((terminal) => terminal.terminalId === event.terminalId)) return previous
        const next = new Map(previous)
        next.set(event.sessionId, [...current, { terminalId: event.terminalId, title: event.title, cwd: event.cwd }])
        return next
      })
      // 不再无条件抢标签：用户手点过标签就只加标签 + 标未读（维护者 2026-09-20）
      tryStealSidePanelFocus({
        sessionId: event.sessionId,
        source: 'terminal',
        tab: getTerminalSidePanelTab(event.terminalId),
      })
    })
    const unsubscribeClose = window.electronAPI.onAgentTerminalClose((event) => {
      setTerminalTabsMap((previous) => {
        const current = previous.get(event.sessionId) ?? []
        const remaining = current.filter((terminal) => terminal.terminalId !== event.terminalId)
        if (remaining.length === current.length) return previous
        const next = new Map(previous)
        if (remaining.length > 0) next.set(event.sessionId, remaining)
        else next.delete(event.sessionId)
        return next
      })
      if (event.sessionId !== currentSessionId) return
      setDiffPanelTabMap((previous) => {
        if (previous.get(event.sessionId) !== getTerminalSidePanelTab(event.terminalId)) return previous
        const next = new Map(previous)
        next.set(event.sessionId, 'files')
        return next
      })
    })
    return () => {
      unsubscribeOpen()
      unsubscribeClose()
    }
  }, [currentSessionId, setDiffPanelTabMap, setTerminalTabsMap, tryStealSidePanelFocus])

  React.useEffect(() => {
    const previous = previousBrowserStateRef.current
    const openedInCurrentSession = previous.sessionId === currentSessionId && !previous.open && browserOpen
    previousBrowserStateRef.current = { sessionId: currentSessionId, open: browserOpen }
    if (openedInCurrentSession && currentSessionId) pendingBrowserActivationRef.current = currentSessionId

    if (!currentSessionId || !browserState) return
    if (browserFocusRequestTabId && !browserState.tabs.some((tab) => tab.tabId === browserFocusRequestTabId)) {
      setBrowserFocusRequestMap((previous) => {
        if (!previous.has(currentSessionId)) return previous
        const next = new Map(previous)
        next.delete(currentSessionId)
        return next
      })
      return
    }
    const targetTabId = browserFocusRequestTabId
      ?? (pendingBrowserActivationRef.current === currentSessionId ? browserState.activeTabId : null)
    if (!targetTabId) return

    // 浏览器同样走统一判定：Agent 连开多个网页时只抢第一次，用户手点过则一次都不抢
    tryStealSidePanelFocus({
      sessionId: currentSessionId,
      source: 'browser',
      tab: getBrowserSidePanelTab(targetTabId),
    })
    if (browserFocusRequestTabId) {
      setBrowserFocusRequestMap((previous) => {
        if (previous.get(currentSessionId) !== targetTabId) return previous
        const next = new Map(previous)
        next.delete(currentSessionId)
        return next
      })
    }
    pendingBrowserActivationRef.current = null
  }, [browserFocusRequestTabId, browserOpen, browserState?.activeTabId, browserState?.tabs, currentSessionId, setBrowserFocusRequestMap, tryStealSidePanelFocus])

  if (appMode !== 'agent' || !currentSessionId) {
    return null
  }

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const storedTab = diffPanelTabMap.get(currentSessionId) ?? 'files'
  // 兼容这次扁平化前内存中的旧“浏览器”工作区值。
  const activeTab: AgentSidePanelTab = storedTab === 'browser'
    ? browserState?.activeTabId ? getBrowserSidePanelTab(browserState.activeTabId) : 'files'
    : storedTab === 'preview'
      ? currentPreviewFile ? getPreviewSidePanelTab(getPreviewFileId(currentPreviewFile)) : 'files'
      : storedTab

  return (
    <SidePanel
      sessionId={currentSessionId}
      sessionPath={sessionPath}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      width={width}
    />
  )
}
