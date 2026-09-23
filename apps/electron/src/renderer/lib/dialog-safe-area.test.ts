import { describe, expect, test } from 'bun:test'
import { resolveDialogPlacement, type OverlayRect } from './dialog-safe-area'

/** 维护者报障时的真实几何：1512 宽窗口，弹窗 max-w-lg = 512，宽布局下浏览器左缘 752。 */
const VIEWPORT = 1512
const DIALOG = 512
const BASE = { viewportWidth: VIEWPORT, dialogMaxWidth: DIALOG, margin: 16, minWidth: 320 }

/** 造一个占满面板高度的浏览器矩形 */
function browser(x: number, width: number): OverlayRect {
  return { x, width, height: 800 }
}

describe('弹窗避让原生覆盖层', () => {
  test('Given 没有内置浏览器, When 求位置, Then 返回 null（保持默认居中，零行为变化）', () => {
    expect(resolveDialogPlacement({ ...BASE, obstacles: [] })).toBeNull()
  })

  test('Given 浏览器只占右侧窄条(左缘 1052), When 默认居中不被遮, Then 返回 null 不动它', () => {
    // 默认居中时弹窗横跨 500~1012，1052 在其右侧，互不相交
    expect(resolveDialogPlacement({ ...BASE, obstacles: [browser(1052, 460)] })).toBeNull()
  })

  test('Given 宽布局浏览器左缘 752（维护者实际场景）, When 求位置, Then 移到左侧自由区并保持原宽', () => {
    const placement = resolveDialogPlacement({ ...BASE, obstacles: [browser(752, VIEWPORT - 752)] })
    expect(placement).not.toBeNull()
    // 左侧自由区 [0,752]，可用 752-32=720 ≥ 512，宽度不压缩
    expect(placement?.maxWidth).toBe(DIALOG)
    expect(placement?.centerX).toBe(376)
    // 关键断言：让位后弹窗右缘 632 < 浏览器左缘 752，「回退」按钮不再落在网页底下
    expect((placement?.centerX ?? 0) + (placement?.maxWidth ?? 0) / 2).toBeLessThan(752)
  })

  test('Given 浏览器拖到上限(左缘 907), When 求位置, Then 仍能整块让到左边', () => {
    const placement = resolveDialogPlacement({ ...BASE, obstacles: [browser(907, VIEWPORT - 907)] })
    expect(placement?.maxWidth).toBe(DIALOG)
    expect((placement?.centerX ?? 0) + (placement?.maxWidth ?? 0) / 2).toBeLessThan(907)
  })

  test('Given 自由区不足 512 但够 minWidth, When 求位置, Then 压缩宽度而不是放弃', () => {
    // 左缘 480 → 左侧可用 480-32=448
    const placement = resolveDialogPlacement({ ...BASE, obstacles: [browser(480, VIEWPORT - 480)] })
    expect(placement?.maxWidth).toBe(448)
    expect(placement?.centerX).toBe(240)
  })

  test('Given 自由区连 minWidth 都不够, When 求位置, Then 返回 null（让不出来就别乱挪）', () => {
    // 左缘 300 → 可用 268 < 320
    expect(resolveDialogPlacement({ ...BASE, obstacles: [browser(300, VIEWPORT - 300)] })).toBeNull()
  })

  test('Given 覆盖层在左侧, When 求位置, Then 让到右边（不假定浏览器一定在右）', () => {
    const placement = resolveDialogPlacement({ ...BASE, obstacles: [browser(0, 760)] })
    expect(placement).not.toBeNull()
    expect(placement?.centerX).toBeGreaterThan(760)
  })

  test('Given 双 Pane 两个浏览器视图, When 求位置, Then 按两者的横向包络让位', () => {
    const placement = resolveDialogPlacement({
      ...BASE,
      obstacles: [browser(760, 370), browser(1140, 372)],
    })
    expect(placement?.centerX).toBe(380)
    expect((placement?.centerX ?? 0) + (placement?.maxWidth ?? 0) / 2).toBeLessThanOrEqual(760)
  })

  test('Given 覆盖层尺寸退化为 0（Tab 已隐藏）, When 求位置, Then 视作不存在', () => {
    expect(resolveDialogPlacement({ ...BASE, obstacles: [{ x: 752, width: 0, height: 0 }] })).toBeNull()
    expect(resolveDialogPlacement({ ...BASE, obstacles: [{ x: 752, width: 3, height: 3 }] })).toBeNull()
  })

  test('Given 视口宽度异常为 0, When 求位置, Then 返回 null 不抛错', () => {
    expect(resolveDialogPlacement({ ...BASE, viewportWidth: 0, obstacles: [browser(0, 100)] })).toBeNull()
  })
})
