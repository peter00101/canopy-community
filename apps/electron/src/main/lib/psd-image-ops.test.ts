import { describe, expect, it } from 'bun:test'
import {
  applyMaskAlpha,
  blendModeToSharp,
  boundsOfOpaque,
  clipAlphaToBase,
  createBitmap,
  createRectMask,
  cropBitmap,
  multiplyAlpha,
  parseHexColor,
  placeOnCanvas,
  tintAlpha,
  toHexColor,
  type RgbaBitmap,
} from './psd-image-ops'

function pixel(bitmap: RgbaBitmap, x: number, y: number): [number, number, number, number] {
  const i = (y * bitmap.width + x) * 4
  return [bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!, bitmap.data[i + 3]!]
}

describe('像素运算：颜色解析', () => {
  it('Given #rgb / #rrggbb / #rrggbbaa，When 解析，Then 展开正确且默认不透明', () => {
    expect(parseHexColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(parseHexColor('#11223344')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 0x44 })
    expect(toHexColor({ r: 255, g: 128, b: 0 })).toBe('#ff8000')
    expect(() => parseHexColor('red')).toThrow()
  })
})

describe('像素运算：摆放与裁边', () => {
  it('Given 4×4 图放在 (-2,-2)，When 摆到 4×4 画布，Then 只有右下 2×2 被越界裁掉后落上', () => {
    const src = createBitmap(4, 4, { r: 10, g: 20, b: 30, a: 255 })
    const out = placeOnCanvas(src, -2, -2, 4, 4)
    expect(pixel(out, 0, 0)).toEqual([10, 20, 30, 255])
    expect(pixel(out, 1, 1)).toEqual([10, 20, 30, 255])
    expect(pixel(out, 2, 2)).toEqual([0, 0, 0, 0])
    expect(pixel(out, 3, 3)).toEqual([0, 0, 0, 0])
  })

  it('Given 画布中央一个 2×2 色块，When 求不透明外接矩形并裁剪，Then 得到 2×2 且像素一致', () => {
    const canvas = createBitmap(6, 6)
    const block = createBitmap(2, 2, { r: 1, g: 2, b: 3, a: 200 })
    const placed = placeOnCanvas(block, 2, 3, 6, 6)
    expect(boundsOfOpaque(placed)).toEqual({ left: 2, top: 3, right: 4, bottom: 5 })
    const cropped = cropBitmap(placed, boundsOfOpaque(placed)!)
    expect(cropped.width).toBe(2)
    expect(pixel(cropped, 1, 1)).toEqual([1, 2, 3, 200])
    expect(boundsOfOpaque(canvas)).toBeNull()
  })
})

describe('像素运算：不透明度、蒙版、剪贴、上色', () => {
  it('Given 全不透明位图，When 乘以 0.5，Then alpha 变 128', () => {
    const bmp = createBitmap(2, 1, { r: 0, g: 0, b: 0, a: 255 })
    multiplyAlpha(bmp, 0.5)
    expect(pixel(bmp, 0, 0)[3]).toBe(128)
  })

  it('Given 左白右黑的蒙版，When 应用到不透明位图，Then 左边保留、右边透明', () => {
    const bmp = createBitmap(2, 1, { r: 9, g: 9, b: 9, a: 255 })
    applyMaskAlpha(bmp, { width: 2, height: 1, data: Buffer.from([255, 0]), channels: 1 })
    expect(pixel(bmp, 0, 0)[3]).toBe(255)
    expect(pixel(bmp, 1, 0)[3]).toBe(0)
  })

  it('Given 基底只有左半不透明，When 剪贴，Then 图层右半被剪掉', () => {
    const base = createBitmap(2, 1)
    base.data[3] = 255
    const layer = createBitmap(2, 1, { r: 1, g: 1, b: 1, a: 255 })
    clipAlphaToBase(layer, base)
    expect(pixel(layer, 0, 0)[3]).toBe(255)
    expect(pixel(layer, 1, 0)[3]).toBe(0)
  })

  it('Given alpha 图与颜色，When 平移上色，Then 颜色与位移都对', () => {
    const alpha = Buffer.from([255, 0, 0, 0])
    const tinted = tintAlpha(alpha, 2, 2, { r: 5, g: 6, b: 7, a: 255 }, 0.5, 1, 1)
    expect(pixel(tinted, 1, 1)).toEqual([5, 6, 7, 128])
    expect(pixel(tinted, 0, 0)[3]).toBe(0)
  })

  it('Given 矩形蒙版，When 生成，Then 矩形内 255、外 0', () => {
    const mask = createRectMask(4, 2, { left: 1, top: 0, width: 2, height: 1 })
    expect([...mask]).toEqual([0, 255, 255, 0, 0, 0, 0, 0])
  })
})

describe('像素运算：混合模式映射', () => {
  it('Given Photoshop 的混合模式名，When 映射到 sharp，Then 13 种精确、色相类退回 over 并标记非精确', () => {
    expect(blendModeToSharp('multiply')).toEqual({ blend: 'multiply', exact: true })
    expect(blendModeToSharp('color dodge')).toEqual({ blend: 'colour-dodge', exact: true })
    expect(blendModeToSharp('linear dodge')).toEqual({ blend: 'add', exact: true })
    expect(blendModeToSharp('hue')).toEqual({ blend: 'over', exact: false })
  })
})
