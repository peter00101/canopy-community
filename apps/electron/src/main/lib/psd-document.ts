/**
 * ag-psd 的读写映射：Canopy 的「文档尺寸位图 + 规格」⇄ ag-psd 的 Psd / Layer 对象。
 *
 * 写：每层裁到不透明外接矩形后作为 imageData 写入；文字层同时写像素（我们渲染的）和文字数据
 * （Photoshop 可继续编辑）；蒙版按 ag-psd 约定用 RGBA 的红通道存灰度；效果映射到 Photoshop
 * 原生图层样式；形状层写矢量蒙版 + 填充 / 描边，调整层写调整参数，画板写画板矩形 + 文档级计数，
 * 智能对象写 placedLayer + 嵌入的原文件（linkedFiles）。
 * 读：返回中性图层树（@canopy/shared 的 PsdLayerNode）+ 用于重新合成的文档尺寸位图；
 * Photoshop 自己画的形状层没有像素时按矢量路径栅格化，纯色填充层铺满画布，调整层转成预览参数。
 */

import { initializeCanvas, readPsd, writePsdBuffer } from 'ag-psd'
import type { AdjustmentLayer, BezierPath, BlendMode as AgBlendMode, Layer, LayerEffectsInfo, LinkedFile, Psd, ReadOptions } from 'ag-psd'

// ag-psd 默认靠 node-canvas 造 ImageData / 缩略图；我们全程用 imageData（裸字节），只需给它一个不依赖 canvas 的
// createImageData。真要 canvas 的路径（缩略图、JPEG 合成图）在读写选项里都关掉了，万一走到就明确报错而不是静默。
initializeCanvas(
  () => {
    throw new Error('Canopy 的 PSD 引擎只用 imageData，不使用 canvas')
  },
  (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData,
)
import type { PsdLayerNode } from '@canopy/shared'
import type { PsdAdjustmentParams, PsdEffectsSpec, PsdGuideSpec, PsdTextLayerSpec } from './psd-spec'
import {
  boundsOfOpaque,
  createBitmap,
  cropBitmap,
  parseHexColor,
  placeOnCanvas,
  toHexColor,
  type RgbaBitmap,
} from './psd-image-ops'
import { toPostScriptFontName } from './psd-text-render'
import { bezierPathsToSvgPathData, boundsOfPaths } from './psd-vector'
import type { CompositeArtboard, CompositeLayer } from './psd-compositor'

export interface PsdDocTextInfo {
  spec: PsdTextLayerSpec
  /** 文本框在文档里的位置与尺寸 */
  box: { left: number; top: number; width: number; height: number }
}

/** 形状层的矢量信息（路径坐标已是文档像素） */
export interface PsdDocVectorInfo {
  paths: BezierPath[]
  /** null = 无填充 */
  fill: string | null
  stroke?: { color: string; width: number }
}

/** 智能对象：嵌进 PSD 的原文件 + 它在文档里的摆放 */
export interface PsdDocPlacedInfo {
  /** GUID（ag-psd 要求），同时用作 linkedFiles 的 id */
  id: string
  name: string
  data: Buffer
  /** 4 字符文件类型签名，如 'png ' / 'JPEG' */
  fileType: string
  /** 原文件像素尺寸 */
  sourceWidth: number
  sourceHeight: number
  /** 在文档里的摆放框 */
  left: number
  top: number
  width: number
  height: number
}

/** 写入用的图层（位图已是文档尺寸） */
export interface PsdDocLayer {
  id: string
  name: string
  kind: 'pixel' | 'text' | 'group' | 'shape' | 'adjustment' | 'artboard' | 'smart-object'
  hidden: boolean
  opacity: number
  blendMode: string
  clipping: boolean
  bitmap?: RgbaBitmap
  /** 文档尺寸 1 通道 */
  mask?: Buffer
  effects?: PsdEffectsSpec
  text?: PsdDocTextInfo
  vector?: PsdDocVectorInfo
  adjustment?: PsdAdjustmentParams
  artboard?: CompositeArtboard
  placed?: PsdDocPlacedInfo
  children?: PsdDocLayer[]
  opened?: boolean
}

export interface PsdDocMeta {
  width: number
  height: number
  dpi: number
  guides?: PsdGuideSpec[]
}

function toPixelData(bitmap: RgbaBitmap): { width: number; height: number; data: Uint8ClampedArray } {
  return {
    width: bitmap.width,
    height: bitmap.height,
    data: new Uint8ClampedArray(bitmap.data.buffer, bitmap.data.byteOffset, bitmap.data.length),
  }
}

function grayToRgbaPixelData(mask: Buffer, width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const v = mask[p] ?? 0
    data[p * 4] = v
    data[p * 4 + 1] = v
    data[p * 4 + 2] = v
    data[p * 4 + 3] = 255
  }
  return { width, height, data }
}

