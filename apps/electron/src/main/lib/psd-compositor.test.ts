import { describe, expect, it } from 'bun:test'
import { compositeDocument, decodeImageToBitmap, renderLayerAlone, type CompositeLayer } from './psd-compositor'
import { createBitmap, placeOnCanvas, type RgbaBitmap } from './psd-image-ops'

const DOC = { width: 40, height: 40, background: '#ffffff' as string | null }

function solid(r: number, g: number, b: number, w = 40, h = 40): RgbaBitmap {
  return createBitmap(w, h, { r, g, b, a: 255 })
}

function square(r: number, g: number, b: number): RgbaBitmap {
  return placeOnCanvas(createBitmap(16, 16, { r, g, b, a: 255 }), 12, 12, 40, 40)
}

function layer(id: string, bitmap: RgbaBitmap, extra: Partial<CompositeLayer> = {}): CompositeLayer {
  return { id, name: id, kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: false, bitmap, ...extra }
}

function px(bitmap: RgbaBitmap, x: number, y: number): number[] {
  const i = (y * bitmap.width + x) * 4
  return [...bitmap.data.subarray(i, i + 4)]
}

describe('预览合成器：自下而上叠图层', () => {
  it('Given 红底 + 半透明蓝层，When 合成，Then 中心像素是紫色', async () => {
    const { bitmap } = await compositeDocument(DOC, [layer('0', solid(255, 0, 0)), layer('1', solid(0, 0, 255), { opacity: 0.5 })])
    const [r, g, b, a] = px(bitmap, 20, 20)
    expect(a).toBe(255)
    expect(Math.abs(r! - 128)).toBeLessThanOrEqual(2)
    expect(g).toBe(0)
    expect(Math.abs(b! - 128)).toBeLessThanOrEqual(2)
  })

  it('Given 顶层隐藏，When 合成，Then 只看到红底；用 visibleIds 强制显示则又出现', async () => {
    const layers = [layer('0', solid(255, 0, 0)), layer('1', solid(0, 0, 255), { hidden: true })]
    expect(px((await compositeDocument(DOC, layers)).bitmap, 5, 5)).toEqual([255, 0, 0, 255])
    expect(px((await compositeDocument(DOC, layers, { visibleIds: new Set(['1']) })).bitmap, 5, 5)).toEqual([0, 0, 255, 255])
    expect(px((await compositeDocument(DOC, [layer('0', solid(255, 0, 0)), layer('1', solid(0, 0, 255))], { hiddenIds: new Set(['1']) })).bitmap, 5, 5)).toEqual([255, 0, 0, 255])
  })

  it('Given 分组不透明度 0.5，When 合成，Then 子层整体按组的不透明度叠加（非穿透）', async () => {
    const group: CompositeLayer = { id: '1', name: 'g', kind: 'group', hidden: false, opacity: 0.5, blendMode: 'pass through', clipToBelow: false, children: [layer('1/0', solid(0, 0, 255))] }
    const { bitmap } = await compositeDocument(DOC, [layer('0', solid(255, 0, 0)), group])
    const [r, , b] = px(bitmap, 20, 20)
    expect(Math.abs(r! - 128)).toBeLessThanOrEqual(2)
    expect(Math.abs(b! - 128)).toBeLessThanOrEqual(2)
  })

  it('Given 剪贴到下方小方块，When 合成，Then 方块外仍是底色、方块内是剪贴层颜色', async () => {
    const { bitmap } = await compositeDocument(DOC, [layer('0', square(0, 255, 0)), layer('1', solid(0, 0, 255), { clipToBelow: true })])
    expect(px(bitmap, 20, 20)).toEqual([0, 0, 255, 255])
    expect(px(bitmap, 2, 2)).toEqual([255, 255, 255, 255])
  })

  it('Given 多层多个混合模式，When 合成，Then multiply 变暗、screen 变亮、hue 退回 normal 并给提醒', async () => {
    const gray = solid(128, 128, 128)
    const multiply = await compositeDocument(DOC, [layer('0', gray), layer('1', solid(128, 128, 128), { blendMode: 'multiply' })])
    expect(px(multiply.bitmap, 1, 1)[0]).toBeLessThan(100)
    const screen = await compositeDocument(DOC, [layer('0', gray), layer('1', solid(128, 128, 128), { blendMode: 'screen' })])
    expect(px(screen.bitmap, 1, 1)[0]).toBeGreaterThan(160)
    const hue = await compositeDocument(DOC, [layer('0', gray), layer('1', solid(0, 0, 255), { blendMode: 'hue' })])
    expect(hue.warnings.some((w) => w.includes('hue'))).toBe(true)
  })
})

