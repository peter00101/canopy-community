/**
 * PSD 服务：合成（规格 → .psd + 预览图）、读取（图层树 + 合成图）、编辑（按图层改文字 / 换图 / 显隐等）。
 *
 * 引擎：内置 ag-psd + sharp 是地板（随包分发、零用户侧依赖）；用户机器上有 Python + psd-tools 时，
 * **读取与合成**优先走它（调整层 / 复杂混合 / Photoshop 效果的渲染更准），写入永远走 ag-psd。
 * 任何一步桥接失败都回退到内置路径，并在 warnings 里说明。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import type { Layer } from 'ag-psd'
import type { PsdLayerNode } from '@canopy/shared'
import {
  normalizePsdSpec,
  type NormalizedPsdLayer,
  type NormalizedPsdSpec,
  type PsdAdjustmentParams,
  type PsdEffectsSpec,
  type PsdLayerSpec,
  type PsdShapeLayerSpec,
  type PsdTextLayerSpec,
} from './psd-spec'
import { renderTextToPng, toPostScriptFontName } from './psd-text-render'
import {
  bitmapToPng,
  compositeDocument,
  decodeImageToBitmap,
  decodeMaskToAlpha,
  featherAlpha,
  renderLayerAlone,
  type CompositeArtboard,
  type CompositeLayer,
} from './psd-compositor'
import {
  attachDocResources,
  buildAgPsd,
  buildCompositeLayersFromPsd,
  encodePsd,
  findAgLayer,
  findAgLayerParent,
  findCompositeLayer,
  findLayerIdByName,
  readPsdBuffer,
  toAgLayer,
  type PsdDocLayer,
} from './psd-document'
import { createBitmap, createRectMask, parseHexColor, placeOnCanvas, toHexColor, type RgbaBitmap } from './psd-image-ops'
import { PsdAccessError, resolveReadableAssetPath } from './psd-paths'
import { getPsdToolsAvailability, psdToolsComposite, psdToolsInspect, psdToolsLayerPng, type PsdToolsLayerNode } from './psd-tools-bridge'
import { PsdVectorError, geometryToBezierPaths, geometryToSvg, translateBezierPaths, type ShapeGeometry } from './psd-vector'

export type PsdEngine = 'psd-tools' | 'ag-psd'

/** 给模型看的预览图最长边：够看清版式，又不至于撑爆上下文 */
export const MODEL_PREVIEW_MAX_SIDE = 1280
/** 内置引擎重新合成的像素预算（宽 × 高 × 图层数） */
const RECOMPOSE_PIXEL_BUDGET = 400_000_000

export interface PsdComposeContext {
  roots: readonly string[]
  /** 规格里相对路径的基准目录 */
  specBaseDir: string
  outputPsdPath: string
  previewPngPath: string
  modelPreviewMaxSide?: number
}

export interface PsdComposeResult {
  psdPath: string
  previewPngPath: string
  width: number
  height: number
  layerCount: number
  layers: PsdLayerNode[]
  warnings: string[]
  /** 给模型看的缩小版预览 */
  previewPng: Buffer
}

interface RenderedLayer {
  doc: PsdDocLayer
  composite: CompositeLayer
}

function buildFillSvg(width: number, height: number, color: string, radius: number): string {
  const c = parseHexColor(color)
  const opacity = (c.a / 255).toFixed(3)
  const fill = toHexColor(c)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}"><rect x="0" y="0" width="${Math.round(width)}" height="${Math.round(height)}" rx="${Math.round(radius)}" ry="${Math.round(radius)}" fill="${fill}" fill-opacity="${opacity}"/></svg>`
}

async function pngToBitmap(png: Buffer): Promise<RgbaBitmap> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data }
}

interface Offset {
  x: number
  y: number
}

const NO_OFFSET: Offset = { x: 0, y: 0 }

async function renderMask(spec: NormalizedPsdLayer, doc: NormalizedPsdSpec, ctx: PsdComposeContext, offset: Offset): Promise<Buffer | undefined> {
  const mask = spec.mask
  if (!mask) return undefined
  if (mask.source) {
    const path = resolveReadableAssetPath(mask.source, ctx.roots, ctx.specBaseDir)
    return decodeMaskToAlpha(path, doc.width, doc.height, mask.feather)
  }
  if (mask.rect) {
    const rect = { ...mask.rect, left: mask.rect.left + offset.x, top: mask.rect.top + offset.y }
    return featherAlpha(createRectMask(doc.width, doc.height, rect), doc.width, doc.height, mask.feather)
  }
  return undefined
}

function shapeGeometry(spec: PsdShapeLayerSpec): ShapeGeometry {
  switch (spec.shape) {
    case 'rect':
      return { shape: 'rect', left: spec.left ?? 0, top: spec.top ?? 0, width: spec.width ?? 1, height: spec.height ?? 1, radius: spec.radius ?? 0 }
    case 'ellipse':
      return { shape: 'ellipse', left: spec.left ?? 0, top: spec.top ?? 0, width: spec.width ?? 1, height: spec.height ?? 1 }
    case 'polygon':
      return { shape: 'polygon', points: spec.points ?? [] }
    default:
      return { shape: 'path', d: spec.d ?? '' }
  }
}

