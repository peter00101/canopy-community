import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PsdAccessError } from './psd-paths'
import { composePsd, describeLayerTree, editPsd, renderPsd, renderPsdLayer } from './psd-service'
import { readPsdBuffer } from './psd-document'

let root = ''
let outside = ''

async function pixelAt(png: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return [...data.subarray(i, i + 4)]
}

const spec = {
  width: 200,
  height: 120,
  dpi: 96,
  background: '#ffffff',
  guides: [{ direction: 'horizontal', position: 60 }],
  layers: [
    { type: 'fill', name: '底色', color: '#2244aa' },
    { type: 'svg', name: '圆柱体', left: 20, top: 20, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#888888"/></linearGradient></defs><rect x="10" y="20" width="60" height="50" fill="url(#g)"/><ellipse cx="40" cy="20" rx="30" ry="10" fill="#eeeeee"/></svg>', effects: { dropShadow: { distance: 4, size: 4 } } },
    { type: 'image', name: '照片', source: 'assets/photo.png', left: 120, top: 20, width: 60, height: 60, fit: 'fill' },
    { type: 'group', name: '文案', children: [
      { type: 'text', name: '标题', text: '你好 PSD', fontSize: 20, color: '#ffffff', bold: true, align: 'center', left: 10, top: 90, width: 180 },
    ] },
  ],
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'canopy-psd-service-'))
  outside = mkdtempSync(join(tmpdir(), 'canopy-psd-service-outside-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'photo.png'), await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer())
  writeFileSync(join(outside, 'photo.png'), await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer())
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('PSD 服务：合成', () => {
  it('Given 含纯色 / SVG / 图片 / 分组文字的规格，When 合成，Then 写出 .psd 与预览 PNG，图层树完整，合成图像素正确', async () => {
    const outputPsdPath = join(root, 'out', 'poster.psd')
    mkdirSync(join(root, 'out'))
    const result = await composePsd(spec, { roots: [root], specBaseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'poster-preview.png') })
    expect(existsSync(outputPsdPath)).toBe(true)
    expect(existsSync(result.previewPngPath)).toBe(true)
    expect(result.layerCount).toBe(5)
    expect(result.layers.map((l) => l.name)).toEqual(['底色', '圆柱体', '照片', '文案'])
    expect(result.previewPng.subarray(1, 4).toString('latin1')).toBe('PNG')
    // 底色处是蓝色，照片处是绿色
    const preview = readFileSync(result.previewPngPath)
    expect(await pixelAt(preview, 5, 5)).toEqual([0x22, 0x44, 0xaa, 255])
    expect(await pixelAt(preview, 150, 50)).toEqual([0, 200, 0, 255])
    // 文字层像素落在文本框附近
    const tree = readPsdBuffer(readFileSync(outputPsdPath), false)
    const title = tree.layers[3]!.children![0]!
    expect(title.kind).toBe('text')
    expect(title.text).toBe('你好 PSD')
    expect(title.bounds!.top).toBeGreaterThanOrEqual(88)
  }, 30_000)

  it('Given 素材在授权根外，When 合成，Then 拒绝且不写文件', async () => {
    const outputPsdPath = join(root, 'leak.psd')
    await expect(composePsd({ width: 10, height: 10, layers: [{ type: 'image', source: join(outside, 'photo.png') }] }, { roots: [root], specBaseDir: root, outputPsdPath, previewPngPath: join(root, 'leak.png') })).rejects.toBeInstanceOf(PsdAccessError)
    expect(existsSync(outputPsdPath)).toBe(false)
  })
})

describe('PSD 服务：读取与显隐改写', () => {
  it('Given 合成出的文件，When 用内置引擎读取，Then 拿到图层树与合成图；隐藏底色后同一像素变透明', async () => {
    const psdPath = join(root, 'out', 'poster.psd')
    const plain = await renderPsd(psdPath, { forceBuiltin: true })
    expect(plain.engine).toBe('ag-psd')
    expect(plain.layers.map((l) => l.name)).toEqual(['底色', '圆柱体', '照片', '文案'])
    expect(await pixelAt(plain.png, 5, 5)).toEqual([0x22, 0x44, 0xaa, 255])
    const hidden = await renderPsd(psdPath, { forceBuiltin: true, hiddenIds: ['0'] })
    expect((await pixelAt(hidden.png, 5, 5))[3]).toBe(0)
    const small = await renderPsd(psdPath, { forceBuiltin: true, maxSide: 50 })
    expect((await sharp(small.png).metadata()).width).toBe(50)
  }, 30_000)

  it('Given 图层树，When 生成文字摘要，Then 自上而下、带 id / 类型 / 位置 / 文字', async () => {
    const plain = await renderPsd(join(root, 'out', 'poster.psd'), { forceBuiltin: true })
    const text = describeLayerTree(plain.layers)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^\[3\] group 文案/)
    expect(lines[1]).toMatch(/^\s+\[3\/0\] text 标题 @\(\d+,\d+\) \d+×\d+ "你好 PSD"/)
    expect(lines[lines.length - 1]).toMatch(/^\[0\] pixel 底色/)
  }, 30_000)
})