function px(value: number): { units: 'Pixels'; value: number } {
  return { units: 'Pixels', value }
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const c = parseHexColor(hex)
  return { r: c.r, g: c.g, b: c.b }
}

/** 我方效果规格 → Photoshop 图层样式 */
export function toAgEffects(effects: PsdEffectsSpec): LayerEffectsInfo {
  const out: LayerEffectsInfo = {}
  const shadow = (e: NonNullable<PsdEffectsSpec['dropShadow']>) => ({
    enabled: true,
    present: true,
    showInDialog: true,
    blendMode: 'multiply' as AgBlendMode,
    color: rgb(e.color ?? '#000000'),
    opacity: e.opacity ?? 0.75,
    useGlobalLight: false,
    angle: e.angle ?? 120,
    distance: px(e.distance ?? 8),
    choke: px(0),
    size: px(e.size ?? 10),
    antialiased: false,
  })
  if (effects.dropShadow) out.dropShadow = [shadow(effects.dropShadow)]
  if (effects.innerShadow) out.innerShadow = [shadow(effects.innerShadow)]
  if (effects.outerGlow) {
    out.outerGlow = {
      enabled: true,
      present: true,
      showInDialog: true,
      blendMode: 'screen',
      color: rgb(effects.outerGlow.color ?? '#ffffbe'),
      opacity: effects.outerGlow.opacity ?? 0.75,
      source: 'edge',
      choke: px(0),
      size: px(effects.outerGlow.size ?? 12),
      antialiased: false,
      noise: 0,
      range: 50,
      jitter: 0,
    }
  }
  if (effects.stroke) {
    out.stroke = [{
      enabled: true,
      present: true,
      showInDialog: true,
      position: effects.stroke.position ?? 'outside',
      fillType: 'color',
      blendMode: 'normal',
      opacity: effects.stroke.opacity ?? 1,
      size: px(effects.stroke.size ?? 3),
      color: rgb(effects.stroke.color ?? '#000000'),
    }]
  }
  if (effects.gradientOverlay) {
    const colors = effects.gradientOverlay.colors
    const step = colors.length > 1 ? 4096 / (colors.length - 1) : 0
    out.gradientOverlay = [{
      enabled: true,
      present: true,
      showInDialog: true,
      blendMode: 'normal',
      opacity: effects.gradientOverlay.opacity ?? 1,
      align: true,
      scale: 100,
      dither: false,
      reverse: false,
      type: 'linear',
      angle: effects.gradientOverlay.angle ?? 90,
      gradient: {
        name: 'Canopy',
        type: 'solid',
        smoothness: 4096,
        colorStops: colors.map((c, i) => ({ color: rgb(c), location: Math.round(i * step), midpoint: 50 })),
        opacityStops: [{ opacity: 1, location: 0, midpoint: 50 }, { opacity: 1, location: 4096, midpoint: 50 }],
      },
    }]
  }
  return out
}

function colorOf(c: unknown, fallback: string): string {
  if (c && typeof c === 'object' && 'r' in c && 'g' in c && 'b' in c) return toHexColor(c as { r: number; g: number; b: number })
  return fallback
}

