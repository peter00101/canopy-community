import { describe, expect, it } from 'bun:test'
import {
  MAC_TITLEBAR_HEIGHT_PX,
  MAC_TRAFFIC_LIGHTS_INSET_PX,
  SETTINGS_TOP_BAND_LABEL_INSET_PX,
  getSettingsTopBandLabelInsetPx,
  getMacTitleRowContent,
  getTabBarHeightClass,
  MODERN_TOP_ROW_HEIGHT_PX,
  getTabStripHost,
  getWindowTitlebarContentInsetClass,
} from './window-titlebar-layout'

describe('getTabStripHost — 标签栏 / AgentHeader 的宿主层', () => {
  it('Given macOS，When 决定宿主，Then 提到与红绿灯同行的独立标题行', () => {
    expect(getTabStripHost(true)).toBe('title-row')
  })

  it('Given Windows / Linux，When 决定宿主，Then 留在中列顶部（Windows 上方另有 32px 系统标题栏）', () => {
    expect(getTabStripHost(false)).toBe('main-area')
    expect(getWindowTitlebarContentInsetClass(true)).toBe('pt-8')
    expect(getWindowTitlebarContentInsetClass(false)).toBe('')
  })
})

describe('getMacTitleRowContent — mac 标题行中段内容', () => {
  it('Given 对话视图 + Chat 标签激活，When 取内容，Then 显示标签栏', () => {
    expect(getMacTitleRowContent({ activeView: 'conversations', activeTabType: 'chat' })).toBe('tabs')
  })

  it('Given 对话视图但没有任何标签，When 取内容，Then 仍走标签栏分支（TabBar 自己渲染空拖拽条）', () => {
    expect(getMacTitleRowContent({ activeView: 'conversations', activeTabType: undefined })).toBe('tabs')
  })

  it('Given 对话视图 + Agent 会话激活，When 取内容，Then 显示 AgentHeader 而非标签栏（与 MainArea 原规则一致）', () => {
    expect(getMacTitleRowContent({ activeView: 'conversations', activeTabType: 'agent' })).toBe('agent-header')
  })

  it('Given 规划 / 技能 / Vault 视图，When 取内容，Then 只留拖拽区，不渲染标签栏与会话头', () => {
    for (const activeView of ['planning', 'agent-skills', 'vault']) {
      expect(getMacTitleRowContent({ activeView, activeTabType: 'agent' })).toBe('empty')
      expect(getMacTitleRowContent({ activeView, activeTabType: 'chat' })).toBe('empty')
    }
  })
})

describe('mac 标题行几何常量', () => {
  it('Given 红绿灯 x=18 起、三灯跨度 60，When 计算占位，Then 左右对称留 18 得 96', () => {
    expect(MAC_TRAFFIC_LIGHTS_INSET_PX).toBe(96)
  })

  it('Given 14px 高红绿灯由 y=11 定位，When 对照标题行高度，Then 灯的垂直中心 18 正好是行高 36 的一半', () => {
    const trafficLightTop = 11
    const trafficLightHeight = 14
    expect(trafficLightTop + trafficLightHeight / 2).toBe(MAC_TITLEBAR_HEIGHT_PX / 2)
  })

  it('Given mac 标签栏填满 36px 标题行，When 取高度类，Then mac 为 h-9（=36px）、其他平台维持 34px', () => {
    expect(getTabBarHeightClass(true)).toBe('h-9')
    expect(getTabBarHeightClass(false)).toBe('h-[34px]')
    // 现代风格两层顶栏：第二层 48px（h-12），Chat 标签栏撑到与 Agent 标题条同高；mac 不受变体影响
    expect(getTabBarHeightClass(false, 'modern')).toBe('h-12')
    expect(getTabBarHeightClass(false, 'classic')).toBe('h-[34px]')
    expect(getTabBarHeightClass(true, 'modern')).toBe('h-9')
    expect(MODERN_TOP_ROW_HEIGHT_PX).toBe(48)
  })
})

describe('getSettingsTopBandLabelInsetPx — 设置页顶带标签避让原生红绿灯', () => {
  it('Given macOS 上设置页铺满整窗、顶带落在 y=0，When 取标签左起点，Then 让开红绿灯占位 96', () => {
    expect(getSettingsTopBandLabelInsetPx(true)).toBe(MAC_TRAFFIC_LIGHTS_INSET_PX)
  })

  it('Given 其他平台窗口按钮在右侧，When 取标签左起点，Then 维持原来的 24（left-6）', () => {
    expect(getSettingsTopBandLabelInsetPx(false)).toBe(SETTINGS_TOP_BAND_LABEL_INSET_PX)
    expect(SETTINGS_TOP_BAND_LABEL_INSET_PX).toBe(24)
  })

  it('Given 红绿灯右缘在 x=78，When 对照 mac 标签左起点，Then 标签起点不小于右缘，两者不重叠', () => {
    const trafficLightsRightEdgePx = 18 + 60
    expect(getSettingsTopBandLabelInsetPx(true)).toBeGreaterThanOrEqual(trafficLightsRightEdgePx)
    // 修复前写死的 24 正落在 18~78 区间内，这就是维护者报的「红绿灯和设置文字叠在一起」
    expect(SETTINGS_TOP_BAND_LABEL_INSET_PX).toBeLessThan(trafficLightsRightEdgePx)
  })
})