describe('PSD 服务：编辑', () => {
  it('Given 已有文件，When 改字 / 改名 / 隐藏 / 移动 / 删除 / 加层一起做，Then 写出的新文件反映全部改动且文字层仍可编辑', async () => {
    const source = join(root, 'out', 'poster.psd')
    const outputPsdPath = join(root, 'out', 'edited.psd')
    const result = await editPsd(source, [
      { op: 'setText', layer: '标题', text: '改过的标题', color: '#ffff00' },
      { op: 'rename', layer: '0', name: '背景' },
      { op: 'setVisible', layer: '照片', hidden: true },
      { op: 'move', layer: '圆柱体', left: 40, top: 30 },
      { op: 'setOpacity', layer: '圆柱体', opacity: 0.5 },
      { op: 'addLayer', spec: { type: 'fill', name: '角标', color: '#ff0000', left: 0, top: 0, width: 20, height: 20 } },
      { op: 'remove', layer: '文案' },
    ], { roots: [root], baseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'edited-preview.png') })
    expect(result.applied).toHaveLength(7)
    const tree = readPsdBuffer(readFileSync(outputPsdPath), false)
    expect(tree.layers.map((l) => l.name)).toEqual(['背景', '圆柱体', '照片', '角标'])
    expect(tree.layers[2]!.hidden).toBe(true)
    expect(tree.layers[1]!.bounds!.left).toBeGreaterThanOrEqual(40)
    expect(tree.layers[1]!.opacity).toBeCloseTo(0.5, 1)
    // 角标在左上角：预览像素是红的；照片被隐藏：原绿色位置回到底色
    expect(await pixelAt(result.previewPng, 5, 5)).toEqual([255, 0, 0, 255])
    expect(await pixelAt(result.previewPng, 150, 50)).toEqual([0x22, 0x44, 0xaa, 255])
    // 原文件未动
    expect(readPsdBuffer(readFileSync(source), false).layers.map((l) => l.name)).toEqual(['底色', '圆柱体', '照片', '文案'])
  }, 30_000)

  it('Given 文字层改字后另存，When 读回，Then 内容更新、字号沿用、仍是文字层', async () => {
    const outputPsdPath = join(root, 'out', 'text-edited.psd')
    await editPsd(join(root, 'out', 'poster.psd'), [{ op: 'setText', layer: '3/0', text: '第二版' }], { roots: [root], baseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'text-edited-preview.png') })
    const tree = readPsdBuffer(readFileSync(outputPsdPath), true)
    const title = tree.layers[3]!.children![0]!
    expect(title.kind).toBe('text')
    expect(title.text).toBe('第二版')
    expect(tree.psd.children![3]!.children![0]!.text?.style?.fontSize).toBe(20)
  }, 30_000)

  it('Given 引用了不存在的图层名 / 对非文字层改字，When 编辑，Then 拒绝且不写文件', async () => {
    const outputPsdPath = join(root, 'out', 'never.psd')
    await expect(editPsd(join(root, 'out', 'poster.psd'), [{ op: 'rename', layer: '不存在', name: 'x' }], { roots: [root], baseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'never.png') })).rejects.toThrow(/找不到图层/)
    await expect(editPsd(join(root, 'out', 'poster.psd'), [{ op: 'setText', layer: '底色', text: 'x' }], { roots: [root], baseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'never.png') })).rejects.toThrow(/不是文字层/)
    expect(existsSync(outputPsdPath)).toBe(false)
  }, 30_000)
})

