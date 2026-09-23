/**
 * 离屏窗口边界恢复的 BDD 测试（上游 #1756，0.17.34 合入时上游未带测试）。
 *
 * 场景：用户拔掉外接显示器 / 换了分辨率后重启，`mainWindowState` 里存的坐标落在
 * 任何显示器之外，窗口就"消失"了。恢复规则是：只要与任一显示器工作区有交集就原样用，
 * 完全不相交才收进主显示器并居中。
 */

import { describe, expect, it } from 'bun:test'
import { normalizeWindowBoundsToVisibleArea } from './main-window-lifecycle'

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
/** 右侧外接屏（已拔掉的那种） */
const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
const options = { minWidth: 800, minHeight: 600, fallbackWidth: 1400, fallbackHeight: 900 }

describe('主窗口边界恢复到可见区', () => {
  it('给定窗口完全在主屏内，当恢复时，则原样保留位置与尺寸', () => {
    const bounds = { x: 100, y: 80, width: 1400, height: 900 }
    expect(normalizeWindowBoundsToVisibleArea(bounds, [primary], primary, options)).toEqual(bounds)
  })

  it('给定窗口只有一部分露在屏幕内，当恢复时，则不动它（用户可以自己拖回来）', () => {
    const bounds = { x: -200, y: -60, width: 1400, height: 900 }
    expect(normalizeWindowBoundsToVisibleArea(bounds, [primary], primary, options)).toEqual(bounds)
  })

  it('给定外接屏已拔掉、窗口整个落在原副屏坐标上，当恢复时，则收进主屏并居中', () => {
    const bounds = { x: 2400, y: 200, width: 1400, height: 900 }
    const result = normalizeWindowBoundsToVisibleArea(bounds, [primary], primary, options)

    expect(result.width).toBe(1400)
    expect(result.height).toBe(900)
    expect(result.x).toBe(Math.round((1920 - 1400) / 2))
    expect(result.y).toBe(Math.round((1040 - 900) / 2))
  })

  it('给定外接屏仍在，当窗口落在副屏上时，则原样保留（不该被强行拉回主屏）', () => {
    const bounds = { x: 2400, y: 200, width: 1400, height: 900 }
    expect(normalizeWindowBoundsToVisibleArea(bounds, [primary, secondary], primary, options)).toEqual(bounds)
  })

  it('给定窗口比屏幕还大，当收回时，则夹到工作区尺寸', () => {
    const bounds = { x: 5000, y: 5000, width: 3000, height: 2000 }
    const result = normalizeWindowBoundsToVisibleArea(bounds, [primary], primary, options)

    expect(result.width).toBe(1920)
    expect(result.height).toBe(1040)
    expect(result.x).toBe(0)
    expect(result.y).toBe(0)
  })

  it('给定存档里的尺寸是坏值（NaN / 0 / 负数），当恢复时，则回落到默认尺寸而不是崩掉', () => {
    const result = normalizeWindowBoundsToVisibleArea(
      { x: Number.NaN, y: Number.NaN, width: 0, height: -10 },
      [primary],
      primary,
      options,
    )

    expect(result.width).toBe(1400)
    expect(result.height).toBe(900)
    expect(Number.isFinite(result.x)).toBe(true)
    expect(Number.isFinite(result.y)).toBe(true)
  })

  it('给定收回后仍不能小于最小尺寸，当窗口尺寸过小时，则至少给到 minWidth/minHeight', () => {
    const result = normalizeWindowBoundsToVisibleArea(
      { x: 9000, y: 9000, width: 200, height: 150 },
      [primary],
      primary,
      options,
    )

    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })
})
