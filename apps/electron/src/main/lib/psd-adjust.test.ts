import { describe, expect, it } from 'bun:test'
import { applyAdjustment } from './psd-adjust'
import { createBitmap, type RgbaBitmap } from './psd-image-ops'

function px(bitmap: RgbaBitmap, x = 0, y = 0): number[] {
  const i = (y * bitmap.width + x) * 4
  return [...bitmap.data.subarray(i, i + 4)]
}

const gray = createBitmap(4, 4, { r: 100, g: 100, b: 100, a: 255 })
const red = createBitmap(4, 4, { r: 200, g: 40, b: 40, a: 255 })

describe('调整层预览近似', () => {
  it('Given 亮度 +50，When 应用，Then 更亮；对比度 +50 让中灰以下更暗', async () => {
    const brighter = await applyAdjustment(gray, { kind: 'brightness/contrast', brightness: 50 })
    expect(px(brighter.bitmap)[0]).toBeGreaterThan(120)
    const contrast = await applyAdjustment(gray, { kind: 'brightness/contrast', contrast: 50 })
    expect(px(contrast.bitmap)[0]).toBeLessThan(100)
    expect(px(contrast.bitmap)[3]).toBe(255)
  })

  it('Given 色相 +120，When 应用，Then 红变绿系；饱和度 -100 变灰', async () => {
    const shifted = await applyAdjustment(red, { kind: 'hue/saturation', hue: 120 })
    const [r, g] = px(shifted.bitmap)
    expect(g).toBeGreaterThan(r!)
    const desaturated = await applyAdjustment(red, { kind: 'hue/saturation', saturation: -100 })
    const [dr, dg, db] = px(desaturated.bitmap)
    expect(Math.abs(dr! - dg!)).toBeLessThanOrEqual(3)
    expect(Math.abs(dg! - db!)).toBeLessThanOrEqual(3)
  })

  it('Given 去色 / 反相，When 应用，Then 三通道相等 / 变成 255-原值', async () => {
    const bw = await applyAdjustment(red, { kind: 'black & white' })
    const [r, g, b, a] = px(bw.bitmap)
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(a).toBe(255)
    const inverted = await applyAdjustment(red, { kind: 'invert' })
    expect(px(inverted.bitmap)).toEqual([55, 215, 215, 255])
  })

  it('Given 色调分离 2 级 / 阈值 128，When 应用，Then 通道只剩 0 或 255', async () => {
    const poster = await applyAdjustment(createBitmap(2, 1, { r: 60, g: 200, b: 130, a: 255 }), { kind: 'posterize', levels: 2 })
    expect(px(poster.bitmap)).toEqual([0, 255, 255, 255])
    const threshold = await applyAdjustment(red, { kind: 'threshold', level: 128 })
    expect(px(threshold.bitmap)).toEqual([0, 0, 0, 255])
  })

  it('Given 曝光 +1，When 应用，Then 亮度约翻倍；纯色填充覆盖为指定颜色', async () => {
    const exposed = await applyAdjustment(gray, { kind: 'exposure', exposure: 1 })
    expect(px(exposed.bitmap)[0]).toBeGreaterThanOrEqual(195)
    const solid = await applyAdjustment(gray, { kind: 'solid color', color: '#123456' })
    expect(px(solid.bitmap)).toEqual([0x12, 0x34, 0x56, 255])
  })

  it('Given 照片滤镜暖色 100%，When 应用，Then 蓝通道被压低、红通道基本保留', async () => {
    const filtered = await applyAdjustment(createBitmap(1, 1, { r: 200, g: 200, b: 200, a: 255 }), { kind: 'photo filter', color: '#ff8000', density: 100 })
    const [r, , b] = px(filtered.bitmap)
    expect(r).toBe(200)
    expect(b).toBe(0)
  })
})