describe('预览合成器：效果近似', () => {
  it('Given 方块加投影，When 合成，Then 方块右下外侧变暗、左上外侧仍是底色', async () => {
    const { bitmap } = await compositeDocument(DOC, [layer('0', square(200, 50, 50), { effects: { dropShadow: { color: '#000000', opacity: 0.9, angle: 120, distance: 6, size: 4 } } })])
    expect(px(bitmap, 31, 31)[0]).toBeLessThan(250)
    expect(px(bitmap, 6, 6)).toEqual([255, 255, 255, 255])
  })

  it('Given 方块加描边，When 合成，Then 紧贴方块外缘的像素是描边色', async () => {
    const { bitmap } = await compositeDocument(DOC, [layer('0', square(0, 0, 255), { effects: { stroke: { color: '#00ff00', size: 3, position: 'outside', opacity: 1 } } })])
    const [r, g, b] = px(bitmap, 10, 20)
    expect(g).toBeGreaterThan(200)
    expect(r).toBeLessThan(80)
    expect(b).toBeLessThan(80)
  })

  it('Given 方块加内阴影（左上打光），When 合成，Then 方块内靠左上的边缘变暗、中心与方块外不变', async () => {
    const { bitmap, warnings } = await compositeDocument(DOC, [layer('0', square(0, 0, 255), { effects: { innerShadow: { color: '#000000', opacity: 1, angle: 120, distance: 4, size: 4 } } })])
    // 方块占 (12..27)；内阴影落在左上内缘 (13,13)，中心 (20,20) 仍是纯蓝，外面 (5,5) 仍是白底
    expect(px(bitmap, 13, 13)[2]).toBeLessThan(200)
    expect(px(bitmap, 20, 20)).toEqual([0, 0, 255, 255])
    expect(px(bitmap, 5, 5)).toEqual([255, 255, 255, 255])
    expect(warnings.some((w) => w.includes('内阴影'))).toBe(false)
  })

  it('Given 方块加黑→白渐变叠加（角度 90），When 合成，Then 方块下缘接近黑、上缘接近白、方块外仍是底色', async () => {
    const { bitmap } = await compositeDocument(DOC, [layer('0', square(0, 0, 255), { effects: { gradientOverlay: { colors: ['#000000', '#ffffff'], angle: 90, opacity: 1 } } })])
    expect(px(bitmap, 20, 27)[0]).toBeLessThan(60)
    expect(px(bitmap, 20, 12)[0]).toBeGreaterThan(195)
    expect(px(bitmap, 5, 5)).toEqual([255, 255, 255, 255])
  })
})

