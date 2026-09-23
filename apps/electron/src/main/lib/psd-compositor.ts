/**
 * PSD 预览合成器：把「已渲染成文档尺寸位图」的图层自下而上合成一张图（sharp 做混合与模糊）。
 *
 * 忠实度取舍（都在结果 warnings 里说明）：
 * - 混合模式：sharp 有的 13 种精确合成，hue / saturation / color / luminosity 退回 normal；
 * - 分组：不透明度为 1、无蒙版、无剪贴时按 Photoshop 的「穿透」语义直接把子层画到画布上，
 *   否则先在独立画布合成子层再整体叠上（与 Photoshop 一致）；画板总是独立合成并裁到画板矩形；
 * - 效果：投影 / 外发光 / 描边（outside）画在图层下面，内阴影 / 渐变叠加画在图层上面，
 *   都是「alpha → 模糊 / 膨胀 / 反相 → 上色」的近似；
 * - 调整层：对「它下面已合成的画面」做近似调色（psd-adjust），蒙版 / 剪贴 / 不透明度决定作用范围。
 */

import sharp from 'sharp'
import type { PsdAdjustmentParams, PsdEffectsSpec } from './psd-spec'
import { applyAdjustment } from './psd-adjust'
import {
  applyMaskAlpha,
  blendModeToSharp,
  boundsOfOpaque,
  clipAlphaToBase,
  cloneBitmap,
  createBitmap,
  createRectMask,
  cropBitmap,
  extractAlpha,
  multiplyAlpha,
  parseHexColor,
  tintAlpha,
  type RgbaBitmap,
  type SharpBlend,
} from './psd-image-ops'

export interface CompositeArtboard {
  left: number
  top: number
  width: number
  height: number
  /** null = 透明 */
  background: string | null
}

export interface CompositeLayer {
  id: string
  name: string
  kind: 'pixel' | 'text' | 'group' | 'adjustment'
  hidden: boolean
  /** 0~1 */
  opacity: number
  blendMode: string
  clipToBelow: boolean
  /** 文档尺寸的位图；分组 / 调整层为 undefined */
  bitmap?: RgbaBitmap
  /** 没有位图但有文档尺寸的 SVG 时（读到 Photoshop 自己画的形状层），合成时栅格化 */
  svg?: string
  /** 文档尺寸的 1 通道灰度蒙版 */
  mask?: Buffer
  effects?: PsdEffectsSpec
  /** kind = adjustment 时的参数 */
  adjustment?: PsdAdjustmentParams
  /** kind = group 且是画板时：子层裁到这个矩形，先铺底色 */
  artboard?: CompositeArtboard
  children?: CompositeLayer[]
}

export interface CompositeDocument {
  width: number
  height: number
  /** null = 透明 */
  background: string | null
}

export interface CompositeOptions {
  /** 临时改写可见性（预览面板里点眼睛） */
  hiddenIds?: ReadonlySet<string>
  visibleIds?: ReadonlySet<string>
}

export interface CompositeResult {
  bitmap: RgbaBitmap
  warnings: string[]
}

function isVisible(layer: CompositeLayer, options: CompositeOptions): boolean {
  if (options.visibleIds?.has(layer.id)) return true
  if (options.hiddenIds?.has(layer.id)) return false
  return !layer.hidden
}

async function blendOnto(canvas: RgbaBitmap, layer: RgbaBitmap, blend: SharpBlend): Promise<RgbaBitmap> {
  const data = await sharp(canvas.data, { raw: { width: canvas.width, height: canvas.height, channels: 4 } })
    .composite([{ input: layer.data, raw: { width: layer.width, height: layer.height, channels: 4 }, blend }])
    .raw()
    .toBuffer()
  return { width: canvas.width, height: canvas.height, data }
}

/** 单通道 raw 进 sharp 后输出默认会被转成三通道 sRGB，必须钉回 b-w 才能按 1 字节/像素用 */
async function blurAlpha(alpha: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  if (sigma <= 0.3) return alpha
  return sharp(alpha, { raw: { width, height, channels: 1 } }).blur(sigma).toColourspace('b-w').raw().toBuffer()
}