/** 智能对象嵌入文件的 4 字符类型签名（Photoshop 口径） */
function placedFileType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'png '
    case '.jpg':
    case '.jpeg':
      return 'JPEG'
    case '.gif':
      return 'GIFf'
    case '.tif':
    case '.tiff':
      return 'TIFF'
    case '.webp':
      return 'WEBP'
    case '.bmp':
      return 'BMP '
    default:
      return null
  }
}

function adjustmentParams(spec: Extract<PsdLayerSpec, { type: 'adjustment' }>): PsdAdjustmentParams {
  const { type: _type, name: _name, adjustment, hidden: _h, opacity: _o, blendMode: _b, effects: _e, mask: _m, clipToBelow: _c, ...rest } = spec
  const params: PsdAdjustmentParams = { kind: adjustment }
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (params as unknown as Record<string, unknown>)[key] = value
  }
  return params
}

/** 把一层归一化规格渲染成文档尺寸位图（分组 / 画板递归；offset 是画板原点，子层坐标相对画板） */
export async function renderSpecLayer(
  layer: NormalizedPsdLayer,
  doc: NormalizedPsdSpec,
  ctx: PsdComposeContext,
  warnings: string[],
  offset: Offset = NO_OFFSET,
): Promise<RenderedLayer> {
  const base = {
    id: layer.id,
    name: layer.name,
    hidden: layer.hidden,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
  }
  const mask = await renderMask(layer, doc, ctx, offset)
  const spec = layer.spec
  if (spec.type === 'group') {
    const children = await Promise.all((layer.children ?? []).map((child) => renderSpecLayer(child, doc, ctx, warnings, offset)))
    return {
      doc: { ...base, kind: 'group', clipping: layer.clipToBelow, mask, effects: layer.effects, opened: spec.opened !== false, children: children.map((c) => c.doc) },
      composite: { ...base, kind: 'group', clipToBelow: layer.clipToBelow, mask, effects: layer.effects, children: children.map((c) => c.composite) },
    }
  }
  if (spec.type === 'artboard') {
    const board: CompositeArtboard = { left: spec.left + offset.x, top: spec.top + offset.y, width: spec.width, height: spec.height, background: spec.background ?? '#ffffff' }
    const children = await Promise.all((layer.children ?? []).map((child) => renderSpecLayer(child, doc, ctx, warnings, { x: board.left, y: board.top })))
    return {
      doc: { ...base, kind: 'artboard', clipping: false, mask, effects: layer.effects, opened: true, artboard: board, children: children.map((c) => c.doc) },
      composite: { ...base, kind: 'group', clipToBelow: false, mask, effects: layer.effects, artboard: board, children: children.map((c) => c.composite) },
    }
  }
  if (spec.type === 'adjustment') {
    const params = adjustmentParams(spec)
    const docLayer: PsdDocLayer = { ...base, kind: 'adjustment', clipping: layer.clipToBelow, mask, effects: layer.effects, adjustment: params }
    if (params.kind === 'solid color') {
      // 纯色填充层：Photoshop 里是填充层，预览里就是一张铺满画布的纯色
      const bitmap = createBitmap(doc.width, doc.height, parseHexColor(params.color ?? '#000000'))
      return { doc: docLayer, composite: { ...base, kind: 'pixel', clipToBelow: layer.clipToBelow, bitmap, mask, effects: layer.effects } }
    }
    return { doc: docLayer, composite: { ...base, kind: 'adjustment', clipToBelow: layer.clipToBelow, mask, adjustment: params } }
  }

  let bitmap: RgbaBitmap
  let text: PsdDocLayer['text']
  let kind: PsdDocLayer['kind'] = 'pixel'
  let vector: PsdDocLayer['vector']
  let placed: PsdDocLayer['placed']
  if (spec.type === 'image') {
    const path = resolveReadableAssetPath(spec.source, ctx.roots, ctx.specBaseDir)
    const decoded = await decodeImageToBitmap(path, { width: spec.width, height: spec.height, fit: spec.fit })
    const left = (spec.left ?? 0) + offset.x
    const top = (spec.top ?? 0) + offset.y
    bitmap = placeOnCanvas(decoded, left, top, doc.width, doc.height)
    if (spec.smartObject) {
      const fileType = placedFileType(path)
      if (!fileType) {
        warnings.push(`「${layer.name}」的 ${extname(path) || '未知'} 文件不能作为智能对象嵌入（支持 png / jpg / gif / tif / webp / bmp），已按普通像素层写入`)
      } else {
        const data = await readFile(path)
        const meta = await sharp(data).metadata()
        kind = 'smart-object'
        placed = { id: randomUUID(), name: basename(path), data, fileType, sourceWidth: meta.width ?? decoded.width, sourceHeight: meta.height ?? decoded.height, left, top, width: decoded.width, height: decoded.height }
      }
    }
  } else if (spec.type === 'svg') {
    const input = spec.svg ? Buffer.from(spec.svg, 'utf8') : resolveReadableAssetPath(spec.source ?? '', ctx.roots, ctx.specBaseDir)
    const decoded = await decodeImageToBitmap(input, { width: spec.width, height: spec.height, fit: 'fill' })
    bitmap = placeOnCanvas(decoded, (spec.left ?? 0) + offset.x, (spec.top ?? 0) + offset.y, doc.width, doc.height)
  } else if (spec.type === 'fill') {
    const svg = buildFillSvg(spec.width ?? doc.width, spec.height ?? doc.height, spec.color, spec.radius ?? 0)
    const decoded = await decodeImageToBitmap(Buffer.from(svg, 'utf8'))
    bitmap = placeOnCanvas(decoded, (spec.left ?? 0) + offset.x, (spec.top ?? 0) + offset.y, doc.width, doc.height)
  } else if (spec.type === 'shape') {
    const geometry = shapeGeometry(spec)
    const style = { fill: spec.fill === undefined ? '#000000' : spec.fill, stroke: spec.stroke }
    try {
      const paths = translateBezierPaths(geometryToBezierPaths(geometry), offset.x, offset.y)
      kind = 'shape'
      vector = { paths, fill: style.fill, stroke: spec.stroke }
    } catch (error) {
      if (!(error instanceof PsdVectorError)) throw error
      warnings.push(`「${layer.name}」的路径无法转成 Photoshop 矢量（${error.message}），已按普通像素层写入`)
    }
    bitmap = await decodeImageToBitmap(Buffer.from(geometryToSvg(geometry, style, doc.width, doc.height, offset), 'utf8'))
  } else {
    kind = 'text'
    const left = (spec.left ?? 0) + offset.x
    const top = (spec.top ?? 0) + offset.y
    const boxWidth = spec.width ?? Math.max(1, doc.width - left)
    const rendered = await renderTextToPng({
      text: spec.text,
      font: spec.font ?? 'Microsoft YaHei',
      fontSize: spec.fontSize ?? 32,
      color: spec.color ?? '#000000',
      bold: spec.bold === true,
      italic: spec.italic === true,
      align: spec.align ?? 'left',
      width: boxWidth,
      lineHeight: spec.lineHeight ?? 1.3,
      letterSpacing: spec.letterSpacing ?? 0,
    })
    const decoded = await pngToBitmap(rendered.png)
    const align = spec.align ?? 'left'
    const alignShift = align === 'center' ? (boxWidth - decoded.width) / 2 : align === 'right' ? boxWidth - decoded.width : 0
    bitmap = placeOnCanvas(decoded, left + Math.max(0, alignShift), top, doc.width, doc.height)
    if (decoded.width > boxWidth + 1) warnings.push(`「${layer.name}」文字比文本框宽（${decoded.width} > ${boxWidth}），已从左侧起排；加大 width 或减小字号`)
    if (top + decoded.height > doc.height || left + decoded.width > doc.width) warnings.push(`「${layer.name}」文字超出画布，超出部分被裁掉`)
    text = { spec, box: { left, top, width: boxWidth, height: decoded.height } }
  }
  return {
    doc: { ...base, kind, clipping: layer.clipToBelow, bitmap, mask, effects: layer.effects, text, vector, placed },
    composite: { ...base, kind: kind === 'text' ? 'text' : 'pixel', clipToBelow: layer.clipToBelow, bitmap, mask, effects: layer.effects },
  }
}

