import { describe, expect, test } from 'bun:test'
import {
  PROCESS_GROUP_VIEWPORT_HEIGHT,
  getProgressViewportToggleLabel,
  shouldShowProgressViewportToggle,
} from './process-group-viewport'

/**
 * 维护者 2026-09-14 报「执行过程隐藏了很多，执行长一点压根滑不到」：流式期间过程块钉在 320px 且滚动条隐藏。
 * 这里钉住三条改法里可单测的两条：视口高度不再缩回 320 以下、开关只在流式期间出现且文案随状态翻转。
 */
describe('执行过程块小视口', () => {
  test('给定流式期间的小视口，当取最大高度时，则至少 480px（不再是 320）', () => {
    expect(PROCESS_GROUP_VIEWPORT_HEIGHT).toBeGreaterThanOrEqual(480)
  })

  test('给定钉在小视口，当取开关文案时，则是「展开全部」；已展开则是「收回小窗」', () => {
    expect(getProgressViewportToggleLabel(true)).toBe('展开全部')
    expect(getProgressViewportToggleLabel(false)).toBe('收回小窗')
  })

  test('给定流式中且内容已渲染，当判断是否显示开关时，则显示；跑完或内容未渲染则不显示', () => {
    expect(shouldShowProgressViewportToggle(true, true)).toBe(true)
    expect(shouldShowProgressViewportToggle(false, true)).toBe(false)
    expect(shouldShowProgressViewportToggle(true, false)).toBe(false)
  })
})