/**
 * 膨胀：把 alpha 边缘向外推 size 像素。小尺寸用全 1 卷积核（任何覆盖即饱和 = 真正的形态学膨胀）再轻微模糊抗锯齿；
 * 大尺寸（核会超过 31×31）退回模糊 + 线性拉伸的近似。
 */
async function dilateAlpha(alpha: Buffer, width: number, height: number, size: number): Promise<Buffer> {
  if (size <= 0) return alpha
  const radius = Math.round(size)
  const kernelSize = radius * 2 + 1
  const pipeline = kernelSize <= 31
    ? sharp(alpha, { raw: { width, height, channels: 1 } })
        .convolve({ width: kernelSize, height: kernelSize, kernel: new Array<number>(kernelSize * kernelSize).fill(1), scale: 1, offset: 0 })
        .blur(0.6)
    : sharp(alpha, { raw: { width, height, channels: 1 } })
        .blur(Math.max(0.3, size * 0.75))
        .linear(10, -40)
  const dilated = await pipeline.toColourspace('b-w').raw().toBuffer()
  // 原本就不透明的区域保持满 alpha
  for (let i = 0; i < dilated.length; i++) {
    const original = alpha[i] ?? 0
    if (original > (dilated[i] ?? 0)) dilated[i] = original
  }
  return dilated
}

/** Photoshop 的光源角度 → 影子偏移（angle 是光源方向，影子落在反方向；图像坐标 y 向下） */
function shadowOffset(angleDeg: number, distance: number): { dx: number; dy: number } {
  const angle = (angleDeg * Math.PI) / 180
  return { dx: -Math.cos(angle) * distance, dy: Math.sin(angle) * distance }
}

async function renderEffectsUnderLayer(canvas: RgbaBitmap, layer: RgbaBitmap, effects: PsdEffectsSpec): Promise<RgbaBitmap> {
  const { width, height } = layer
  const alpha = extractAlpha(layer)
  let out = canvas
  if (effects.dropShadow) {
    const e = effects.dropShadow
    const { dx, dy } = shadowOffset(e.angle ?? 120, e.distance ?? 8)
    const blurred = await blurAlpha(alpha, width, height, (e.size ?? 10) / 2)
    const shadow = tintAlpha(blurred, width, height, parseHexColor(e.color ?? '#000000'), e.opacity ?? 0.75, dx, dy)
    out = await blendOnto(out, shadow, 'multiply')
  }
  if (effects.outerGlow) {
    const e = effects.outerGlow
    const blurred = await blurAlpha(alpha, width, height, Math.max(0.5, (e.size ?? 12) * 0.6))
    const glow = tintAlpha(blurred, width, height, parseHexColor(e.color ?? '#ffffbe'), e.opacity ?? 0.75)
    out = await blendOnto(out, glow, 'screen')
  }
  if (effects.stroke) {
    const e = effects.stroke
    const dilated = await dilateAlpha(alpha, width, height, e.size ?? 3)
    const stroke = tintAlpha(dilated, width, height, parseHexColor(e.color ?? '#000000'), e.opacity ?? 1)
    out = await blendOnto(out, stroke, 'over')
  }
  return out
}