/** Photoshop 图层样式 → 我方效果规格（预览合成近似用；读不懂的忽略） */
export function fromAgEffects(effects: LayerEffectsInfo | undefined): PsdEffectsSpec | undefined {
  if (!effects || effects.disabled) return undefined
  const out: PsdEffectsSpec = {}
  const shadow = effects.dropShadow?.find((s) => s.enabled !== false)
  if (shadow) {
    out.dropShadow = {
      color: colorOf(shadow.color, '#000000'),
      opacity: shadow.opacity ?? 0.75,
      angle: shadow.angle ?? 120,
      distance: shadow.distance?.value ?? 8,
      size: shadow.size?.value ?? 10,
    }
  }
  const inner = effects.innerShadow?.find((s) => s.enabled !== false)
  if (inner) {
    out.innerShadow = {
      color: colorOf(inner.color, '#000000'),
      opacity: inner.opacity ?? 0.75,
      angle: inner.angle ?? 120,
      distance: inner.distance?.value ?? 8,
      size: inner.size?.value ?? 10,
    }
  }
  if (effects.outerGlow && effects.outerGlow.enabled !== false) {
    out.outerGlow = {
      color: colorOf(effects.outerGlow.color, '#ffffbe'),
      opacity: effects.outerGlow.opacity ?? 0.75,
      size: effects.outerGlow.size?.value ?? 12,
    }
  }
  const stroke = effects.stroke?.find((s) => s.enabled !== false)
  if (stroke && (stroke.fillType ?? 'color') === 'color') {
    out.stroke = {
      color: colorOf(stroke.color, '#000000'),
      size: stroke.size?.value ?? 3,
      position: stroke.position ?? 'outside',
      opacity: stroke.opacity ?? 1,
    }
  }
  const gradient = effects.gradientOverlay?.find((g) => g.enabled !== false)
  if (gradient && gradient.gradient?.type === 'solid' && gradient.gradient.colorStops.length >= 2) {
    out.gradientOverlay = {
      colors: [...gradient.gradient.colorStops].sort((a, b) => a.location - b.location).map((s) => colorOf(s.color, '#000000')),
      angle: gradient.angle ?? 90,
      opacity: gradient.opacity ?? 1,
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/* ------------------------------------------------------------ 调整层 ------------------------------------------------------------ */

/** Photoshop「黑白」的默认预设权重 */
const BLACK_AND_WHITE_DEFAULTS = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 }

/** 我方调整参数 → ag-psd 的调整层；纯色填充层不是调整层（用 vectorFill 表达），返回 null */
export function toAgAdjustment(params: PsdAdjustmentParams): AdjustmentLayer | null {
  switch (params.kind) {
    case 'brightness/contrast':
      return { type: 'brightness/contrast', brightness: Math.round(params.brightness ?? 0), contrast: Math.round(params.contrast ?? 0), useLegacy: false }
    case 'hue/saturation':
      return { type: 'hue/saturation', master: { a: 0, b: 0, c: 0, d: 0, hue: Math.round(params.hue ?? 0), saturation: Math.round(params.saturation ?? 0), lightness: Math.round(params.lightness ?? 0) } }
    case 'black & white':
      return { type: 'black & white', ...BLACK_AND_WHITE_DEFAULTS, useTint: false }
    case 'invert':
      return { type: 'invert' }
    case 'posterize':
      return { type: 'posterize', levels: Math.round(params.levels ?? 4) }
    case 'threshold':
      return { type: 'threshold', level: Math.round(params.level ?? 128) }
    case 'exposure':
      return { type: 'exposure', exposure: params.exposure ?? 0, offset: params.offset ?? 0, gamma: params.gamma ?? 1 }
    case 'vibrance':
      return { type: 'vibrance', vibrance: Math.round(params.vibrance ?? 0), saturation: Math.round(params.saturation ?? 0) }
    case 'photo filter':
      return { type: 'photo filter', color: rgb(params.color ?? '#ec8a00'), density: (params.density ?? 25) / 100, preserveLuminosity: true }
    case 'solid color':
      return null
    default:
      return null
  }
}

/** ag-psd 调整层 → 我方预览参数；预览不会渲染的类型（曲线 / 色阶 / 可选颜色…）返回 null */
export function fromAgAdjustment(adjustment: AdjustmentLayer | undefined): PsdAdjustmentParams | null {
  if (!adjustment) return null
  switch (adjustment.type) {
    case 'brightness/contrast':
      return { kind: 'brightness/contrast', brightness: adjustment.brightness ?? 0, contrast: adjustment.contrast ?? 0 }
    case 'hue/saturation':
      return { kind: 'hue/saturation', hue: adjustment.master?.hue ?? 0, saturation: adjustment.master?.saturation ?? 0, lightness: adjustment.master?.lightness ?? 0 }
    case 'black & white':
      return { kind: 'black & white' }
    case 'invert':
      return { kind: 'invert' }
    case 'posterize':
      return { kind: 'posterize', levels: adjustment.levels ?? 4 }
    case 'threshold':
      return { kind: 'threshold', level: adjustment.level ?? 128 }
    case 'exposure':
      return { kind: 'exposure', exposure: adjustment.exposure ?? 0, offset: adjustment.offset ?? 0, gamma: adjustment.gamma ?? 1 }
    case 'vibrance':
      return { kind: 'vibrance', vibrance: adjustment.vibrance ?? 0, saturation: adjustment.saturation ?? 0 }
    case 'photo filter':
      return { kind: 'photo filter', color: colorOf(adjustment.color, '#ec8a00'), density: (adjustment.density ?? 0.25) * 100 }
    default:
      return null
  }
}

/* ------------------------------------------------------------ 写入 ------------------------------------------------------------ */

/** 画板底色 → Photoshop 的 backgroundType（1 白 / 2 黑 / 3 透明 / 4 自定义色） */
function artboardBackgroundType(background: string | null): number {
  if (background === null) return 3
  const c = parseHexColor(background)
  if (c.r === 255 && c.g === 255 && c.b === 255) return 1
  if (c.r === 0 && c.g === 0 && c.b === 0) return 2
  return 4
}

function backgroundFromArtboardType(type: number | undefined, color: unknown): string | null {
  if (type === 3) return null
  if (type === 2) return '#000000'
  if (type === 4) return colorOf(color, '#ffffff')
  return '#ffffff'
}

export function toAgLayer(layer: PsdDocLayer, doc: PsdDocMeta): Layer {
  const isGroup = layer.kind === 'group' || layer.kind === 'artboard'
  const out: Layer = {
    name: layer.name,
    hidden: layer.hidden,
    opacity: layer.opacity,
    blendMode: (isGroup && layer.blendMode === 'normal' ? 'pass through' : layer.blendMode) as AgBlendMode,
    clipping: layer.clipping,
    transparencyProtected: false,
  }
  if (isGroup) {
    out.opened = layer.opened !== false
    out.children = (layer.children ?? []).map((child) => toAgLayer(child, doc))
    if (layer.kind === 'artboard' && layer.artboard) {
      const board = layer.artboard
      out.artboard = {
        rect: { top: Math.round(board.top), left: Math.round(board.left), bottom: Math.round(board.top + board.height), right: Math.round(board.left + board.width) },
        presetName: 'Custom',
        backgroundType: artboardBackgroundType(board.background),
        ...(board.background ? { color: rgb(board.background) } : {}),
      }
    }
  } else if (layer.bitmap) {
    const bounds = boundsOfOpaque(layer.bitmap)
    if (bounds) {
      const cropped = cropBitmap(layer.bitmap, bounds)
      out.left = bounds.left
      out.top = bounds.top
      out.right = bounds.right
      out.bottom = bounds.bottom
      out.imageData = toPixelData(cropped)
    }
  }
  if (layer.mask) {
    out.mask = {
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height,
      defaultColor: 0,
      imageData: grayToRgbaPixelData(layer.mask, doc.width, doc.height),
    }
  }
  if (layer.effects) out.effects = toAgEffects(layer.effects)
  if (layer.kind === 'text' && layer.text) {
    const { spec, box } = layer.text
    const font = toPostScriptFontName(spec.font ?? 'Microsoft YaHei', spec.bold === true)
    const fontSize = spec.fontSize ?? 32
    out.text = {
      text: spec.text.replace(/\r?\n/g, '\r'),
      transform: [1, 0, 0, 1, box.left, box.top],
      orientation: 'horizontal',
      antiAlias: 'sharp',
      shapeType: 'box',
      boxBounds: [0, 0, box.width, box.height],
      style: {
        font: { name: font.name },
        fontSize,
        fauxBold: font.fauxBold,
        fauxItalic: spec.italic === true,
        autoLeading: false,
        leading: Math.round((spec.lineHeight ?? 1.3) * fontSize),
        tracking: fontSize > 0 ? Math.round(((spec.letterSpacing ?? 0) / fontSize) * 1000) : 0,
        fillColor: rgb(spec.color ?? '#000000'),
        fillFlag: true,
      },
      paragraphStyle: { justification: spec.align ?? 'left' },
    }
  }
  if (layer.kind === 'shape' && layer.vector) {
    const { paths, fill, stroke } = layer.vector
    out.vectorMask = { paths }
    // Photoshop 的形状层永远带一份填充内容；无填充时靠描边样式里的 fillEnabled=false 关掉
    out.vectorFill = { type: 'color', color: rgb(fill ?? '#000000') }
    if (stroke || fill === null) {
      out.vectorStroke = {
        strokeEnabled: Boolean(stroke),
        fillEnabled: fill !== null,
        lineWidth: px(stroke?.width ?? 1),
        lineAlignment: 'center',
        lineCapType: 'butt',
        lineJoinType: 'miter',
        opacity: 1,
        blendMode: 'normal',
        content: { type: 'color', color: rgb(stroke?.color ?? '#000000') },
        resolution: doc.dpi,
      }
    }
  }
  if (layer.kind === 'adjustment' && layer.adjustment) {
    const adjustment = toAgAdjustment(layer.adjustment)
    if (adjustment) out.adjustment = adjustment
    else if (layer.adjustment.kind === 'solid color') out.vectorFill = { type: 'color', color: rgb(layer.adjustment.color ?? '#000000') }
  }
  if (layer.kind === 'smart-object' && layer.placed) {
    const p = layer.placed
    const right = p.left + p.width
    const bottom = p.top + p.height
    out.placedLayer = {
      id: p.id,
      type: 'raster',
      transform: [p.left, p.top, right, p.top, right, bottom, p.left, bottom],
      width: p.sourceWidth,
      height: p.sourceHeight,
      resolution: { units: 'Density', value: doc.dpi },
    }
  }
  return out
}

/** 文档级资源：智能对象嵌入的文件、画板计数（写新文件与往已有文件加层都要走这里） */
export function attachDocResources(psd: Psd, layers: PsdDocLayer[]): void {
  const walk = (list: PsdDocLayer[]): void => {
    for (const layer of list) {
      if (layer.kind === 'smart-object' && layer.placed) {
        const file: LinkedFile = { id: layer.placed.id, name: layer.placed.name, type: layer.placed.fileType, data: new Uint8Array(layer.placed.data.buffer, layer.placed.data.byteOffset, layer.placed.data.length) }
        psd.linkedFiles = [...(psd.linkedFiles ?? []).filter((f) => f.id !== file.id), file]
      }
      if (layer.kind === 'artboard') psd.artboards = { ...(psd.artboards ?? {}), count: (psd.artboards?.count ?? 0) + 1 }
      if (layer.children) walk(layer.children)
    }
  }
  walk(layers)
}

/** 组装可写入的 Psd 对象（composite 是我们合成好的整图，Photoshop / 看图软件用它做预览与缩略图） */
export function buildAgPsd(doc: PsdDocMeta, layers: PsdDocLayer[], composite: RgbaBitmap): Psd {
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3,
    children: layers.map((layer) => toAgLayer(layer, doc)),
    imageData: toPixelData(composite),
    imageResources: {
      resolutionInfo: {
        horizontalResolution: doc.dpi,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: doc.dpi,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
      ...(doc.guides && doc.guides.length > 0
        ? { gridAndGuidesInformation: { grid: { horizontal: 576, vertical: 576 }, guides: doc.guides.map((g) => ({ location: g.position, direction: g.direction })) } }
        : {}),
    },
  }
  attachDocResources(psd, layers)
  return psd
}

export function encodePsd(psd: Psd): Buffer {
  // generateThumbnail 需要 node-canvas（我们不带）；Photoshop 打开时自己生成缩略图，看图软件用 imageData 里的合成图
  return writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false, noBackground: true })
}