describe('预览合成器：调整层与画板', () => {
  it('Given 底色上放反相调整层，再放一个红方块在其上，When 合成，Then 底色被反相、上面的方块不受影响', async () => {
    const adjustment: CompositeLayer = { id: '1', name: '反相', kind: 'adjustment', hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: false, adjustment: { kind: 'invert' } }
    const { bitmap } = await compositeDocument(DOC, [layer('0', solid(0, 0, 255)), adjustment, layer('2', square(255, 0, 0))])
    expect(px(bitmap, 2, 2)).toEqual([255, 255, 0, 255])
    expect(px(bitmap, 20, 20)).toEqual([255, 0, 0, 255])
  })

  it('Given 调整层剪贴到下方小方块 / 带矩形蒙版 / 半透明，When 合成，Then 只在对应范围内按权重生效', async () => {
    const clipped: CompositeLayer = { id: '1', name: '反相', kind: 'adjustment', hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: true, adjustment: { kind: 'invert' } }
    const a = await compositeDocument(DOC, [layer('0', square(0, 0, 255)), clipped])
    expect(px(a.bitmap, 20, 20)).toEqual([255, 255, 0, 255])
    expect(px(a.bitmap, 2, 2)).toEqual([255, 255, 255, 255])
    const mask = Buffer.alloc(40 * 40, 0)
    for (let y = 0; y < 40; y++) mask.fill(255, y * 40, y * 40 + 20)
    const masked: CompositeLayer = { ...clipped, clipToBelow: false, mask }
    const b = await compositeDocument(DOC, [layer('0', solid(0, 0, 255)), masked])
    expect(px(b.bitmap, 5, 5)).toEqual([255, 255, 0, 255])
    expect(px(b.bitmap, 35, 5)).toEqual([0, 0, 255, 255])
    const half: CompositeLayer = { ...clipped, clipToBelow: false, opacity: 0.5 }
    const c = await compositeDocument(DOC, [layer('0', solid(0, 0, 255)), half])
    expect(px(c.bitmap, 5, 5)).toEqual([128, 128, 128, 255])
  })

  it('Given 画板带底色且子层超出画板，When 合成，Then 画板内有底色、子层被裁到画板矩形', async () => {
    const board: CompositeLayer = {
      id: '0', name: '画板', kind: 'group', hidden: false, opacity: 1, blendMode: 'pass through', clipToBelow: false,
      artboard: { left: 10, top: 10, width: 20, height: 20, background: '#00ff00' },
      children: [layer('0/0', placeOnCanvas(createBitmap(30, 30, { r: 255, g: 0, b: 0, a: 255 }), 20, 20, 40, 40))],
    }
    const { bitmap } = await compositeDocument({ ...DOC, background: null }, [board])
    expect(px(bitmap, 12, 12)).toEqual([0, 255, 0, 255])
    expect(px(bitmap, 25, 25)).toEqual([255, 0, 0, 255])
    expect(px(bitmap, 35, 35)[3]).toBe(0)
    expect(px(bitmap, 5, 5)[3]).toBe(0)
  })

  it('Given 没有位图只有 SVG 的形状层，When 合成，Then 栅格化后参与合成；单独导出时裁到外接矩形', async () => {
    const shape: CompositeLayer = { id: '1', name: '圆', kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: false, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="10" y="10" width="10" height="10" fill="#ff0000"/></svg>' }
    const { bitmap } = await compositeDocument(DOC, [layer('0', solid(0, 0, 255)), shape])
    expect(px(bitmap, 15, 15)).toEqual([255, 0, 0, 255])
    const alone = await renderLayerAlone({ ...DOC, background: null }, shape)
    expect(alone?.bounds).toEqual({ left: 10, top: 10, right: 20, bottom: 20 })
    expect(alone?.bitmap.width).toBe(10)
    const group = await renderLayerAlone({ ...DOC, background: null }, { id: 'g', name: '组', kind: 'group', hidden: false, opacity: 0.5, blendMode: 'multiply', clipToBelow: false, children: [shape] })
    expect(group?.bounds.left).toBe(10)
    expect(px(group!.bitmap, 0, 0)).toEqual([255, 0, 0, 255])
    expect(await renderLayerAlone({ ...DOC, background: null }, { id: 'a', name: '调', kind: 'adjustment', hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: false, adjustment: { kind: 'invert' } })).toBeNull()
  })
})

describe('预览合成器：解码素材', () => {
  it('Given 一段内联 SVG，When 解码，Then 得到声明尺寸的 RGBA 位图且带透明区域', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect x="0" y="0" width="15" height="20" fill="#ff0000"/></svg>'
    const bitmap = await decodeImageToBitmap(Buffer.from(svg))
    expect([bitmap.width, bitmap.height]).toEqual([30, 20])
    expect(px(bitmap, 5, 5)).toEqual([255, 0, 0, 255])
    expect(px(bitmap, 25, 5)[3]).toBe(0)
  })
})