async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

function countLayers(nodes: PsdLayerNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countLayers(node.children) : 0), 0)
}

function docLayersToNodes(layers: PsdDocLayer[]): PsdLayerNode[] {
  return layers.map((layer) => {
    const node: PsdLayerNode = {
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      hidden: layer.hidden,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
    }
    if (layer.artboard) node.bounds = { left: layer.artboard.left, top: layer.artboard.top, right: layer.artboard.left + layer.artboard.width, bottom: layer.artboard.top + layer.artboard.height }
    if (layer.text) node.text = layer.text.spec.text
    if (layer.mask) node.hasMask = true
    if (layer.clipping) node.clipping = true
    if (layer.effects) node.effects = Object.keys(layer.effects)
    if (layer.children) node.children = docLayersToNodes(layer.children)
    return node
  })
}

/** 规格 → .psd + 预览 PNG */
export async function composePsd(specInput: unknown, ctx: PsdComposeContext): Promise<PsdComposeResult> {
  const spec = normalizePsdSpec(specInput)
  const warnings = [...spec.warnings]
  const rendered: RenderedLayer[] = []
  for (const layer of spec.layers) rendered.push(await renderSpecLayer(layer, spec, ctx, warnings))
  const docLayers = rendered.map((r) => r.doc)
  const { bitmap: composite, warnings: compositeWarnings } = await compositeDocument(
    { width: spec.width, height: spec.height, background: spec.background },
    rendered.map((r) => r.composite),
  )
  warnings.push(...compositeWarnings)
  const psd = buildAgPsd({ width: spec.width, height: spec.height, dpi: spec.dpi, guides: spec.guides }, docLayers, composite)
  const encoded = encodePsd(psd)
  await writeFileAtomic(ctx.outputPsdPath, encoded)
  const previewPng = await bitmapToPng(composite)
  await writeFileAtomic(ctx.previewPngPath, previewPng)
  const layers = docLayersToNodes(docLayers)
  return {
    psdPath: ctx.outputPsdPath,
    previewPngPath: ctx.previewPngPath,
    width: spec.width,
    height: spec.height,
    layerCount: countLayers(layers),
    layers,
    warnings: [...new Set(warnings)],
    previewPng: await bitmapToPng(composite, ctx.modelPreviewMaxSide ?? MODEL_PREVIEW_MAX_SIDE),
  }
}