/* ------------------------------------------------------------ 读取 ------------------------------------------------------------ */

const READ_OPTIONS: ReadOptions = {
  useImageData: true,
  skipThumbnail: true,
  totalMemoryLimit: 1536 * 1024 * 1024,
  logMissingFeatures: false,
}

export interface ReadPsdResult {
  psd: Psd
  width: number
  height: number
  colorMode: string
  layers: PsdLayerNode[]
  /** Photoshop 存在文件里的合成图（有的文件没有） */
  composite: RgbaBitmap | null
  /** 供重新合成用（文档尺寸位图），按需生成 */
  compositeLayers: CompositeLayer[]
  warnings: string[]
}

const COLOR_MODE_NAMES: Record<number, string> = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'rgb', 4: 'cmyk', 7: 'multichannel', 8: 'duotone', 9: 'lab' }

function layerKind(layer: Layer): PsdLayerNode['kind'] {
  if (layer.artboard) return 'artboard'
  if (layer.children) return 'group'
  if (layer.text) return 'text'
  if (layer.adjustment) return 'adjustment'
  if (layer.placedLayer) return 'smart-object'
  if (layer.vectorMask) return 'shape'
  // 有填充内容但没有矢量蒙版 = 铺满画布的填充层，Photoshop 把它和调整层放在一起
  if (layer.vectorFill) return 'adjustment'
  return 'pixel'
}

