import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { compositeDocument } from './psd-compositor'
import { geometryToBezierPaths } from './psd-vector'
import {
  buildAgPsd,
  buildCompositeLayersFromPsd,
  encodePsd,
  findAgLayer,
  findAgLayerParent,
  findLayerIdByName,
  fromAgEffects,
  readPsdBuffer,
  toAgEffects,
  type PsdDocLayer,
} from './psd-document'
import { createBitmap, createRectMask, placeOnCanvas } from './psd-image-ops'
import type { PsdTextLayerSpec } from './psd-spec'

const DOC = { width: 64, height: 48, dpi: 150, guides: [{ direction: 'vertical' as const, position: 32 }] }

function square(r: number, g: number, b: number, left: number, top: number) {
  return placeOnCanvas(createBitmap(16, 16, { r, g, b, a: 255 }), left, top, DOC.width, DOC.height)
}

function buildSample(): PsdDocLayer[] {
  const textSpec: PsdTextLayerSpec = { type: 'text', name: '标题', text: '你好\n世界', font: 'Microsoft YaHei', fontSize: 24, color: '#ff0000', bold: true, align: 'center' }
  return [
    { id: '0', name: '背景', kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: createBitmap(DOC.width, DOC.height, { r: 255, g: 255, b: 255, a: 255 }) },
    {
      id: '1', name: '主体', kind: 'group', hidden: false, opacity: 0.8, blendMode: 'normal', clipping: false, opened: true,
      children: [
        { id: '1/0', name: '方块', kind: 'pixel', hidden: false, opacity: 0.5, blendMode: 'multiply', clipping: false, bitmap: square(0, 0, 255, 8, 8), mask: createRectMask(DOC.width, DOC.height, { left: 0, top: 0, width: 32, height: 48 }), effects: { dropShadow: { color: '#000000', opacity: 0.6, angle: 120, distance: 4, size: 6 }, stroke: { color: '#00ff00', size: 2, position: 'outside', opacity: 1 } } },
        { id: '1/1', name: '隐藏的', kind: 'pixel', hidden: true, opacity: 1, blendMode: 'normal', clipping: true, bitmap: square(0, 255, 0, 30, 20) },
      ],
    },
    { id: '2', name: '标题', kind: 'text', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: square(255, 0, 0, 40, 4), text: { spec: textSpec, box: { left: 40, top: 4, width: 20, height: 16 } } },
  ]
}