export interface PsdRenderOptions {
  hiddenIds?: readonly string[]
  visibleIds?: readonly string[]
  /** 输出最长边；缺省不缩放 */
  maxSide?: number
  /** 强制用内置引擎（测试与对照用） */
  forceBuiltin?: boolean
}

export interface PsdRenderResult {
  width: number
  height: number
  colorMode: string
  layers: PsdLayerNode[]
  png: Buffer
  engine: PsdEngine
  warnings: string[]
}

const KIND_MAP: Record<string, PsdLayerNode['kind']> = {
  group: 'group', artboard: 'artboard', pixel: 'pixel', text: 'text', adjustment: 'adjustment', 'smart-object': 'smart-object', shape: 'shape',
}

function fromPsdToolsNodes(nodes: PsdToolsLayerNode[]): PsdLayerNode[] {
  return nodes.map((n) => {
    const node: PsdLayerNode = {
      id: n.id,
      name: n.name,
      kind: KIND_MAP[n.kind] ?? 'pixel',
      hidden: n.hidden,
      opacity: n.opacity,
      blendMode: n.blendMode,
      bounds: n.bounds,
    }
    if (n.text) node.text = n.text
    if (n.hasMask) node.hasMask = true
    if (n.clipping) node.clipping = true
    if (n.effects?.length) node.effects = n.effects
    if (n.children) node.children = fromPsdToolsNodes(n.children)
    return node
  })
}

async function tempPngPath(): Promise<string> {
  const dir = join(tmpdir(), 'canopy-preview')
  await mkdir(dir, { recursive: true })
  return join(dir, `psd-${randomUUID()}.png`)
}

async function renderWithPsdTools(psdPath: string, options: PsdRenderOptions): Promise<PsdRenderResult | null> {
  const availability = await getPsdToolsAvailability()
  if (!availability.available) return null
  const out = await tempPngPath()
  try {
    const info = await psdToolsInspect(psdPath)
    const composite = await psdToolsComposite(psdPath, out, { hiddenIds: options.hiddenIds, visibleIds: options.visibleIds, maxSide: options.maxSide })
    if (!info || !composite) return null
    const png = await readFile(out)
    return { width: info.width, height: info.height, colorMode: info.colorMode, layers: fromPsdToolsNodes(info.layers), png, engine: 'psd-tools', warnings: [] }
  } finally {
    await rm(out, { force: true }).catch(() => undefined)
  }
}

async function renderWithBuiltin(psdPath: string, options: PsdRenderOptions): Promise<PsdRenderResult> {
  const buffer = await readFile(psdPath)
  const overrides = Boolean(options.hiddenIds?.length || options.visibleIds?.length)
  const meta = readPsdBuffer(buffer, false)
  const warnings = [...meta.warnings]
  let composite: RgbaBitmap | null = null
  if (!overrides && meta.composite) {
    composite = meta.composite
  } else {
    const layerCount = countLayers(meta.layers)
    if (meta.width * meta.height * Math.max(1, layerCount) > RECOMPOSE_PIXEL_BUDGET) {
      if (meta.composite) {
        warnings.push('文件太大，内置引擎不重新合成，显示的是文件自带的合成图（图层显隐改写未生效）')
        composite = meta.composite
      } else {
        throw new PsdAccessError('文件太大且没有自带合成图，内置引擎无法渲染；安装 Python + psd-tools 后可用高保真引擎')
      }
    } else {
      const full = readPsdBuffer(buffer, true)
      warnings.push(...full.warnings)
      const result = await compositeDocument(
        { width: full.width, height: full.height, background: null },
        full.compositeLayers,
        { hiddenIds: new Set(options.hiddenIds ?? []), visibleIds: new Set(options.visibleIds ?? []) },
      )
      warnings.push(...result.warnings)
      composite = result.bitmap
      if (!overrides) warnings.push('文件没有自带合成图，预览由内置引擎按图层合成')
    }
  }
  return {
    width: meta.width,
    height: meta.height,
    colorMode: meta.colorMode,
    layers: meta.layers,
    png: await bitmapToPng(composite, options.maxSide),
    engine: 'ag-psd',
    warnings: [...new Set(warnings)],
  }
}