function pixelDataToBitmap(data: { width: number; height: number; data: ArrayLike<number> }): RgbaBitmap {
  const buf = Buffer.alloc(data.width * data.height * 4)
  const src = data.data
  // 16 位 / 32 位在 ag-psd 里已按 8 位归一到 Uint8ClampedArray；Uint16Array 的情况按高 8 位取
  if (src instanceof Uint16Array) {
    for (let i = 0; i < buf.length; i++) buf[i] = (src[i] ?? 0) >> 8
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = src[i] ?? 0
  }
  return { width: data.width, height: data.height, data: buf }
}

function layerMaskToDocAlpha(layer: Layer, width: number, height: number): Buffer | undefined {
  const mask = layer.mask
  if (!mask || mask.disabled || !mask.imageData) return undefined
  const fill = mask.defaultColor ?? 0
  const out = Buffer.alloc(width * height, fill)
  const mw = mask.imageData.width
  const mh = mask.imageData.height
  const left = mask.left ?? 0
  const top = mask.top ?? 0
  const src = mask.imageData.data
  for (let y = 0; y < mh; y++) {
    const dy = y + top
    if (dy < 0 || dy >= height) continue
    for (let x = 0; x < mw; x++) {
      const dx = x + left
      if (dx < 0 || dx >= width) continue
      out[dy * width + dx] = src[(y * mw + x) * 4] ?? 0
    }
  }
  return out
}