describe('ag-psd 读写：往返', () => {
  const psd = buildAgPsd(DOC, buildSample(), createBitmap(DOC.width, DOC.height, { r: 1, g: 2, b: 3, a: 255 }))
  const encoded = encodePsd(psd)
  const reread = readPsdBuffer(encoded, true)

  it('Given 写出的 PSD，When 读回，Then 文件头正确、尺寸 / 分辨率 / 参考线保留', () => {
    expect(encoded.subarray(0, 4).toString('latin1')).toBe('8BPS')
    expect([reread.width, reread.height]).toEqual([64, 48])
    expect(reread.psd.imageResources?.resolutionInfo?.horizontalResolution).toBe(150)
    expect(reread.psd.imageResources?.gridAndGuidesInformation?.guides?.[0]?.location).toBe(32)
  })

  it('Given 写出的 PSD，When 读回图层树，Then 顺序、名字、类型、显隐、不透明度、混合模式、蒙版、剪贴、效果都在', () => {
    expect(reread.layers.map((l) => l.name)).toEqual(['背景', '主体', '标题'])
    expect(reread.layers.map((l) => l.kind)).toEqual(['pixel', 'group', 'text'])
    const group = reread.layers[1]!
    expect(group.children?.map((c) => c.name)).toEqual(['方块', '隐藏的'])
    expect(group.opacity).toBeCloseTo(0.8, 1)
    const block = group.children![0]!
    expect(block.opacity).toBeCloseTo(0.5, 1)
    expect(block.blendMode).toBe('multiply')
    expect(block.hasMask).toBe(true)
    expect(block.effects).toEqual(expect.arrayContaining(['dropShadow', 'stroke']))
    expect(block.bounds).toEqual({ left: 8, top: 8, right: 24, bottom: 24 })
    expect(group.children![1]!.hidden).toBe(true)
    expect(group.children![1]!.clipping).toBe(true)
  })

  it('Given 文字层，When 读回，Then 仍是文字层且内容 / 字号 / 对齐可读', () => {
    const title = reread.layers[2]!
    expect(title.kind).toBe('text')
    expect(title.text).toBe('你好\n世界')
    const ag = findAgLayer(reread.psd, '2')!
    expect(ag.text?.style?.fontSize).toBe(24)
    expect(ag.text?.style?.font?.name).toBe('MicrosoftYaHei-Bold')
    expect(ag.text?.paragraphStyle?.justification).toBe('center')
  })

  it('Given 写出的 PSD，When 读回合成图与图层位图，Then 合成图是我们塞的那张、图层位图为文档尺寸并带蒙版', () => {
    expect(reread.composite?.width).toBe(64)
    expect([...reread.composite!.data.subarray(0, 4)]).toEqual([1, 2, 3, 255])
    const layers = buildCompositeLayersFromPsd(reread.psd, [])
    const block = layers[1]!.children![0]!
    expect(block.bitmap?.width).toBe(64)
    expect(block.mask?.length).toBe(64 * 48)
    expect(block.mask![0]).toBe(255)
    expect(block.mask![40]).toBe(0)
    expect(block.effects?.dropShadow?.distance).toBe(4)
  })

  it('Given 图层 id 与名字，When 查找，Then 能定位图层与其父数组', () => {
    expect(findAgLayer(reread.psd, '1/1')?.name).toBe('隐藏的')
    expect(findAgLayer(reread.psd, '9')).toBeNull()
    expect(findLayerIdByName(reread.layers, '方块')).toBe('1/0')
    expect(findLayerIdByName(reread.layers, '没有的')).toBeNull()
    const parent = findAgLayerParent(reread.psd, '1/0')
    expect(parent?.length).toBe(2)
    expect(findAgLayerParent(reread.psd, '0')).toBe(reread.psd.children!)
  })
})

describe('ag-psd 读写：效果映射', () => {
  it('Given 我方效果规格，When 映射到 Photoshop 样式再映射回来，Then 主要参数不丢', () => {
    const ag = toAgEffects({ dropShadow: { color: '#112233', opacity: 0.4, angle: 90, distance: 12, size: 20 }, outerGlow: { color: '#ffff00', opacity: 0.5, size: 9 }, stroke: { color: '#00ff00', size: 5, position: 'inside', opacity: 0.7 }, gradientOverlay: { colors: ['#000000', '#ffffff', '#ff0000'], angle: 45, opacity: 1 } })
    expect(ag.dropShadow?.[0]?.distance).toEqual({ units: 'Pixels', value: 12 })
    expect(ag.gradientOverlay?.[0]?.gradient?.type).toBe('solid')
    const back = fromAgEffects(ag)
    expect(back?.dropShadow).toEqual({ color: '#112233', opacity: 0.4, angle: 90, distance: 12, size: 20 })
    expect(back?.outerGlow).toEqual({ color: '#ffff00', opacity: 0.5, size: 9 })
    expect(back?.stroke).toEqual({ color: '#00ff00', size: 5, position: 'inside', opacity: 0.7 })
    expect(back?.gradientOverlay).toEqual({ colors: ['#000000', '#ffffff', '#ff0000'], angle: 45, opacity: 1 })
  })
})