/** 读取 + 合成一份 PSD（优先 psd-tools，失败回退内置） */
export async function renderPsd(psdPath: string, options: PsdRenderOptions = {}): Promise<PsdRenderResult> {
  if (!options.forceBuiltin) {
    try {
      const viaTools = await renderWithPsdTools(psdPath, options)
      if (viaTools) return viaTools
    } catch (error) {
      const builtin = await renderWithBuiltin(psdPath, options)
      builtin.warnings.unshift(`psd-tools 引擎失败，已回退内置引擎：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return builtin
    }
  }
  return renderWithBuiltin(psdPath, options)
}

export interface PsdLayerRenderOptions {
  maxSide?: number
  forceBuiltin?: boolean
}

export interface PsdLayerRenderResult {
  layerId: string
  name: string
  kind: PsdLayerNode['kind']
  /** 像素外接矩形（文档坐标） */
  bounds: { left: number; top: number; right: number; bottom: number }
  /** 透明背景、裁到外接矩形的 PNG */
  png: Buffer
  engine: PsdEngine
  warnings: string[]
}

function findNode(nodes: PsdLayerNode[], id: string): PsdLayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const hit = findNode(node.children, id)
      if (hit) return hit
    }
  }
  return null
}

async function resizePng(png: Buffer, maxSide?: number): Promise<Buffer> {
  if (!maxSide) return png
  const meta = await sharp(png).metadata()
  if ((meta.width ?? 0) <= maxSide && (meta.height ?? 0) <= maxSide) return png
  return sharp(png).resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
}

/** 单独导出一个图层（分组 / 画板则是其子层的独立合成），透明背景；优先 psd-tools，失败回退内置 */
export async function renderPsdLayer(psdPath: string, ref: string, options: PsdLayerRenderOptions = {}): Promise<PsdLayerRenderResult> {
  if (!options.forceBuiltin) {
    try {
      const availability = await getPsdToolsAvailability()
      if (availability.available) {
        const info = await psdToolsInspect(psdPath)
        if (info) {
          const layers = fromPsdToolsNodes(info.layers)
          const id = resolveLayerRef(layers, ref)
          const node = findNode(layers, id)
          const out = await tempPngPath()
          try {
            const result = await psdToolsLayerPng(psdPath, id, out)
            if (result && node) {
              const png = await resizePng(await readFile(out), options.maxSide)
              return { layerId: id, name: node.name, kind: node.kind, bounds: result.bounds, png, engine: 'psd-tools', warnings: result.warning ? [result.warning] : [] }
            }
          } finally {
            await rm(out, { force: true }).catch(() => undefined)
          }
        }
      }
    } catch (error) {
      if (error instanceof PsdAccessError) throw error
      const builtin = await renderLayerWithBuiltin(psdPath, ref, options)
      builtin.warnings.unshift(`psd-tools 引擎失败，已回退内置引擎：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return builtin
    }
  }
  return renderLayerWithBuiltin(psdPath, ref, options)
}

async function renderLayerWithBuiltin(psdPath: string, ref: string, options: PsdLayerRenderOptions): Promise<PsdLayerRenderResult> {
  const buffer = await readFile(psdPath)
  const meta = readPsdBuffer(buffer, false)
  const id = resolveLayerRef(meta.layers, ref)
  const node = findNode(meta.layers, id)
  if (!node) throw new PsdAccessError(`找不到图层 id ${id}`)
  if (meta.width * meta.height * Math.max(1, countLayers(meta.layers)) > RECOMPOSE_PIXEL_BUDGET) {
    throw new PsdAccessError('文件太大，内置引擎无法单独渲染图层；安装 Python + psd-tools 后可用高保真引擎')
  }
  const full = readPsdBuffer(buffer, true)
  const layer = findCompositeLayer(full.compositeLayers, id)
  if (!layer) throw new PsdAccessError(`找不到图层 id ${id}`)
  const rendered = await renderLayerAlone({ width: full.width, height: full.height, background: null }, layer)
  if (!rendered) throw new PsdAccessError(`图层「${node.name}」没有可导出的像素（${node.kind === 'adjustment' ? '调整层本身没有像素' : '全透明'}）`)
  return {
    layerId: id,
    name: node.name,
    kind: node.kind,
    bounds: rendered.bounds,
    png: await bitmapToPng(rendered.bitmap, options.maxSide),
    engine: 'ag-psd',
    warnings: [...new Set([...full.warnings, ...rendered.warnings])],
  }
}

/* ------------------------------------------------------------------ 编辑 ------------------------------------------------------------------ */

export type PsdEditOperation =
  | { op: 'setText'; layer: string; text?: string; font?: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; width?: number; lineHeight?: number; letterSpacing?: number }
  | { op: 'replaceImage'; layer: string; source: string; fit?: 'contain' | 'cover' | 'fill' | 'natural' }
  | { op: 'setVisible'; layer: string; hidden: boolean }
  | { op: 'setOpacity'; layer: string; opacity: number }
  | { op: 'setBlendMode'; layer: string; blendMode: string }
  | { op: 'move'; layer: string; left: number; top: number }
  | { op: 'rename'; layer: string; name: string }
  | { op: 'remove'; layer: string }
  | { op: 'setEffects'; layer: string; effects: PsdEffectsSpec | null }
  | { op: 'addLayer'; spec: PsdLayerSpec; above?: string }

export interface PsdEditContext {
  roots: readonly string[]
  /** 相对路径基准 */
  baseDir: string
  outputPsdPath: string
  previewPngPath: string
  modelPreviewMaxSide?: number
}

export interface PsdEditResult {
  outputPath: string
  previewPngPath: string
  applied: string[]
  layers: PsdLayerNode[]
  warnings: string[]
  previewPng: Buffer
}

/** 反查 PostScript 名对应的家族名（编辑已有文字层时渲染用） */
function familyFromPostScript(name: string | undefined): string | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  if (lower.startsWith('microsoftyahei')) return 'Microsoft YaHei'
  if (lower.startsWith('simhei')) return 'SimHei'
  if (lower.startsWith('simsun')) return 'SimSun'
  if (lower.startsWith('pingfang')) return 'PingFang SC'
  if (lower.startsWith('sourcehansans')) return 'Source Han Sans SC'
  if (lower.startsWith('sourcehanserif')) return 'Source Han Serif SC'
  if (lower.startsWith('notosanscjk')) return 'Noto Sans CJK SC'
  if (lower.startsWith('arial')) return 'Arial'
  if (lower.startsWith('helvetica')) return 'Helvetica'
  if (lower.startsWith('timesnewroman')) return 'Times New Roman'
  if (lower.startsWith('segoeui')) return 'Segoe UI'
  return name.replace(/-(bold|regular|italic|light|medium|semibold)$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')
}

function colorOf(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) return toHexColor(value as { r: number; g: number; b: number })
  return undefined
}