/** 线性渐变（Photoshop 口径：angle 0 = 从左到右，90 = 从下到上；铺满图层外接框）→ 文档尺寸位图 */
async function renderLinearGradient(
  colors: string[],
  angleDeg: number,
  box: { left: number; top: number; right: number; bottom: number },
  width: number,
  height: number,
): Promise<RgbaBitmap> {
  const w = box.right - box.left
  const h = box.bottom - box.top
  const cx = box.left + w / 2
  const cy = box.top + h / 2
  const angle = (angleDeg * Math.PI) / 180
  const dirX = Math.cos(angle)
  const dirY = -Math.sin(angle)
  // 外接框在渐变方向上的投影长度的一半
  const half = (Math.abs(dirX) * w + Math.abs(dirY) * h) / 2
  const x1 = cx - dirX * half
  const y1 = cy - dirY * half
  const x2 = cx + dirX * half
  const y2 = cy + dirY * half
  const stops = colors.map((color, i) => `<stop offset="${colors.length > 1 ? i / (colors.length - 1) : 0}" stop-color="${color}"/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient></defs><rect x="0" y="0" width="${width}" height="${height}" fill="url(#g)"/></svg>`
  return decodeImageToBitmap(Buffer.from(svg, 'utf8'))
}

/** 内阴影与渐变叠加画在图层像素之上，且只落在图层不透明区域内 */
async function renderEffectsOverLayer(canvas: RgbaBitmap, layer: RgbaBitmap, effects: PsdEffectsSpec, layerOpacity: number): Promise<RgbaBitmap> {
  const { width, height } = layer
  const alpha = extractAlpha(layer)
  let out = canvas
  if (effects.gradientOverlay) {
    const e = effects.gradientOverlay
    const box = boundsOfOpaque(layer)
    if (box && e.colors.length >= 2) {
      const gradient = await renderLinearGradient(e.colors, e.angle ?? 90, box, width, height)
      // 只保留图层的形状
      const data = gradient.data
      for (let p = 0, i = 3; i < data.length; p++, i += 4) data[i] = Math.round(((alpha[p] ?? 0) * (e.opacity ?? 1) * layerOpacity))
      out = await blendOnto(out, gradient, 'over')
    }
  }
  if (effects.innerShadow) {
    const e = effects.innerShadow
    const { dx, dy } = shadowOffset(e.angle ?? 120, e.distance ?? 8)
    // 形状之外的区域当作「投射体」：反相 alpha → 按光源方向平移 → 模糊 → 只留在形状内部
    const inverted = Buffer.alloc(alpha.length)
    for (let i = 0; i < alpha.length; i++) inverted[i] = 255 - (alpha[i] ?? 0)
    const blurred = await blurAlpha(inverted, width, height, Math.max(0.3, (e.size ?? 10) / 2))
    const shadow = tintAlpha(blurred, width, height, parseHexColor(e.color ?? '#000000'), (e.opacity ?? 0.75) * layerOpacity, dx, dy)
    const data = shadow.data
    for (let p = 0, i = 3; i < data.length; p++, i += 4) data[i] = Math.round(((data[i] ?? 0) * (alpha[p] ?? 0)) / 255)
    out = await blendOnto(out, shadow, 'multiply')
  }
  return out
}

/** 调整层：把「下面已合成的画面」调完色后，按权重（蒙版 × 剪贴基底 × 不透明度）回混到原画面（alpha 不变） */
async function applyAdjustmentLayer(
  canvas: RgbaBitmap,
  layer: CompositeLayer,
  clipBase: RgbaBitmap | null,
  warnings: string[],
): Promise<RgbaBitmap> {
  if (!layer.adjustment) return canvas
  const { bitmap: adjusted, approximate } = await applyAdjustment(canvas, layer.adjustment)
  if (approximate) warnings.push(`「${layer.name}」（${layer.adjustment.kind}）预览为近似效果，Photoshop 里按原参数渲染`)
  if (layer.blendMode !== 'normal' && layer.blendMode !== 'pass through') warnings.push(`「${layer.name}」调整层的混合模式 ${layer.blendMode} 预览按 normal 近似`)
  const pixels = canvas.width * canvas.height
  const out = cloneBitmap(canvas)
  const data = out.data
  const src = adjusted.data
  const opacity = Math.max(0, Math.min(1, layer.opacity))
  for (let p = 0; p < pixels; p++) {
    let weight = opacity
    if (layer.mask) weight *= (layer.mask[p] ?? 0) / 255
    if (layer.clipToBelow) weight *= clipBase ? (clipBase.data[p * 4 + 3] ?? 0) / 255 : 1
    if (weight <= 0) continue
    const i = p * 4
    for (let c = 0; c < 3; c++) {
      const base = data[i + c] ?? 0
      data[i + c] = Math.round(base + ((src[i + c] ?? 0) - base) * weight)
    }
  }
  return out
}

async function compositeList(
  canvas: RgbaBitmap,
  layers: CompositeLayer[],
  options: CompositeOptions,
  warnings: string[],
): Promise<RgbaBitmap> {
  let out = canvas
  // 剪贴蒙版的基底：下方最近一个非剪贴、可见的图层（Photoshop 语义）
  let clipBase: RgbaBitmap | null = null
  for (const layer of layers) {
    if (!isVisible(layer, options)) continue
    if (layer.kind === 'adjustment') {
      if (layer.clipToBelow && !clipBase) warnings.push(`「${layer.name}」设了剪贴蒙版但下面没有可剪贴的图层，按作用于全图处理`)
      out = await applyAdjustmentLayer(out, layer, clipBase, warnings)
      continue
    }
    let bitmap: RgbaBitmap | undefined
    if (layer.kind === 'group') {
      if (layer.artboard) {
        bitmap = await compositeArtboard(out.width, out.height, layer, options, warnings)
      } else {
        const passThrough = layer.opacity >= 1 && !layer.mask && !layer.clipToBelow && (layer.blendMode === 'normal' || layer.blendMode === 'pass through') && !layer.effects
        if (passThrough) {
          out = await compositeList(out, layer.children ?? [], options, warnings)
          clipBase = null
          continue
        }
        bitmap = await compositeList(createBitmap(out.width, out.height), layer.children ?? [], options, warnings)
      }
    } else {
      if (!layer.bitmap && layer.svg) layer.bitmap = await decodeImageToBitmap(Buffer.from(layer.svg, 'utf8'))
      if (!layer.bitmap) continue
      bitmap = cloneBitmap(layer.bitmap)
    }
    if (layer.mask) applyMaskAlpha(bitmap, { width: out.width, height: out.height, data: layer.mask, channels: 1 })
    if (layer.clipToBelow) {
      if (clipBase) clipAlphaToBase(bitmap, clipBase)
      else warnings.push(`「${layer.name}」设了剪贴蒙版但下面没有可剪贴的图层，按普通图层显示`)
    }
    const shapeForClipping: RgbaBitmap | null = layer.clipToBelow ? clipBase : cloneBitmap(bitmap)
    if (layer.effects) out = await renderEffectsUnderLayer(out, bitmap, layer.effects)
    multiplyAlpha(bitmap, layer.opacity)
    // 隔离合成的分组 / 画板：「穿透」就是按 normal 叠回去，不算近似
    const { blend, exact } = blendModeToSharp(layer.kind === 'group' && layer.blendMode === 'pass through' ? 'normal' : layer.blendMode)
    if (!exact) warnings.push(`「${layer.name}」的混合模式 ${layer.blendMode} 预览按 normal 近似（Photoshop 里按设置渲染）`)
    out = await blendOnto(out, bitmap, blend)
    if (layer.effects) out = await renderEffectsOverLayer(out, bitmap, layer.effects, layer.opacity)
    if (!layer.clipToBelow) clipBase = shapeForClipping
  }
  return out
}

/** 画板：独立画布先铺底色，合成子层，再裁到画板矩形 */
async function compositeArtboard(
  width: number,
  height: number,
  layer: CompositeLayer,
  options: CompositeOptions,
  warnings: string[],
): Promise<RgbaBitmap> {
  const board = layer.artboard!
  const rect = { left: board.left, top: board.top, width: board.width, height: board.height }
  const canvas = createBitmap(width, height)
  if (board.background) {
    const color = parseHexColor(board.background)
    const x0 = Math.max(0, Math.round(rect.left))
    const y0 = Math.max(0, Math.round(rect.top))
    const x1 = Math.min(width, Math.round(rect.left + rect.width))
    const y1 = Math.min(height, Math.round(rect.top + rect.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        canvas.data[i] = color.r
        canvas.data[i + 1] = color.g
        canvas.data[i + 2] = color.b
        canvas.data[i + 3] = color.a
      }
    }
  }
  const composed = await compositeList(canvas, layer.children ?? [], options, warnings)
  applyMaskAlpha(composed, { width, height, data: createRectMask(width, height, rect), channels: 1 })
  return composed
}

/** 自下而上合成整份文档 */
export async function compositeDocument(
  doc: CompositeDocument,
  layers: CompositeLayer[],
  options: CompositeOptions = {},
): Promise<CompositeResult> {
  const warnings: string[] = []
  const background = doc.background ? parseHexColor(doc.background) : undefined
  const canvas = createBitmap(doc.width, doc.height, background)
  const bitmap = await compositeList(canvas, layers, options, warnings)
  return { bitmap, warnings: [...new Set(warnings)] }
}

/** 位图 → PNG（可选缩放到最长边 maxSide，给模型看的预览用） */
export async function bitmapToPng(bitmap: RgbaBitmap, maxSide?: number): Promise<Buffer> {
  let image = sharp(bitmap.data, { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } })
  if (maxSide && (bitmap.width > maxSide || bitmap.height > maxSide)) {
    image = image.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
  }
  return image.png().toBuffer()
}

