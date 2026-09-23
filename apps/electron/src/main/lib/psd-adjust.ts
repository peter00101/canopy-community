/**
 * 调整层的预览近似：把「它下面已经合成好的画面」按 Photoshop 调整层的参数变一下。
 * 写进 PSD 的是真正的调整层（Photoshop 自己算），这里只负责预览图和给模型看的合成图。
 *
 * 亮度 / 对比度、色相 / 饱和度、去色、反相、曝光、自然饱和度、照片滤镜走 sharp；
 * 色调分离与阈值是逐像素量化，直接在 raw 上做。
 */

import sharp, { type Sharp } from 'sharp'
import { parseHexColor, type RgbaBitmap } from './psd-image-ops'
import type { PsdAdjustmentParams } from './psd-spec'

export type { PsdAdjustmentKind, PsdAdjustmentParams } from './psd-spec'
export { PSD_ADJUSTMENT_KINDS } from './psd-spec'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

async function viaSharp(bitmap: RgbaBitmap, build: (image: Sharp) => Sharp): Promise<RgbaBitmap> {
  const data = await build(sharp(bitmap.data, { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } })).raw().toBuffer()
  return { width: bitmap.width, height: bitmap.height, data }
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 返回一张新位图：base 被调整后的样子（alpha 原样保留） */
export async function applyAdjustment(base: RgbaBitmap, params: PsdAdjustmentParams): Promise<{ bitmap: RgbaBitmap; approximate: boolean }> {
  switch (params.kind) {
    case 'brightness/contrast': {
      const brightness = clamp(params.brightness ?? 0, -150, 150)
      const contrast = clamp(params.contrast ?? 0, -50, 100)
      const factor = 1 + contrast / 100
      const bitmap = await viaSharp(base, (image) => image.linear([factor, factor, factor, 1], [128 * (1 - factor) + brightness * 0.85, 128 * (1 - factor) + brightness * 0.85, 128 * (1 - factor) + brightness * 0.85, 0]))
      return { bitmap, approximate: true }
    }
    case 'hue/saturation': {
      const hue = clamp(params.hue ?? 0, -180, 180)
      const saturation = 1 + clamp(params.saturation ?? 0, -100, 100) / 100
      const lightness = clamp(params.lightness ?? 0, -100, 100)
      const bitmap = await viaSharp(base, (image) => image.modulate({ hue, saturation, lightness }))
      return { bitmap, approximate: true }
    }
    case 'vibrance': {
      const saturation = 1 + clamp(params.vibrance ?? 0, -100, 100) / 200 + clamp(params.saturation ?? 0, -100, 100) / 100
      const bitmap = await viaSharp(base, (image) => image.modulate({ saturation: Math.max(0, saturation) }))
      return { bitmap, approximate: true }
    }
    case 'black & white': {
      // sharp 的 greyscale 会把 raw 输出压成单通道，这里直接按亮度逐像素去色，alpha 原样保留
      const data = Buffer.from(base.data)
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.round(luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0))
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
      }
      return { bitmap: { width: base.width, height: base.height, data }, approximate: true }
    }
    case 'invert': {
      const bitmap = await viaSharp(base, (image) => image.negate({ alpha: false }))
      return { bitmap, approximate: false }
    }
    case 'exposure': {
      const exposure = clamp(params.exposure ?? 0, -20, 20)
      const offset = clamp(params.offset ?? 0, -0.5, 0.5)
      const gamma = clamp(params.gamma ?? 1, 0.01, 9.99)
      const gain = 2 ** exposure
      let bitmap = await viaSharp(base, (image) => image.linear([gain, gain, gain, 1], [offset * 255, offset * 255, offset * 255, 0]))
      if (Math.abs(gamma - 1) > 0.01) bitmap = await viaSharp(bitmap, (image) => image.gamma(clamp(1 / gamma, 1, 3)))
      return { bitmap, approximate: true }
    }
    case 'posterize': {
      const levels = clamp(Math.round(params.levels ?? 4), 2, 255)
      const step = 255 / (levels - 1)
      const data = Buffer.from(base.data)
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(Math.round((data[i + c] ?? 0) / step) * step)
      }
      return { bitmap: { width: base.width, height: base.height, data }, approximate: false }
    }
    case 'threshold': {
      const level = clamp(Math.round(params.level ?? 128), 1, 255)
      const data = Buffer.from(base.data)
      for (let i = 0; i < data.length; i += 4) {
        const v = luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) >= level ? 255 : 0
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
      }
      return { bitmap: { width: base.width, height: base.height, data }, approximate: false }
    }
    case 'photo filter': {
      const color = parseHexColor(params.color ?? '#ec8a00')
      const density = clamp(params.density ?? 25, 0, 100) / 100
      const data = Buffer.from(base.data)
      for (let i = 0; i < data.length; i += 4) {
        // 保留明度的着色：按浓度把颜色乘进去
        data[i] = Math.round((data[i] ?? 0) * (1 - density) + ((data[i] ?? 0) * color.r / 255) * density)
        data[i + 1] = Math.round((data[i + 1] ?? 0) * (1 - density) + ((data[i + 1] ?? 0) * color.g / 255) * density)
        data[i + 2] = Math.round((data[i + 2] ?? 0) * (1 - density) + ((data[i + 2] ?? 0) * color.b / 255) * density)
      }
      return { bitmap: { width: base.width, height: base.height, data }, approximate: true }
    }
    case 'solid color': {
      const color = parseHexColor(params.color ?? '#000000')
      const data = Buffer.from(base.data)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = color.r
        data[i + 1] = color.g
        data[i + 2] = color.b
        data[i + 3] = 255
      }
      return { bitmap: { width: base.width, height: base.height, data }, approximate: false }
    }
    default:
      throw new Error(`不支持的调整层：${String((params as { kind?: unknown }).kind)}`)
  }
}
