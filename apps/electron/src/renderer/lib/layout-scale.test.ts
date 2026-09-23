import { describe, expect, test } from 'bun:test'
import {
  COMPACT_MAX_VIEWPORT_WIDTH,
  WIDE_MIN_VIEWPORT_WIDTH,
  planSidebarAutoCollapse,
  resolveLayoutSize,
} from './layout-scale'

describe('resolveLayoutSize：按窗口宽度判三档', () => {
  test('Given 13 寸笔记本常见宽度 1366 / 1280，When 判档，Then 落紧凑档', () => {
    expect(resolveLayoutSize(1366)).toBe('compact')
    expect(resolveLayoutSize(1280)).toBe('compact')
    expect(resolveLayoutSize(COMPACT_MAX_VIEWPORT_WIDTH)).toBe('compact')
  })

  test('Given 1400 到 1679 之间，When 判档，Then 落标准档（含两端）', () => {
    expect(resolveLayoutSize(1400)).toBe('standard')
    expect(resolveLayoutSize(1536)).toBe('standard')
    expect(resolveLayoutSize(1440)).toBe('standard')
    expect(resolveLayoutSize(WIDE_MIN_VIEWPORT_WIDTH - 1)).toBe('standard')
  })

  test('Given 1680 及以上，When 判档，Then 落宽屏档', () => {
    expect(resolveLayoutSize(WIDE_MIN_VIEWPORT_WIDTH)).toBe('wide')
    expect(resolveLayoutSize(1920)).toBe('wide')
    expect(resolveLayoutSize(2560)).toBe('wide')
  })

  test('Given 非法宽度（0 / 负数 / NaN），When 判档，Then 回落标准档而不是抛错', () => {
    expect(resolveLayoutSize(0)).toBe('standard')
    expect(resolveLayoutSize(-100)).toBe('standard')
    expect(resolveLayoutSize(Number.NaN)).toBe('standard')
  })
})

describe('planSidebarAutoCollapse：紧凑档自动折 rail，离开还原，用户手动优先', () => {
  test('Given 首次挂载就在紧凑档且左栏展开，When 计划，Then 自动折叠并记下是我们折的', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: null, collapsed: false, autoCollapsed: false }))
      .toEqual({ collapsed: true, autoCollapsed: true })
  })

  test('Given 从标准档缩进紧凑档，When 计划，Then 自动折叠', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: 'standard', collapsed: false, autoCollapsed: false }))
      .toEqual({ collapsed: true, autoCollapsed: true })
  })

  test('Given 我们自动折的，When 窗口拉回标准档，Then 自动展开并清掉标记', () => {
    expect(planSidebarAutoCollapse({ size: 'standard', previousSize: 'compact', collapsed: true, autoCollapsed: true }))
      .toEqual({ collapsed: false, autoCollapsed: false })
  })

  test('Given 用户在标准档自己折叠的，When 进出紧凑档，Then 原样保留不动', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: 'standard', collapsed: true, autoCollapsed: false }))
      .toEqual({ collapsed: true, autoCollapsed: false })
    expect(planSidebarAutoCollapse({ size: 'standard', previousSize: 'compact', collapsed: true, autoCollapsed: false }))
      .toEqual({ collapsed: true, autoCollapsed: false })
  })

  test('Given 紧凑档里我们折了、用户又手动展开，When 计划，Then 听用户的并放弃自动语义', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: 'compact', collapsed: false, autoCollapsed: true }))
      .toEqual({ collapsed: false, autoCollapsed: false })
  })

  test('Given 上次在小窗自动折叠后关了应用、这次在大窗打开（previousSize 为 null 但标记持久化着），When 计划，Then 还原展开', () => {
    expect(planSidebarAutoCollapse({ size: 'standard', previousSize: null, collapsed: true, autoCollapsed: true }))
      .toEqual({ collapsed: false, autoCollapsed: false })
  })

  test('Given 紧凑档重载（折叠态与自动标记都从持久化恢复），When 计划，Then 保持折叠且标记仍在', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: null, collapsed: true, autoCollapsed: true }))
      .toEqual({ collapsed: true, autoCollapsed: true })
  })

  test('Given 紧凑档内窗口小幅变化（档位不变），When 计划，Then 什么都不动', () => {
    expect(planSidebarAutoCollapse({ size: 'compact', previousSize: 'compact', collapsed: true, autoCollapsed: true }))
      .toEqual({ collapsed: true, autoCollapsed: true })
  })

  test('Given 标准档与宽屏档之间切换，When 计划，Then 与折叠无关、原样返回', () => {
    expect(planSidebarAutoCollapse({ size: 'wide', previousSize: 'standard', collapsed: false, autoCollapsed: false }))
      .toEqual({ collapsed: false, autoCollapsed: false })
  })
})
