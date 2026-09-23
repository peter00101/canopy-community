/**
 * PSD 合成用的原始像素运算（纯逻辑，RGBA 非预乘，4 字节/像素）。
 *
 * 只做「一次遍历就能完成」的逐像素运算：不透明度、蒙版、剪贴、摆放、裁边、颜色解析、
 * 混合模式名映射。模糊 / 缩放 / 合成这类交给 sharp（见 psd-compositor.ts）。
 */

export interface RgbaBitmap {
  width: number
  height: number
  /** RGBA，长度 = width * height * 4 */
  data: Buffer
}

export interface RgbaColor {
  r: number
  g: number
  b: number
  /** 0~255 */
  a: number
}

export interface PixelBounds {
  left: number
  top: number
  /** 不含 */
  right: number
  /** 不含 */
  bottom: number
}

export function parseHexColor(hex: string): RgbaColor {
  const value = hex.trim().replace(/^#/, '')
  const expand = (s: string): string => s.split('').map((ch) => ch + ch).join('')
  const full = value.length === 3 || value.length === 4 ? expand(value) : value
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) throw new Error(`不是合法的颜色：${hex}`)
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) : 255,
  }
}

export function toHexColor(color: { r: number; g: number; b: number }): string {
  const hex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
}

export function createBitmap(width: number, height: number, fill?: RgbaColor): RgbaBitmap {
  const data = Buffer.alloc(width * height * 4)
  if (fill && fill.a > 0) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill.r
      data[i + 1] = fill.g
      data[i + 2] = fill.b
      data[i + 3] = fill.a
    }
  }
  return { width, height, data }
}

export function cloneBitmap(bitmap: RgbaBitmap): RgbaBitmap {
  return { width: bitmap.width, height: bitmap.height, data: Buffer.from(bitmap.data) }
}

/** 原地把 alpha 乘以 factor（0~1） */
export function multiplyAlpha(bitmap: RgbaBitmap, factor: number): void {
  const f = Math.max(0, Math.min(1, factor))
  if (f === 1) return
  const data = bitmap.data
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round((data[i] ?? 0) * f)
}

/**
 * 原地应用灰度蒙版：白=显示、黑=隐藏。mask 必须与 bitmap 同尺寸；取 mask 的第一通道，
 * 每像素 1 或 4 字节都接受。
 */
export function applyMaskAlpha(bitmap: RgbaBitmap, mask: { width: number; height: number; data: Buffer; channels: 1 | 4 }): void {
  if (mask.width !== bitmap.width || mask.height !== bitmap.height) {
    throw new Error(`蒙版尺寸 ${mask.width}×${mask.height} 与图层 ${bitmap.width}×${bitmap.height} 不一致`)
  }
  const data = bitmap.data
  const step = mask.channels
  const pixels = bitmap.width * bitmap.height
  for (let p = 0; p < pixels; p++) {
    const m = mask.data[p * step] ?? 0
    const i = p * 4 + 3
    data[i] = Math.round(((data[i] ?? 0) * m) / 255)
  }
}

/** 剪贴蒙版：图层 alpha 乘以基底层 alpha（Photoshop 的 clipping 语义） */
export function clipAlphaToBase(bitmap: RgbaBitmap, base: RgbaBitmap): void {
  if (base.width !== bitmap.width || base.height !== bitmap.height) {
    throw new Error('剪贴蒙版要求图层与基底同尺寸')
  }
  const data = bitmap.data
  const baseData = base.data
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(((data[i] ?? 0) * (baseData[i] ?? 0)) / 255)
}

/** 提取 alpha 通道成 1 通道位图 */
export function extractAlpha(bitmap: RgbaBitmap): Buffer {
  const out = Buffer.alloc(bitmap.width * bitmap.height)
  const data = bitmap.data
  for (let p = 0, i = 3; i < data.length; p++, i += 4) out[p] = data[i] ?? 0
  return out
}