function resolveLayerRef(nodes: PsdLayerNode[], ref: string): string {
  const trimmed = ref.trim()
  if (/^\d+(\/\d+)*$/.test(trimmed)) {
    if (!findNode(nodes, trimmed)) throw new PsdAccessError(`找不到图层 id ${trimmed}（先用 PsdInspect 看图层树）`)
    return trimmed
  }
  const byName = findLayerIdByName(nodes, trimmed)
  if (!byName) throw new PsdAccessError(`找不到图层「${ref}」（先用 PsdInspect 看图层树，按名字或 id 引用）`)
  return byName
}

/** 按操作列表编辑一份 PSD，写到 outputPsdPath */
export async function editPsd(psdPath: string, operations: PsdEditOperation[], ctx: PsdEditContext): Promise<PsdEditResult> {
  const buffer = await readFile(psdPath)
  const parsed = readPsdBuffer(buffer, true)
  const psd = parsed.psd
  const doc = { width: psd.width, height: psd.height }
  const layerCount = countLayers(parsed.layers)
  if (doc.width * doc.height * Math.max(1, layerCount) > RECOMPOSE_PIXEL_BUDGET) {
    throw new PsdAccessError('文件太大，内置引擎无法重新合成；请缩小文档或在 Photoshop 里编辑')
  }
  const warnings = [...parsed.warnings]
  const applied: string[] = []
  const editWarnings: string[] = []
  const compose: PsdComposeContext = { roots: ctx.roots, specBaseDir: ctx.baseDir, outputPsdPath: ctx.outputPsdPath, previewPngPath: ctx.previewPngPath }

  const getLayer = (ref: string): { id: string; layer: Layer } => {
    const id = resolveLayerRef(parsed.layers, ref)
    const layer = findAgLayer(psd, id)
    if (!layer) throw new PsdAccessError(`找不到图层 id ${id}`)
    return { id, layer }
  }
  const setPixels = (layer: Layer, bitmap: RgbaBitmap, left: number, top: number): void => {
    const rendered = toAgLayer({ id: '', name: layer.name ?? '', kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, bitmap: placeOnCanvas(bitmap, left, top, doc.width, doc.height) }, { width: doc.width, height: doc.height, dpi: 72 })
    layer.imageData = rendered.imageData
    layer.left = rendered.left
    layer.top = rendered.top
    layer.right = rendered.right
    layer.bottom = rendered.bottom
    if (!rendered.imageData) {
      layer.left = left
      layer.top = top
      layer.right = left
      layer.bottom = top
    }
  }

  for (const [index, operation] of operations.entries()) {
    const label = `#${index + 1} ${operation.op}`
    switch (operation.op) {
      case 'setText': {
        const { layer } = getLayer(operation.layer)
        if (!layer.text) throw new PsdAccessError(`${label}：「${operation.layer}」不是文字层`)
        const style = layer.text.style ?? {}
        const family = operation.font ?? familyFromPostScript(style.font?.name) ?? 'Microsoft YaHei'
        const fontSize = operation.fontSize ?? style.fontSize ?? 32
        const color = operation.color ?? colorOf(style.fillColor) ?? '#000000'
        const bold = operation.bold ?? (style.fauxBold === true || /bold/i.test(style.font?.name ?? ''))
        const italic = operation.italic ?? style.fauxItalic === true
        const justification = layer.text.paragraphStyle?.justification
        const align = operation.align ?? (justification === 'center' ? 'center' : justification === 'right' ? 'right' : 'left')
        const transform = layer.text.transform ?? [1, 0, 0, 1, layer.left ?? 0, layer.top ?? 0]
        const left = Math.round(transform[4] ?? layer.left ?? 0)
        const top = Math.round(transform[5] ?? layer.top ?? 0)
        const boxWidth = operation.width ?? (layer.text.boxBounds?.[2] ? Math.round(layer.text.boxBounds[2] - (layer.text.boxBounds[0] ?? 0)) : Math.max(1, doc.width - left))
        const lineHeight = operation.lineHeight ?? (style.leading && fontSize ? style.leading / fontSize : 1.3)
        const letterSpacing = operation.letterSpacing ?? (style.tracking ? (style.tracking / 1000) * fontSize : 0)
        const text = operation.text ?? layer.text.text.replace(/\r/g, '\n')
        const rendered = await renderTextToPng({ text, font: family, fontSize, color, bold, italic, align, width: boxWidth, lineHeight, letterSpacing })
        const decoded = await pngToBitmap(rendered.png)
        const offset = align === 'center' ? (boxWidth - decoded.width) / 2 : align === 'right' ? boxWidth - decoded.width : 0
        setPixels(layer, decoded, left + Math.max(0, offset), top)
        const font = toPostScriptFontName(family, bold)
        layer.text = {
          ...layer.text,
          text: text.replace(/\r?\n/g, '\r'),
          transform: [1, 0, 0, 1, left, top],
          shapeType: 'box',
          boxBounds: [0, 0, boxWidth, decoded.height],
          style: { ...style, font: { name: font.name }, fontSize, fauxBold: font.fauxBold, fauxItalic: italic, fillColor: (() => { const c = parseHexColor(color); return { r: c.r, g: c.g, b: c.b } })(), autoLeading: false, leading: Math.round(lineHeight * fontSize) },
          paragraphStyle: { ...(layer.text.paragraphStyle ?? {}), justification: align },
        }
        applied.push(`${label}：「${layer.name}」→ ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`)
        break
      }
      case 'replaceImage': {
        const { layer } = getLayer(operation.layer)
        if (layer.children) throw new PsdAccessError(`${label}：「${operation.layer}」是分组，不能换图`)
        const path = resolveReadableAssetPath(operation.source, ctx.roots, ctx.baseDir)
        const oldW = (layer.right ?? 0) - (layer.left ?? 0)
        const oldH = (layer.bottom ?? 0) - (layer.top ?? 0)
        const fit = operation.fit ?? (oldW > 0 && oldH > 0 ? 'fill' : 'natural')
        const decoded = fit === 'natural' || oldW <= 0 || oldH <= 0
          ? await decodeImageToBitmap(path)
          : await decodeImageToBitmap(path, { width: oldW, height: oldH, fit })
        setPixels(layer, decoded, layer.left ?? 0, layer.top ?? 0)
        delete layer.text
        applied.push(`${label}：「${layer.name}」← ${operation.source}`)
        break
      }
      case 'setVisible': {
        const { layer } = getLayer(operation.layer)
        layer.hidden = operation.hidden
        applied.push(`${label}：「${layer.name}」${operation.hidden ? '隐藏' : '显示'}`)
        break
      }
      case 'setOpacity': {
        const { layer } = getLayer(operation.layer)
        layer.opacity = Math.max(0, Math.min(1, operation.opacity))
        applied.push(`${label}：「${layer.name}」不透明度 ${Math.round(layer.opacity * 100)}%`)
        break
      }
      case 'setBlendMode': {
        const { layer } = getLayer(operation.layer)
        layer.blendMode = operation.blendMode as Layer['blendMode']
        applied.push(`${label}：「${layer.name}」混合模式 ${operation.blendMode}`)
        break
      }
      case 'move': {
        const { layer } = getLayer(operation.layer)
        const dx = Math.round(operation.left) - (layer.left ?? 0)
        const dy = Math.round(operation.top) - (layer.top ?? 0)
        const shift = (target: Layer): void => {
          if (typeof target.left === 'number') target.left += dx
          if (typeof target.right === 'number') target.right += dx
          if (typeof target.top === 'number') target.top += dy
          if (typeof target.bottom === 'number') target.bottom += dy
          if (target.text?.transform) {
            target.text.transform = [...target.text.transform]
            target.text.transform[4] = (target.text.transform[4] ?? 0) + dx
            target.text.transform[5] = (target.text.transform[5] ?? 0) + dy
          }
          if (target.mask && target.mask.positionRelativeToLayer !== true) {
            if (typeof target.mask.left === 'number') target.mask.left += dx
            if (typeof target.mask.right === 'number') target.mask.right += dx
            if (typeof target.mask.top === 'number') target.mask.top += dy
            if (typeof target.mask.bottom === 'number') target.mask.bottom += dy
          }
          target.children?.forEach(shift)
        }
        shift(layer)
        applied.push(`${label}：「${layer.name}」→ (${operation.left}, ${operation.top})`)
        break
      }
      case 'rename': {
        const { layer } = getLayer(operation.layer)
        const old = layer.name
        layer.name = operation.name.trim().slice(0, 255)
        applied.push(`${label}：「${old}」→「${layer.name}」`)
        break
      }
      case 'remove': {
        const { id, layer } = getLayer(operation.layer)
        const parent = findAgLayerParent(psd, id)
        if (!parent) throw new PsdAccessError(`${label}：找不到「${operation.layer}」的父级`)
        const idx = parent.indexOf(layer)
        if (idx >= 0) parent.splice(idx, 1)
        applied.push(`${label}：删除「${layer.name}」`)
        break
      }
      case 'setEffects': {
        const { layer } = getLayer(operation.layer)
        if (operation.effects === null) {
          delete layer.effects
          applied.push(`${label}：「${layer.name}」清除效果`)
        } else {
          const normalized = normalizePsdSpec({ width: doc.width, height: doc.height, layers: [{ type: 'fill', name: 'x', color: '#000000', effects: operation.effects }] })
          const effects = normalized.layers[0]?.effects
          const rendered = toAgLayer({ id: '', name: '', kind: 'pixel', hidden: false, opacity: 1, blendMode: 'normal', clipping: false, effects }, { width: doc.width, height: doc.height, dpi: 72 })
          layer.effects = rendered.effects
          editWarnings.push(...normalized.warnings)
          applied.push(`${label}：「${layer.name}」效果 ${Object.keys(effects ?? {}).join(' / ') || '无'}`)
        }
        break
      }
      case 'addLayer': {
        const normalized = normalizePsdSpec({ width: doc.width, height: doc.height, layers: [operation.spec] })
        editWarnings.push(...normalized.warnings)
        const target = normalized.layers[0]
        if (!target) throw new PsdAccessError(`${label}：图层规格为空`)
        const rendered = await renderSpecLayer(target, normalized, compose, editWarnings)
        const agLayer = toAgLayer(rendered.doc, { width: doc.width, height: doc.height, dpi: 72 })
        attachDocResources(psd, [rendered.doc])
        if (!psd.children) psd.children = []
        if (operation.above) {
          const { id, layer: anchor } = getLayer(operation.above)
          const parent = findAgLayerParent(psd, id) ?? psd.children
          const idx = parent.indexOf(anchor)
          parent.splice(idx + 1, 0, agLayer)
        } else {
          psd.children.push(agLayer)
        }
        applied.push(`${label}：新增「${target.name}」（${operation.spec.type}）`)
        break
      }
      default:
        throw new PsdAccessError(`不支持的操作：${JSON.stringify((operation as { op?: unknown }).op)}`)
    }
  }

  // 重新合成：优先内置（我们知道每层像素）；写入前把合成图塞回 psd.imageData 供看图软件与 Photoshop 预览用
  const compositeLayers = buildCompositeLayersFromPsd(psd, warnings)
  const { bitmap: composite, warnings: compositeWarnings } = await compositeDocument({ width: doc.width, height: doc.height, background: null }, compositeLayers)
  warnings.push(...compositeWarnings, ...editWarnings)
  psd.imageData = { width: composite.width, height: composite.height, data: new Uint8ClampedArray(composite.data.buffer, composite.data.byteOffset, composite.data.length) }
  await writeFileAtomic(ctx.outputPsdPath, encodePsd(psd))
  const previewPng = await bitmapToPng(composite)
  await writeFileAtomic(ctx.previewPngPath, previewPng)
  const reread = readPsdBuffer(await readFile(ctx.outputPsdPath), false)
  return {
    outputPath: ctx.outputPsdPath,
    previewPngPath: ctx.previewPngPath,
    applied,
    layers: reread.layers,
    warnings: [...new Set(warnings)],
    previewPng: await bitmapToPng(composite, ctx.modelPreviewMaxSide ?? MODEL_PREVIEW_MAX_SIDE),
  }
}

