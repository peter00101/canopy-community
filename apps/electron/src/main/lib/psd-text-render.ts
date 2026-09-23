/**
 * 文字层渲染：把文字层规格渲染成透明背景的 PNG（用 sharp 内置的 Pango 文本引擎）。
 *
 * ag-psd 不会为文字层生成像素——不给像素的话 Photoshop 打开时只会看到空白并提示
 * 「更新文字图层」。这里渲染出来的像素既进 PSD 图层，也进我们自己的预览合成图；
 * PSD 里同时保留文字数据，用户在 Photoshop 里双击仍可继续编辑。
 *
 * 字体经 fontconfig 解析：家族名不存在时会退到系统默认，不会失败——结果里的
 * warnings 提醒模型「字体名请用系统里真有的」。
 */

import sharp from 'sharp'
import { parseHexColor } from './psd-image-ops'

export interface TextRenderInput {
  text: string
  font: string
  /** 像素 */
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  /** 换行宽度（像素）；缺省不换行 */
  width?: number
  /** 行高倍数 */
  lineHeight: number
  /** 字间距（像素） */
  letterSpacing: number
}

export interface RenderedText {
  png: Buffer
  width: number
  height: number
}

/** Pango 标记里的保留字符 */
export function escapePangoText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Pango 字体描述："家族 [Bold] [Italic] 大小"；dpi 固定 72，所以 pt == px */
export function buildPangoFontDescription(input: Pick<TextRenderInput, 'font' | 'fontSize' | 'bold' | 'italic'>): string {
  const family = input.font.replace(/[,]/g, ' ').trim()
  const parts = [family]
  if (input.bold) parts.push('Bold')
  if (input.italic) parts.push('Italic')
  parts.push(String(Math.max(1, Math.round(input.fontSize))))
  return parts.join(' ')
}

/** 组装 Pango 标记：颜色（含透明度）、字间距、行高都放在 span 属性里 */
export function buildPangoMarkup(input: TextRenderInput): string {
  const color = parseHexColor(input.color)
  const hex = `#${[color.r, color.g, color.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  const attrs = [`foreground="${hex}"`]
  if (color.a < 255) attrs.push(`alpha="${Math.round((color.a / 255) * 100)}%"`)
  // letter_spacing 单位是 1/1024 pt；dpi 72 下 1pt = 1px
  if (input.letterSpacing) attrs.push(`letter_spacing="${Math.round(input.letterSpacing * 1024)}"`)
  if (input.lineHeight && input.lineHeight !== 1) attrs.push(`line_height="${input.lineHeight.toFixed(2)}"`)
  return `<span ${attrs.join(' ')}>${escapePangoText(input.text)}</span>`
}

export async function renderTextToPng(input: TextRenderInput): Promise<RenderedText> {
  const align = input.align === 'center' ? 'centre' : input.align
  const image = sharp({
    text: {
      text: buildPangoMarkup(input),
      font: buildPangoFontDescription(input),
      dpi: 72,
      rgba: true,
      align,
      wrap: 'word-char',
      ...(input.width && input.width > 0 ? { width: Math.max(1, Math.round(input.width)) } : {}),
    },
  })
  const png = await image.png().toBuffer()
  const meta = await sharp(png).metadata()
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 }
}

/**
 * 常见字体家族 → Photoshop 认的 PostScript 名。不在表里的按「去空格」猜，Photoshop
 * 找不到会提示替换字体，文字本身不丢。
 */
const POSTSCRIPT_NAMES: Record<string, { regular: string; bold?: string }> = {
  'microsoft yahei': { regular: 'MicrosoftYaHei', bold: 'MicrosoftYaHei-Bold' },
  '微软雅黑': { regular: 'MicrosoftYaHei', bold: 'MicrosoftYaHei-Bold' },
  'simhei': { regular: 'SimHei' },
  '黑体': { regular: 'SimHei' },
  'simsun': { regular: 'SimSun' },
  '宋体': { regular: 'SimSun' },
  'kaiti': { regular: 'KaiTi' },
  '楷体': { regular: 'KaiTi' },
  'pingfang sc': { regular: 'PingFangSC-Regular', bold: 'PingFangSC-Semibold' },
  '苹方': { regular: 'PingFangSC-Regular', bold: 'PingFangSC-Semibold' },
  'source han sans sc': { regular: 'SourceHanSansSC-Regular', bold: 'SourceHanSansSC-Bold' },
  '思源黑体': { regular: 'SourceHanSansSC-Regular', bold: 'SourceHanSansSC-Bold' },
  'noto sans cjk sc': { regular: 'NotoSansCJKsc-Regular', bold: 'NotoSansCJKsc-Bold' },
  'noto sans sc': { regular: 'NotoSansSC-Regular', bold: 'NotoSansSC-Bold' },
  'source han serif sc': { regular: 'SourceHanSerifSC-Regular', bold: 'SourceHanSerifSC-Bold' },
  '思源宋体': { regular: 'SourceHanSerifSC-Regular', bold: 'SourceHanSerifSC-Bold' },
  arial: { regular: 'ArialMT', bold: 'Arial-BoldMT' },
  helvetica: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  'times new roman': { regular: 'TimesNewRomanPSMT', bold: 'TimesNewRomanPS-BoldMT' },
  georgia: { regular: 'Georgia', bold: 'Georgia-Bold' },
  verdana: { regular: 'Verdana', bold: 'Verdana-Bold' },
  'segoe ui': { regular: 'SegoeUI', bold: 'SegoeUI-Bold' },
  roboto: { regular: 'Roboto-Regular', bold: 'Roboto-Bold' },
  inter: { regular: 'Inter-Regular', bold: 'Inter-Bold' },
  'open sans': { regular: 'OpenSans-Regular', bold: 'OpenSans-Bold' },
  montserrat: { regular: 'Montserrat-Regular', bold: 'Montserrat-Bold' },
}

/** 返回 PostScript 名以及是否需要 Photoshop 用「仿粗体」补（家族没有独立粗体面时） */
export function toPostScriptFontName(family: string, bold: boolean): { name: string; fauxBold: boolean } {
  const key = family.trim().toLowerCase()
  const entry = POSTSCRIPT_NAMES[key]
  if (entry) {
    if (bold && entry.bold) return { name: entry.bold, fauxBold: false }
    return { name: entry.regular, fauxBold: bold }
  }
  const guessed = family.trim().replace(/\s+/g, '')
  return { name: bold ? `${guessed}-Bold` : guessed, fauxBold: false }
}