/** 用颜色给 1 通道 alpha 上色，alpha 再乘以 opacity；shiftX/shiftY 整体平移（用于投影） */
export function tintAlpha(
  alpha: Buffer,
  width: number,
  height: number,
  color: RgbaColor,
  opacity: number,
  shiftX = 0,
  shiftY = 0,
): RgbaBitmap {
  const out = createBitmap(width, height)
  const data = out.data
  const dx = Math.round(shiftX)
  const dy = Math.round(shiftY)
  const factor = Math.max(0, Math.min(1, opacity)) * (color.a / 255)
  for (let y = 0; y < height; y++) {
    const sy = y - dy
    if (sy < 0 || sy >= height) continue
    for (let x = 0; x < width; x++) {
      const sx = x - dx
      if (sx < 0 || sx >= width) continue
      const a = alpha[sy * width + sx] ?? 0
      if (a === 0) continue
      const i = (y * width + x) * 4
      data[i] = color.r
      data[i + 1] = color.g
      data[i + 2] = color.b
      data[i + 3] = Math.round(a * factor)
    }
  }
  return out
}

/** 把 src 放到 canvasW×canvasH 的透明画布上（left/top 可为负，越界部分裁掉） */
export function placeOnCanvas(src: RgbaBitmap, left: number, top: number, canvasW: number, canvasH: number): RgbaBitmap {
  const out = createBitmap(canvasW, canvasH)
  const x0 = Math.round(left)
  const y0 = Math.round(top)
  const startX = Math.max(0, -x0)
  const startY = Math.max(0, -y0)
  const endX = Math.min(src.width, canvasW - x0)
  const endY = Math.min(src.height, canvasH - y0)
  if (endX <= startX || endY <= startY) return out
  const rowBytes = (endX - startX) * 4
  for (let y = startY; y < endY; y++) {
    const srcOffset = (y * src.width + startX) * 4
    const dstOffset = ((y + y0) * canvasW + (startX + x0)) * 4
    src.data.copy(out.data, dstOffset, srcOffset, srcOffset + rowBytes)
  }
  return out
}

/** alpha>0 像素的外接矩形；全透明返回 null */
export function boundsOfOpaque(bitmap: RgbaBitmap): PixelBounds | null {
  const { width, height, data } = bitmap
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4 + 3
    for (let x = 0; x < width; x++) {
      if (data[rowStart + x * 4] !== 0) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right < 0) return null
  return { left, top, right: right + 1, bottom: bottom + 1 }
}

export function cropBitmap(bitmap: RgbaBitmap, bounds: PixelBounds): RgbaBitmap {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  const out = createBitmap(width, height)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const srcOffset = ((bounds.top + y) * bitmap.width + bounds.left) * 4
    bitmap.data.copy(out.data, y * rowBytes, srcOffset, srcOffset + rowBytes)
  }
  return out
}

/** 矩形蒙版（1 通道），feather 由调用方交给 sharp 模糊 */
export function createRectMask(width: number, height: number, rect: { left: number; top: number; width: number; height: number }): Buffer {
  const out = Buffer.alloc(width * height)
  const x0 = Math.max(0, Math.round(rect.left))
  const y0 = Math.max(0, Math.round(rect.top))
  const x1 = Math.min(width, Math.round(rect.left + rect.width))
  const y1 = Math.min(height, Math.round(rect.top + rect.height))
  for (let y = y0; y < y1; y++) out.fill(255, y * width + x0, y * width + x1)
  return out
}

export type SharpBlend =
  | 'over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'colour-dodge' | 'colour-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'add'

const BLEND_TO_SHARP: Record<string, SharpBlend> = {
  normal: 'over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'colour-dodge',
  'color burn': 'colour-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  'linear dodge': 'add',
}

/** Photoshop 混合模式 → sharp 合成算子；不支持的（hue / saturation / color / luminosity 等）退回 over 并标记非精确 */
export function blendModeToSharp(mode: string): { blend: SharpBlend; exact: boolean } {
  const blend = BLEND_TO_SHARP[mode]
  return blend ? { blend, exact: true } : { blend: 'over', exact: false }
}

/** 位图是否全透明 */
export function isBitmapEmpty(bitmap: RgbaBitmap): boolean {
  const data = bitmap.data
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false
  return true
}