describe('ag-psd 读写：形状 / 调整 / 画板 / 智能对象', () => {
  const blank = createBitmap(DOC.width, DOC.height)

  it('Given 形状层（填充 + 描边），When 写出再读回，Then 识别为 shape、矢量蒙版路径 / 填充色 / 描边宽度都在；没有像素时按路径栅格化', async () => {
    const paths = geometryToBezierPaths({ shape: 'rect', left: 8, top: 8, width: 16, height: 16 })
    const withPixels: PsdDocLayer = { id: '0', name: '方', kind: 'shape', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: square(255, 0, 0, 8, 8), vector: { paths, fill: '#ff0000', stroke: { color: '#0000ff', width: 3 } } }
    const noPixels: PsdDocLayer = { ...withPixels, id: '1', name: '空方', bitmap: undefined, vector: { paths, fill: '#00ff00' } }
    const reread = readPsdBuffer(encodePsd(buildAgPsd(DOC, [withPixels, noPixels], blank)), true)
    expect(reread.layers.map((l) => l.kind)).toEqual(['shape', 'shape'])
    const ag = findAgLayer(reread.psd, '0')!
    expect(ag.vectorMask?.paths[0]?.knots).toHaveLength(4)
    expect(ag.vectorMask?.paths[0]?.knots[0]?.points[2]).toBeCloseTo(8, 3)
    expect(ag.vectorMask?.paths[0]?.knots[2]?.points[3]).toBeCloseTo(24, 3)
    expect(ag.vectorFill).toEqual({ type: 'color', color: { r: 255, g: 0, b: 0 } })
    expect(ag.vectorStroke?.strokeEnabled).toBe(true)
    expect(ag.vectorStroke?.lineWidth?.value).toBe(3)
    expect(ag.vectorStroke?.content).toEqual({ type: 'color', color: { r: 0, g: 0, b: 255 } })
    expect(findAgLayer(reread.psd, '1')!.vectorStroke).toBeUndefined()
    // 无像素的形状层：图层树给路径外接框，合成层带 SVG，合成后是绿色
    expect(reread.layers[1]!.bounds).toEqual({ left: 8, top: 8, right: 24, bottom: 24 })
    const empty = reread.compositeLayers[1]!
    expect(empty.bitmap).toBeUndefined()
    expect(empty.svg).toContain('fill="#00ff00"')
    const { bitmap } = await compositeDocument({ width: DOC.width, height: DOC.height, background: null }, [empty])
    expect([...bitmap.data.subarray((12 * DOC.width + 12) * 4, (12 * DOC.width + 12) * 4 + 4)]).toEqual([0, 255, 0, 255])
  })

  it('Given 十种调整层，When 写出再读回，Then 类型与参数保留、合成层拿到预览参数；纯色层是填充层并铺满画布', () => {
    const kinds: Array<PsdDocLayer['adjustment']> = [
      { kind: 'brightness/contrast', brightness: 30, contrast: -10 },
      { kind: 'hue/saturation', hue: 90, saturation: -20, lightness: 5 },
      { kind: 'black & white' },
      { kind: 'invert' },
      { kind: 'posterize', levels: 3 },
      { kind: 'threshold', level: 100 },
      { kind: 'exposure', exposure: 1.5, offset: 0.1, gamma: 0.8 },
      { kind: 'vibrance', vibrance: 40, saturation: 10 },
      { kind: 'photo filter', color: '#ff8000', density: 60 },
      { kind: 'solid color', color: '#123456' },
    ]
    const layers: PsdDocLayer[] = kinds.map((adjustment, i) => ({ id: String(i), name: adjustment!.kind, kind: 'adjustment', hidden: false, opacity: 1, blendMode: 'normal', clipping: i === 0, adjustment }))
    const reread = readPsdBuffer(encodePsd(buildAgPsd(DOC, layers, blank)), true)
    expect(reread.layers.every((l) => l.kind === 'adjustment')).toBe(true)
    expect(reread.layers[0]!.clipping).toBe(true)
    const ag = reread.psd.children!
    expect(ag.slice(0, 9).map((l) => l.adjustment?.type)).toEqual(['brightness/contrast', 'hue/saturation', 'black & white', 'invert', 'posterize', 'threshold', 'exposure', 'vibrance', 'photo filter'])
    expect(ag[0]!.adjustment).toMatchObject({ brightness: 30, contrast: -10 })
    expect(ag[1]!.adjustment).toMatchObject({ master: { hue: 90, saturation: -20, lightness: 5 } })
    expect(ag[4]!.adjustment).toMatchObject({ levels: 3 })
    expect(ag[5]!.adjustment).toMatchObject({ level: 100 })
    expect((ag[6]!.adjustment as { exposure?: number }).exposure).toBeCloseTo(1.5, 3)
    expect(ag[7]!.adjustment).toMatchObject({ vibrance: 40, saturation: 10 })
    expect(ag[8]!.adjustment).toMatchObject({ color: { r: 255, g: 128, b: 0 }, preserveLuminosity: true })
    expect(ag[9]!.adjustment).toBeUndefined()
    expect(ag[9]!.vectorFill).toEqual({ type: 'color', color: { r: 0x12, g: 0x34, b: 0x56 } })
    const composite = reread.compositeLayers
    expect(composite[0]!.kind).toBe('adjustment')
    expect(composite[0]!.adjustment).toEqual({ kind: 'brightness/contrast', brightness: 30, contrast: -10 })
    expect(composite[8]!.adjustment).toMatchObject({ kind: 'photo filter', color: '#ff8000' })
    expect((composite[8]!.adjustment as { density?: number }).density).toBeCloseTo(60, 0)
    expect(composite[9]!.kind).toBe('pixel')
    expect([...composite[9]!.bitmap!.data.subarray(0, 4)]).toEqual([0x12, 0x34, 0x56, 255])
  })

  it('Given 画板 + 里面一个方块，When 写出再读回，Then 画板矩形 / 底色 / 文档级计数保留，合成时画板外透明', async () => {
    const board: PsdDocLayer = {
      id: '0', name: '首页', kind: 'artboard', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, opened: true,
      artboard: { left: 4, top: 4, width: 32, height: 24, background: '#00ff00' },
      children: [{ id: '0/0', name: '方块', kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: square(255, 0, 0, 30, 10) }],
    }
    const reread = readPsdBuffer(encodePsd(buildAgPsd(DOC, [board], blank)), true)
    expect(reread.layers[0]!.kind).toBe('artboard')
    expect(reread.layers[0]!.bounds).toEqual({ left: 4, top: 4, right: 36, bottom: 28 })
    expect(reread.psd.artboards?.count).toBe(1)
    const ag = findAgLayer(reread.psd, '0')!
    expect(ag.artboard?.rect).toEqual({ top: 4, left: 4, bottom: 28, right: 36 })
    expect(ag.artboard?.backgroundType).toBe(4)
    expect(reread.compositeLayers[0]!.artboard).toEqual({ left: 4, top: 4, width: 32, height: 24, background: '#00ff00' })
    const { bitmap } = await compositeDocument({ width: DOC.width, height: DOC.height, background: null }, reread.compositeLayers)
    const at = (x: number, y: number): number[] => [...bitmap.data.subarray((y * DOC.width + x) * 4, (y * DOC.width + x) * 4 + 4)]
    expect(at(6, 6)).toEqual([0, 255, 0, 255])
    expect(at(32, 12)).toEqual([255, 0, 0, 255])
    expect(at(40, 12)[3]).toBe(0)
    expect(at(1, 1)[3]).toBe(0)
  })

  it('Given 智能对象（嵌入 PNG），When 写出再读回，Then 识别为 smart-object、placedLayer 摆放框正确、嵌入文件原样保留', async () => {
    const png = await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer()
    const placed: PsdDocLayer['placed'] = { id: randomUUID(), name: 'photo.png', data: png, fileType: 'png ', sourceWidth: 30, sourceHeight: 30, left: 4, top: 4, width: 16, height: 16 }
    const layer: PsdDocLayer = { id: '0', name: '照片', kind: 'smart-object', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: square(0, 200, 0, 4, 4), placed }
    const reread = readPsdBuffer(encodePsd(buildAgPsd(DOC, [layer], blank)), true)
    expect(reread.layers[0]!.kind).toBe('smart-object')
    expect(reread.layers[0]!.bounds).toEqual({ left: 4, top: 4, right: 20, bottom: 20 })
    const ag = findAgLayer(reread.psd, '0')!
    expect(ag.placedLayer?.id).toBe(placed.id)
    expect(ag.placedLayer?.type).toBe('raster')
    expect(ag.placedLayer?.transform).toEqual([4, 4, 20, 4, 20, 20, 4, 20])
    expect(ag.placedLayer?.width).toBe(30)
    expect(reread.psd.linkedFiles?.[0]?.id).toBe(placed.id)
    expect(reread.psd.linkedFiles?.[0]?.name).toBe('photo.png')
    expect(Buffer.from(reread.psd.linkedFiles![0]!.data!).equals(png)).toBe(true)
    // 只读图层树时不加载嵌入文件的数据
    expect(readPsdBuffer(encodePsd(buildAgPsd(DOC, [layer], blank)), false).psd.linkedFiles?.[0]?.data).toBeUndefined()
  })
})