/** 任意 sharp 能解码的图片 → 文档尺寸位图（放在 left/top，可缩放） */
export async function decodeImageToBitmap(
  input: Buffer | string,
  options: { width?: number; height?: number; fit?: 'contain' | 'cover' | 'fill' } = {},
): Promise<RgbaBitmap> {
  let image = sharp(input, { limitInputPixels: 100_000_000 }).ensureAlpha()
  if (options.width || options.height) {
    image = image.resize({
      width: options.width ? Math.round(options.width) : undefined,
      height: options.height ? Math.round(options.height) : undefined,
      fit: options.fit === 'contain' ? 'contain' : options.fit === 'cover' ? 'cover' : options.width && options.height ? 'fill' : 'inside',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
  }
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data }
}

/** 灰度蒙版图片 → 1 通道，缩放到文档尺寸 */
export async function decodeMaskToAlpha(input: Buffer | string, width: number, height: number, feather?: number): Promise<Buffer> {
  let image = sharp(input, { limitInputPixels: 100_000_000 }).resize({ width, height, fit: 'fill' }).removeAlpha().greyscale()
  if (feather && feather > 0) image = image.blur(Math.max(0.3, feather / 2))
  const buffer = await image.toColourspace('b-w').raw().toBuffer()
  if (buffer.length !== width * height) throw new Error(`蒙版解码后尺寸不符：${buffer.length} ≠ ${width * height}`)
  return buffer
}

/** 矩形蒙版（可羽化）→ 1 通道 */
export async function featherAlpha(alpha: Buffer, width: number, height: number, feather?: number): Promise<Buffer> {
  return blurAlpha(alpha, width, height, feather && feather > 0 ? feather / 2 : 0)
}

/** 单个图层自己的像素（分组 / 画板则独立合成其子层），裁到不透明外接矩形；全透明返回 null */
export async function renderLayerAlone(
  doc: CompositeDocument,
  layer: CompositeLayer,
  options: CompositeOptions = {},
): Promise<{ bitmap: RgbaBitmap; bounds: { left: number; top: number; right: number; bottom: number }; warnings: string[] } | null> {
  const warnings: string[] = []
  if (layer.kind === 'adjustment') return null
  const full = layer.kind === 'group'
    ? await compositeList(createBitmap(doc.width, doc.height), [{ ...layer, hidden: false, opacity: 1, blendMode: 'normal', clipToBelow: false, effects: undefined }], options, warnings)
    : await (async () => {
        if (!layer.bitmap && layer.svg) layer.bitmap = await decodeImageToBitmap(Buffer.from(layer.svg, 'utf8'))
        if (!layer.bitmap) return createBitmap(doc.width, doc.height)
        const bitmap = cloneBitmap(layer.bitmap)
        if (layer.mask) applyMaskAlpha(bitmap, { width: doc.width, height: doc.height, data: layer.mask, channels: 1 })
        return bitmap
      })()
  const bounds = boundsOfOpaque(full)
  if (!bounds) return null
  return { bitmap: cropBitmap(full, bounds), bounds, warnings }
}
