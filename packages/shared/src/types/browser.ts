// 受管浏览器对所有 Agent 会话开放；会话来源只影响 UI 标识。

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewLayout {
  sessionId: string
  tabId?: string
  /** Renderer 全局单调递增代际；主进程忽略晚到的旧布局 IPC。 */
  revision: number
  visible: boolean
  /** overlay 临时遮挡页面时为 true；Slot 仍挂载，session 不应进入 LRU。 */
  preserveSessionOnHide?: boolean
  bounds: BrowserViewBounds
}

export type BrowserExecutionSource = 'user' | 'automation' | 'delegation'

export type BrowserTraceAction = 'navigate' | 'observe' | 'find' | 'wait' | 'click' | 'act' | 'fill' | 'press' | 'hover' | 'drag' | 'scroll' | 'extract' | 'select' | 'upload' | 'dom' | 'script' | 'screenshot' | 'tab' | 'download' | 'export' | 'popup'
export type BrowserOperationStatus = 'dispatched' | 'verified' | 'failed' | 'unknown'

/** 脱敏的浏览器操作账本项；绝不含输入正文、Cookie、截图或脚本全文。 */
export interface BrowserTraceItem {
  id: string
  action: BrowserTraceAction
  summary: string
  at: number
  /** 兼容旧 UI：仅 failed/unknown 为 false。新代码应使用 status。 */
  success: boolean
  status: BrowserOperationStatus
  tabId: string
  domain: string | null
  executionSource: BrowserExecutionSource
}

export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  trace: BrowserTraceItem[]
}

export interface BrowserTabSummary {
  tabId: string
  url: string
  title: string
  /** 页面声明的 HTTP(S) favicon；未提供或加载失败时 renderer 使用默认图标。 */
  favicon?: string
  loading: boolean
  /** 此标签由 Agent 创建（与当前默认工作标签无关）。 */
  openedByAgent: boolean
  /** 此标签由页面 window.open / target=_blank 创建。 */
  openedByPopup: boolean
}

export type BrowserDownloadState = 'in_progress' | 'completed' | 'cancelled' | 'interrupted'

/** 受控下载/导出记录；路径始终位于数据目录内的浏览器下载目录。 */
export interface BrowserDownloadItem {
  id: string
  /** 消毒后的最终文件名（重名已加序号）。 */
  filename: string
  /** 落盘绝对路径；完成前文件可能带临时后缀。 */
  path: string
  /** 触发来源：页面下载（点击/JS）或主动导出 PDF。 */
  source: 'page' | 'pdf-export'
  state: BrowserDownloadState
  receivedBytes: number
  /** 服务端未声明长度时为 0。 */
  totalBytes: number
  startedAt: number
  /** 终态时间；进行中为 null。 */
  finishedAt: number | null
  /** 取消/中断原因（超限、网络错误等），给 UI 与 Agent 解释用。 */
  reason?: string
}

export interface BrowserViewState {
  sessionId: string
  /** 非用户触发时，面板可显示来源并提供停止当前 Agent run 的控制。 */
  executionSource: BrowserExecutionSource
  /** 用户在浏览器面板中查看的 tab。 */
  activeTabId: string
  /** Agent 的默认工作 tab；被用户关闭后为 null，绝不回退到用户标签。 */
  agentTabId: string | null
  tabs: BrowserTabSummary[]
  /** 当前 active tab 的投影，保留扁平字段方便工具和旧 renderer 使用。 */
  url: string
  title: string
  loading: boolean
  visible: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 脱敏的操作账本，始终代表当前会话，非单一显示标签。 */
  trace: BrowserTraceItem[]
  /** 最近一条 Agent 操作，用于用户未查看工作 tab 时的非阻断活动提示。 */
  activity: BrowserTraceItem | null
  /** 本会话的下载与导出记录（最新在前，条数受上限截断）。 */
  downloads: BrowserDownloadItem[]
}

/** 通知 renderer 当前会话的受管浏览器已销毁。 */
export interface BrowserSessionClosed {
  sessionId: string
  closed: true
}

export type BrowserStateChange = BrowserViewState | BrowserSessionClosed

/** 原生 WebContentsView 获得用户焦点；renderer 用它同步双 Pane 焦点与工具栏目标。 */
export interface BrowserTabFocusChange {
  sessionId: string
  tabId: string
}

export interface BrowserNavigateInput {
  sessionId: string
  tabId?: string
  url: string
}

export interface BrowserTabInput {
  sessionId: string
  tabId?: string
}

export interface BrowserCreateTabInput {
  sessionId: string
  url?: string
}

// ===== 受管浏览器默认搜索引擎 =====

/**
 * 受管浏览器的默认搜索引擎。
 *
 * 默认必应：我方用户主要在中国大陆，Google 不可达。上游 #1769 的做法是「先撞 Google、3 秒超时
 * 再回落必应」，对国内用户等于每次开新标签白等 3 秒，我方改为设置项显式选择。
 */
export type BrowserSearchEngineId = 'bing' | 'google'

export interface BrowserSearchEngineDefinition {
  id: BrowserSearchEngineId
  /** 设置页下拉展示名 */
  label: string
  /** 搜索词拼接用的端点 */
  searchUrl: string
  /** 用户新建空白标签页的首页 */
  homeUrl: string
}

export const BROWSER_SEARCH_ENGINES: Record<BrowserSearchEngineId, BrowserSearchEngineDefinition> = {
  bing: { id: 'bing', label: '必应（cn.bing.com）', searchUrl: 'https://cn.bing.com/search', homeUrl: 'https://cn.bing.com/' },
  google: { id: 'google', label: '谷歌（google.com）', searchUrl: 'https://www.google.com/search', homeUrl: 'https://www.google.com/' },
}

/** 下拉选项顺序：默认项在前。 */
export const BROWSER_SEARCH_ENGINE_OPTIONS: readonly BrowserSearchEngineDefinition[] = [
  BROWSER_SEARCH_ENGINES.bing,
  BROWSER_SEARCH_ENGINES.google,
]

export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngineId = 'bing'

export function isBrowserSearchEngineId(value: unknown): value is BrowserSearchEngineId {
  return typeof value === 'string' && value in BROWSER_SEARCH_ENGINES
}
