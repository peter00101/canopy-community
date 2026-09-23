import { describe, expect, test } from 'bun:test'
import { COMFORT_MAIN_AREA_WIDTH, WIDE_FILE_PANEL_MIN_WIDTH, getDefaultWidePanelWidth, shouldShowBothFileSources } from './file-panel-layout'

describe('右侧文件面板宽度布局', () => {
  test('达到阈值时同时展示会话文件和项目文件', () => {
    expect(shouldShowBothFileSources(WIDE_FILE_PANEL_MIN_WIDTH)).toBe(true)
    expect(shouldShowBothFileSources(WIDE_FILE_PANEL_MIN_WIDTH + 1)).toBe(true)
  })

  test('低于阈值时保留单来源切换模式', () => {
    expect(shouldShowBothFileSources(WIDE_FILE_PANEL_MIN_WIDTH - 1)).toBe(false)
  })
})

describe('扩展工作区默认宽度（小屏让路给会话区）', () => {
  test('Given 1920 大屏 When 计算默认宽 Then 与上游 2/5 视口一致（行为零变化）', () => {
    // 1920 - 301 - 560 = 1059 富余，取 2/5 = 768
    expect(getDefaultWidePanelWidth(1920, 301)).toBe(768)
  })

  test('Given 1280 小屏展开侧栏 When 计算默认宽 Then 先保会话区舒适宽', () => {
    // 2/5 = 512，但 1280 - 241 - 560 = 479 更小 → 会话区拿到 560
    expect(getDefaultWidePanelWidth(1280, 241)).toBe(479)
    expect(1280 - 241 - getDefaultWidePanelWidth(1280, 241)).toBe(COMFORT_MAIN_AREA_WIDTH)
  })

  test('Given 1366 小屏 When 计算默认宽 Then 两者取小', () => {
    // 2/5 = 546；1366 - 241 - 560 = 565 → 取 546（比舒适上限更小，无需让路）
    expect(getDefaultWidePanelWidth(1366, 241)).toBe(546)
  })

  test('Given 极小视口 When 舒适余量为负 Then 返回 0 交由 clamp 兜底最小宽', () => {
    expect(getDefaultWidePanelWidth(700, 241)).toBe(0)
  })
})
