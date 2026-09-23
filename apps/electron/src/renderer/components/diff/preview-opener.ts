/**
 * useOpenPreview — 统一的预览入口 Hook
 *
 * 把分散在 SidePanel / PreviewOpenButton / AgentView 等处的「打开预览」逻辑收敛到一处。
 * 文件、Markdown 与 Diff 一律在右侧工作区的预览 Tab 打开，不再占用主内容区。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import {
  getPreviewContentRefreshKey,
  getPreviewFileId,
  previewContentRefreshVersionAtom,
  previewFileMapAtom,
  previewFilesMapAtom,
  previewPanelOpenMapAtom,
  type PreviewFile,
} from '@/atoms/preview-atoms'
import {
  activeTabIdAtom,
  closeTab,
  isPreviewTab,
  sessionViewStateMapAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, getPreviewSidePanelTab, pinSidePanelTabByUserAtom } from '@/atoms/agent-atoms'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/** 兼容旧调用方；右侧工作区方案下不再使用 mode。 */
export interface OpenPreviewOptions {
  mode?: 'tab' | 'split'
}

/**
 * 递增某个预览的内容版本，强制下次渲染绕过 DiffTabContent 的 LRU 内容缓存。
 *
 * 缓存 key 形如 `${sessionId}:preview:${filePath}@v${版本}:${scope}`，版本不变就一直命中旧条目。
 */
export function bumpPreviewContentRefreshInStore(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  const key = getPreviewContentRefreshKey(sessionId, file)
  store.set(previewContentRefreshVersionAtom, (previous) => {
    const next = new Map(previous)
    next.set(key, (previous.get(key) ?? 0) + 1)
    return next
  })
}

/**
 * 在指定会话的右侧工作区中打开并聚焦文件预览。
 *
 * 供 React Hook 和 IPC 事件处理器共同复用，保证计划审批等外部事件不会绕过预览 Tab 的状态约定。
 *
 * ⚠️ 打开动作**必须**同时递增内容版本（0.18.67 修维护者报障）：预览 Tab 已是当前 Tab 时，
 * 重复打开同一文件只是把同样的值写回 atom，React 既不重挂载也不重读盘，用户看到的
 * 永远是上次的内容——表现为「点了那个文件还是旧的，只有点刷新才更新」。计划文档预览
 * 当初单独打过同样的补丁，这里推广到所有入口。
 */
export function openPreviewInStore(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  const previewId = getPreviewFileId(file)
  store.set(previewFilesMapAtom, (prev) => {
    const next = new Map(prev)
    const files = next.get(sessionId) ?? []
    // 同一预览身份再次打开时保留 Tab 顺序，但采用最新权限、根目录与解析上下文。
    // 否则先以只读/Skill 上下文打开后会永久复用过期元数据。
    const existingIndex = files.findIndex((item) => getPreviewFileId(item) === previewId)
    next.set(sessionId, existingIndex === -1
      ? [...files, file]
      : files.map((item, index) => index === existingIndex ? file : item))
    return next
  })
  store.set(previewFileMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, file)
    return next
  })
  store.set(previewPanelOpenMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  // 所有入口都复用同一右侧工作区，并以会话为粒度隔离预览状态。
  // 预览的两个入口都由用户点击触发，按手动表态锁死焦点（维护者 2026-09-20）
  store.set(pinSidePanelTabByUserAtom, { sessionId, tab: getPreviewSidePanelTab(previewId) })
  store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  store.set(agentDiffPanelTabAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, getPreviewSidePanelTab(previewId))
    return next
  })
  bumpPreviewContentRefreshInStore(store, sessionId, file)
}

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile, _options?: OpenPreviewOptions) => {
      openPreviewInStore(store, sessionId, file)
    },
    [store],
  )
}

/**
 * tearOffPreviewToSplit — 兼容旧 preview Tab：将其迁入右侧工作区预览。
 *
 * 保留此导出供旧的拖拽和预览 Tab 操作调用；新预览不会再创建主内容区 Tab。
 */
export function tearOffPreviewToSplit(store: JotaiStore, tabId: string): void {
  const tabs = store.get(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || !isPreviewTab(tab)) return

  const sessionId = tab.sessionId

  const agentTab = tabs.find((t) => t.type === 'agent' && t.sessionId === sessionId)
  if (!agentTab) return

  // 关闭旧 preview Tab，并激活对应 Agent 会话，让右侧工作区可见
  const closed = closeTab(store.get(tabsAtom), store.get(activeTabIdAtom), tabId)
  store.set(tabsAtom, closed.tabs)
  store.set(activeTabIdAtom, agentTab.id)

  // 标记会话视图为 session，避免切走再切回时重建 preview Tab
  store.set(sessionViewStateMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, { previewTabOpen: false, lastView: 'session' })
    return m
  })

  store.set(previewPanelOpenMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  store.set(pinSidePanelTabByUserAtom, { sessionId, tab: 'preview' })
  store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  store.set(agentDiffPanelTabAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, 'preview')
    return next
  })
}