/** Photoshop 自己画的形状层没有像素时，按矢量蒙版 + 填充 / 描边生成文档尺寸的 SVG（合成时栅格化） */
function shapeLayerToSvg(layer: Layer, width: number, height: number): string | null {
  const paths = layer.vectorMask?.paths
  if (!paths || paths.length === 0) return null
  const d = bezierPathsToSvgPathData(paths)
  if (!d) return null
  const fillEnabled = layer.vectorStroke?.fillEnabled !== false
  const fillColor = layer.vectorFill?.type === 'color' ? colorOf(layer.vectorFill.color, '#000000') : '#808080'
  const fill = fillEnabled ? `fill="${fillColor}"` : 'fill="none"'
  const stroke = layer.vectorStroke?.strokeEnabled
    ? `stroke="${layer.vectorStroke.content?.type === 'color' ? colorOf(layer.vectorStroke.content.color, '#000000') : '#000000'}" stroke-width="${layer.vectorStroke.lineWidth?.value ?? 1}"`
    : 'stroke="none"'
  const fillRule = paths[0]?.fillRule === 'even-odd' ? 'evenodd' : 'nonzero'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${d}" fill-rule="${fillRule}" ${fill} ${stroke}/></svg>`
}

function walkLayers(
  layers: Layer[],
  prefix: string,
  doc: { width: number; height: number },
  withBitmaps: boolean,
  warnings: string[],
): { nodes: PsdLayerNode[]; composite: CompositeLayer[] } {
  const nodes: PsdLayerNode[] = []
  const composite: CompositeLayer[] = []
  layers.forEach((layer, index) => {
    const id = prefix ? `${prefix}/${index}` : String(index)
    const kind = layerKind(layer)
    const node: PsdLayerNode = {
      id,
      name: layer.name ?? `图层 ${id}`,
      kind,
      hidden: layer.hidden === true,
      opacity: typeof layer.opacity === 'number' ? Math.round(layer.opacity * 1000) / 1000 : 1,
      blendMode: layer.blendMode ?? (kind === 'group' ? 'pass through' : 'normal'),
    }
    if (typeof layer.left === 'number' && typeof layer.top === 'number' && typeof layer.right === 'number' && typeof layer.bottom === 'number' && (layer.right > layer.left || layer.bottom > layer.top)) {
      node.bounds = { left: layer.left, top: layer.top, right: layer.right, bottom: layer.bottom }
    } else if (kind === 'shape' && layer.vectorMask?.paths.length) {
      const b = boundsOfPaths(layer.vectorMask.paths)
      node.bounds = { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }
    } else if (kind === 'artboard' && layer.artboard) {
      node.bounds = { left: layer.artboard.rect.left, top: layer.artboard.rect.top, right: layer.artboard.rect.right, bottom: layer.artboard.rect.bottom }
    }
    if (layer.text?.text) node.text = layer.text.text.replace(/\r/g, '\n')
    if (layer.mask) node.hasMask = true
    if (layer.clipping) node.clipping = true
    if (layer.effects) {
      const names = Object.keys(layer.effects).filter((k) => k !== 'disabled' && k !== 'scale')
      if (names.length) node.effects = names
    }
    const compositeLayer: CompositeLayer = {
      id,
      name: node.name,
      kind: kind === 'group' || kind === 'artboard' ? 'group' : kind === 'text' ? 'text' : 'pixel',
      hidden: node.hidden,
      opacity: node.opacity,
      blendMode: node.blendMode,
      clipToBelow: layer.clipping === true,
      effects: fromAgEffects(layer.effects),
    }
    if (kind === 'artboard' && layer.artboard) {
      const rect = layer.artboard.rect
      compositeLayer.artboard = { left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, background: backgroundFromArtboardType(layer.artboard.backgroundType, layer.artboard.color) }
    }
    if (layer.children) {
      const child = walkLayers(layer.children, id, doc, withBitmaps, warnings)
      node.children = child.nodes
      compositeLayer.children = child.composite
    } else if (withBitmaps) {
      const hasPixels = Boolean(layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0)
      if (kind === 'adjustment' && layer.adjustment) {
        const params = fromAgAdjustment(layer.adjustment)
        if (params) {
          compositeLayer.kind = 'adjustment'
          compositeLayer.adjustment = params
        } else {
          compositeLayer.bitmap = createBitmap(doc.width, doc.height)
          warnings.push(`「${node.name}」是 ${layer.adjustment.type} 调整层，内置预览不渲染它的效果（Photoshop 或 psd-tools 引擎会）`)
        }
      } else if (kind === 'adjustment' && layer.vectorFill) {
        // 纯色 / 渐变 / 图案填充层：纯色铺满画布，其余给灰色占位
        const color = layer.vectorFill.type === 'color' ? parseHexColor(colorOf(layer.vectorFill.color, '#000000')) : { r: 128, g: 128, b: 128, a: 255 }
        compositeLayer.bitmap = createBitmap(doc.width, doc.height, color)
        if (layer.vectorFill.type !== 'color') warnings.push(`「${node.name}」是${layer.vectorFill.type === 'pattern' ? '图案' : '渐变'}填充层，内置预览以灰色占位`)
      } else if (hasPixels) {
        const bitmap = pixelDataToBitmap(layer.imageData!)
        compositeLayer.bitmap = placeOnCanvas(bitmap, layer.left ?? 0, layer.top ?? 0, doc.width, doc.height)
      } else if (kind === 'shape') {
        const svg = shapeLayerToSvg(layer, doc.width, doc.height)
        if (svg) compositeLayer.svg = svg
        else {
          compositeLayer.bitmap = createBitmap(doc.width, doc.height)
          warnings.push(`「${node.name}」（shape）没有可用像素也没有可读的路径，预览里为空`)
        }
      } else {
        compositeLayer.bitmap = createBitmap(doc.width, doc.height)
        if (kind === 'smart-object') warnings.push(`「${node.name}」（smart-object）没有可用像素，预览里为空`)
      }
      compositeLayer.mask = layerMaskToDocAlpha(layer, doc.width, doc.height)
    }
    nodes.push(node)
    composite.push(compositeLayer)
  })
  return { nodes, composite }
}