/** 图层树的文字摘要（给模型看） */
export function describeLayerTree(nodes: PsdLayerNode[], depth = 0): string {
  const lines: string[] = []
  const walk = (list: PsdLayerNode[], level: number): void => {
    // 自上而下列（面板顺序），所以倒着遍历
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!
      const flags: string[] = []
      if (node.hidden) flags.push('隐藏')
      if (node.opacity < 1) flags.push(`${Math.round(node.opacity * 100)}%`)
      if (node.blendMode && node.blendMode !== 'normal' && node.blendMode !== 'pass through') flags.push(node.blendMode)
      if (node.hasMask) flags.push('蒙版')
      if (node.clipping) flags.push('剪贴')
      if (node.effects?.length) flags.push(`效果:${node.effects.join('+')}`)
      const bounds = node.bounds ? ` @(${node.bounds.left},${node.bounds.top}) ${node.bounds.right - node.bounds.left}×${node.bounds.bottom - node.bounds.top}` : ''
      const text = node.text ? ` "${node.text.replace(/\s+/g, ' ').slice(0, 60)}${node.text.length > 60 ? '…' : ''}"` : ''
      lines.push(`${'  '.repeat(level)}[${node.id}] ${node.kind} ${node.name}${bounds}${text}${flags.length ? ` (${flags.join(', ')})` : ''}`)
      if (node.children) walk(node.children, level + 1)
    }
  }
  walk(nodes, depth)
  return lines.join('\n')
}
