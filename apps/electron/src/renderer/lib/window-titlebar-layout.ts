export const WINDOW_TITLEBAR_HEIGHT_PX = 32

/**
 * macOS 标题行高度（Chrome 式）：红绿灯与标签栏 / AgentHeader 同住一行，
 * 侧栏、中列、右面板全部从这一行下面开始，互不侵入——侧栏不再为红绿灯留白。
 * 红绿灯（14px 高）由主进程 trafficLightPosition y=11 垂直居中于此行。
 * 40 → 36：维护者 mac 亲看后嫌行偏高，收 4px（2026-08-30 微调）。改这里要同步改主进程 y。
 */
export const MAC_TITLEBAR_HEIGHT_PX = 36

/**
 * 标题行左侧给原生红绿灯的占位宽度：trafficLightPosition x=18 起，三灯跨度 60
 * （14px 灯 + 9px 间距，macOS 26 / SDK 26 度量，进程内读 standardWindowButton 实测），
 * 右侧再留 18 对称 = 96。标签栏 / AgentHeader 从这里开始。改 x=18 要同步改这里。
 */
export const MAC_TRAFFIC_LIGHTS_INSET_PX = 18 + 60 + 18

/**
 * 设置页自绘顶带（`.settings-topband`，35px）里「设置」二字的左起点。
 * 设置页打开时 AppShell 会把 MacTitleRow 整行隐藏、面板按 `absolute inset-0` 铺满整窗，
 * 顶带因此落在 y=0——mac 原生红绿灯（x=18~78、y=11~25）正压在这里，标签必须让开
 * MAC_TRAFFIC_LIGHTS_INSET_PX；Windows 的窗口按钮在右侧（拖拽区已按 getWindowTitlebarDragInsetStyle
 * 右让 138px），标签沿用原来的 24px。
 */
export const SETTINGS_TOP_BAND_LABEL_INSET_PX = 24

export function getSettingsTopBandLabelInsetPx(isMac: boolean): number {
  return isMac ? MAC_TRAFFIC_LIGHTS_INSET_PX : SETTINGS_TOP_BAND_LABEL_INSET_PX
}

export const WINDOW_TITLEBAR_CONTROL_COUNT = 3
export const WINDOW_TITLEBAR_CONTROL_WIDTH_PX = 46
export const WINDOW_TITLEBAR_CONTROLS_WIDTH_PX = WINDOW_TITLEBAR_CONTROL_COUNT * WINDOW_TITLEBAR_CONTROL_WIDTH_PX

export function getWindowTitlebarContentInsetClass(isWindows: boolean): string {
  return isWindows ? 'pt-8' : ''
}

export function getWindowTitlebarDragInsetStyle(isWindows: boolean): { right: number } {
  return { right: isWindows ? WINDOW_TITLEBAR_CONTROLS_WIDTH_PX : 0 }
}

/** 标签栏 / AgentHeader 这组「顶部 chrome」住在哪一层 */
export type TabStripHost = 'title-row' | 'main-area'

/**
 * mac 上提到独立的 MacTitleRow（与红绿灯同行）；其他平台留在中列顶部——
 * Windows 上方另有 32px 自绘系统标题栏（WindowControls），标签栏本就在其下。
 */
export function getTabStripHost(isMac: boolean): TabStripHost {
  return isMac ? 'title-row' : 'main-area'
}

export type MacTitleRowContent = 'tabs' | 'agent-header' | 'empty'

/**
 * 标题行中段显示什么，规则与 MainArea 原 showCenterTabBar 一致：
 * 规划 / 技能 / Vault 视图自带头部，标题行只留拖拽区；对话视图下 Agent 会话显示
 * AgentHeader（标题 / 工作目录 / 右面板开关），其余显示标签栏。
 */
export function getMacTitleRowContent(input: { activeView: string; activeTabType: string | undefined }): MacTitleRowContent {
  if (input.activeView !== 'conversations') return 'empty'
  return input.activeTabType === 'agent' ? 'agent-header' : 'tabs'
}

/**
 * 现代风格「两层顶栏」的第二层高度（维护者 2026-09-10 定）：32px 窗口条之下再一条 48px 的上下文行，
 * 左栏切换器、Agent 标题条、Chat 标签栏、右面板标签栏四段同住这一行、同底同线（globals.css 的 --band-2）。
 * 取 48 = AgentHeader 既有高度；Chat 标签栏在现代风格下撑到这一高度（标签仍贴底，Chrome 式）。
 * 经典风格不动：标签栏 34、标题条 48 各走各的。mac 另有 36px 的 MacTitleRow，不走这条。
 */
export const MODERN_TOP_ROW_HEIGHT_PX = 48

export type TabBarInterfaceVariant = 'classic' | 'modern'

/** mac 标签栏填满 36px 标题行（h-9 = MAC_TITLEBAR_HEIGHT_PX）；Windows 经典 34px，现代 48px（h-12 = MODERN_TOP_ROW_HEIGHT_PX）。 */
export function getTabBarHeightClass(isMac: boolean, interfaceVariant: TabBarInterfaceVariant = 'classic'): string {
  if (isMac) return 'h-9'
  return interfaceVariant === 'modern' ? 'h-12' : 'h-[34px]'
}