/** 读取 PSD：withBitmaps=false 时只要图层树与自带合成图（省内存，也不加载智能对象嵌入的文件） */
export function readPsdBuffer(buffer: Buffer, withBitmaps: boolean): ReadPsdResult {
  const psd = readPsd(buffer, withBitmaps ? READ_OPTIONS : { ...READ_OPTIONS, skipLayerImageData: true, skipLinkedFilesData: true })
  const warnings: string[] = []
  const colorMode = COLOR_MODE_NAMES[psd.colorMode ?? 3] ?? 'rgb'
  if (colorMode !== 'rgb' && colorMode !== 'grayscale') warnings.push(`文件是 ${colorMode.toUpperCase()} 模式，内置引擎按 RGB 近似显示颜色`)
  const { nodes, composite } = walkLayers(psd.children ?? [], '', { width: psd.width, height: psd.height }, withBitmaps, warnings)
  const compositeBitmap = psd.imageData && psd.imageData.width === psd.width && psd.imageData.height === psd.height
    ? pixelDataToBitmap(psd.imageData)
    : null
  return { psd, width: psd.width, height: psd.height, colorMode, layers: nodes, composite: compositeBitmap, compositeLayers: composite, warnings }
}

/** 从（可能已被编辑的）Psd 对象重建合成用图层（文档尺寸位图） */
export function buildCompositeLayersFromPsd(psd: Psd, warnings: string[]): CompositeLayer[] {
  return walkLayers(psd.children ?? [], '', { width: psd.width, height: psd.height }, true, warnings).composite
}