const extrasSpec = {
  width: 200,
  height: 120,
  background: '#ffffff',
  layers: [
    { type: 'fill', name: '底', color: '#2244aa' },
    { type: 'shape', name: '圆', shape: 'ellipse', left: 20, top: 20, width: 40, height: 40, fill: '#ff0000' },
    { type: 'adjustment', name: '反相', adjustment: 'invert', clipToBelow: true },
    { type: 'artboard', name: '画板', left: 100, top: 0, width: 100, height: 120, background: '#00ff00', children: [
      { type: 'image', name: '智能', source: 'assets/photo.png', left: 10, top: 10, width: 20, height: 20, smartObject: true },
      { type: 'shape', name: '角标', shape: 'polygon', points: [[60, 60], [90, 60], [75, 90]], fill: '#0000ff', stroke: { color: '#000000', width: 1 } },
      { type: 'text', name: '字', text: 'AB', fontSize: 16, color: '#000000', left: 10, top: 90, width: 80 },
    ] },
    { type: 'adjustment', name: '纯色', adjustment: 'solid color', color: '#123456', mask: { rect: { left: 0, top: 100, width: 50, height: 20 } } },
  ],
}

describe('PSD 服务：形状 / 调整 / 画板 / 智能对象', () => {
  it('Given 含新图层类型的规格，When 合成，Then 预览像素正确、图层树类型正确、文件里有矢量 / 调整 / 画板 / 嵌入文件', async () => {
    const outputPsdPath = join(root, 'out', 'extras.psd')
    const result = await composePsd(extrasSpec, { roots: [root], specBaseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'extras-preview.png') })
    expect(result.layers.map((l) => l.kind)).toEqual(['pixel', 'shape', 'adjustment', 'artboard', 'adjustment'])
    expect(result.layers[3]!.children!.map((l) => l.kind)).toEqual(['smart-object', 'shape', 'text'])
    expect(result.layers[3]!.bounds).toEqual({ left: 100, top: 0, right: 200, bottom: 120 })
    const preview = readFileSync(result.previewPngPath)
    // 圆内被反相成青色，圆外底色不受影响（剪贴只作用于圆）
    expect(await pixelAt(preview, 40, 40)).toEqual([0, 255, 255, 255])
    expect(await pixelAt(preview, 5, 5)).toEqual([0x22, 0x44, 0xaa, 255])
    // 画板底色、画板里的智能对象（相对画板坐标 10,10 → 文档 110,10）、角标
    expect(await pixelAt(preview, 105, 5)).toEqual([0, 255, 0, 255])
    expect(await pixelAt(preview, 120, 20)).toEqual([0, 200, 0, 255])
    expect(await pixelAt(preview, 175, 66)).toEqual([0, 0, 255, 255])
    // 纯色填充层只在蒙版矩形内
    expect(await pixelAt(preview, 10, 110)).toEqual([0x12, 0x34, 0x56, 255])
    expect(await pixelAt(preview, 80, 110)).toEqual([0x22, 0x44, 0xaa, 255])
    const tree = readPsdBuffer(readFileSync(outputPsdPath), true)
    expect(tree.layers.map((l) => l.kind)).toEqual(['pixel', 'shape', 'adjustment', 'artboard', 'adjustment'])
    expect(tree.layers[3]!.children!.map((l) => l.kind)).toEqual(['smart-object', 'shape', 'text'])
    expect(tree.psd.artboards?.count).toBe(1)
    expect(tree.psd.linkedFiles?.length).toBe(1)
    expect(tree.psd.linkedFiles?.[0]?.name).toBe('photo.png')
    expect(tree.psd.children![1]!.vectorMask?.paths[0]?.knots).toHaveLength(4)
    expect(tree.psd.children![2]!.adjustment?.type).toBe('invert')
    // 画板里的角标路径已经平移到文档坐标
    const badge = tree.psd.children![3]!.children![1]!
    expect(badge.vectorMask?.paths[0]?.knots[0]?.points[2]).toBeCloseTo(160, 2)
    expect(badge.vectorMask?.paths[0]?.knots[0]?.points[3]).toBeCloseTo(60, 2)
  }, 30_000)

  it('Given 合成出的文件，When 单独导出图层，Then 形状层裁到外接矩形、画板导出整块、调整层拒绝', async () => {
    const psdPath = join(root, 'out', 'extras.psd')
    const circle = await renderPsdLayer(psdPath, '圆', { forceBuiltin: true })
    expect(circle.engine).toBe('ag-psd')
    expect(circle.kind).toBe('shape')
    expect(circle.bounds).toEqual({ left: 20, top: 20, right: 60, bottom: 60 })
    expect((await sharp(circle.png).metadata()).width).toBe(40)
    expect(await pixelAt(circle.png, 20, 20)).toEqual([255, 0, 0, 255])
    expect((await pixelAt(circle.png, 1, 1))[3]).toBe(0)
    const board = await renderPsdLayer(psdPath, '3', { forceBuiltin: true, maxSide: 50 })
    expect(board.kind).toBe('artboard')
    expect(board.bounds).toEqual({ left: 100, top: 0, right: 200, bottom: 120 })
    expect((await sharp(board.png).metadata()).height).toBe(50)
    await expect(renderPsdLayer(psdPath, '反相', { forceBuiltin: true })).rejects.toThrow(/没有可导出的像素/)
    await expect(renderPsdLayer(psdPath, '9/9', { forceBuiltin: true })).rejects.toThrow(/找不到图层/)
  }, 30_000)

  it('Given 已有文件，When 用 addLayer 加形状与调整层，Then 新文件里有矢量路径与调整参数且预览反映效果', async () => {
    const source = join(root, 'out', 'poster.psd')
    const outputPsdPath = join(root, 'out', 'poster-extras.psd')
    const result = await editPsd(source, [
      { op: 'addLayer', spec: { type: 'shape', name: '徽章', shape: 'rect', left: 150, top: 80, width: 30, height: 20, radius: 5, fill: '#ffff00' } },
      { op: 'addLayer', spec: { type: 'adjustment', name: '去色', adjustment: 'black & white' } },
    ], { roots: [root], baseDir: root, outputPsdPath, previewPngPath: join(root, 'out', 'poster-extras-preview.png') })
    expect(result.layers.slice(-2).map((l) => `${l.kind}:${l.name}`)).toEqual(['shape:徽章', 'adjustment:去色'])
    const tree = readPsdBuffer(readFileSync(outputPsdPath), false)
    expect(tree.psd.children![4]!.vectorMask?.paths[0]?.knots).toHaveLength(8)
    expect(tree.psd.children![5]!.adjustment?.type).toBe('black & white')
    // 去色后底色三通道相等
    const [r, g, b] = await pixelAt(readFileSync(result.previewPngPath), 5, 5)
    expect(r).toBe(g)
    expect(g).toBe(b)
  }, 30_000)
})