/** 找到某图层所在的 children 数组（顶层就是 psd.children） */
export function findAgLayerParent(psd: Psd, id: string): Layer[] | null {
  const parts = id.split('/').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) return null
  let list: Layer[] | undefined = psd.children
  for (let i = 0; i < parts.length - 1; i++) {
    const layer: Layer | undefined = list?.[parts[i]!]
    list = layer?.children
  }
  return list && parts[parts.length - 1]! < list.length ? list : null
}

/** 在已读入的 Psd 里按 id（自下而上路径）找图层 */
export function findAgLayer(psd: Psd, id: string): Layer | null {
  const parts = id.split('/').map((p) => Number.parseInt(p, 10))
  let list: Layer[] | undefined = psd.children
  let current: Layer | null = null
  for (const part of parts) {
    if (!list || !Number.isInteger(part) || part < 0 || part >= list.length) return null
    current = list[part] ?? null
    list = current?.children
  }
  return current
}

/** 在合成用图层树里按 id 找图层 */
export function findCompositeLayer(layers: CompositeLayer[], id: string): CompositeLayer | null {
  const parts = id.split('/').map((p) => Number.parseInt(p, 10))
  let list: CompositeLayer[] | undefined = layers
  let current: CompositeLayer | null = null
  for (const part of parts) {
    if (!list || !Number.isInteger(part) || part < 0 || part >= list.length) return null
    current = list[part] ?? null
    list = current?.children
  }
  return current
}

/** 图层名 → id（同名取最靠上的；不区分大小写与首尾空白） */
export function findLayerIdByName(nodes: PsdLayerNode[], name: string): string | null {
  const wanted = name.trim().toLowerCase()
  let found: string | null = null
  const walk = (list: PsdLayerNode[]): void => {
    for (const node of list) {
      if (node.name.trim().toLowerCase() === wanted) found = node.id
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return found
}
