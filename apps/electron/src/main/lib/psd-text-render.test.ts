import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import {
  buildPangoFontDescription,
  buildPangoMarkup,
  escapePangoText,
  renderTextToPng,
  toPostScriptFontName,
  type TextRenderInput,
} from './psd-text-render'

const base: TextRenderInput = { text: '你好 Canopy', font: 'Microsoft YaHei', fontSize: 32, color: '#ff3366', bold: false, italic: false, align: 'left', lineHeight: 1.3, letterSpacing: 0 }

async function opaquePixels(png: Buffer): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let n = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++
  return n
}

describe('文字层渲染：Pango 标记', () => {
  it('Given 含 & < > 的文本，When 转义，Then 不会破坏标记', () => {
    expect(escapePangoText('A & B <c>')).toBe('A &amp; B &lt;c&gt;')
  })

  it('Given 粗斜体 32px，When 生成字体描述，Then 家族 Bold Italic 32', () => {
    expect(buildPangoFontDescription({ font: 'Microsoft YaHei', fontSize: 32, bold: true, italic: true })).toBe('Microsoft YaHei Bold Italic 32')
  })

  it('Given 颜色带透明度、字间距与行高，When 组装标记，Then span 属性齐全', () => {
    const markup = buildPangoMarkup({ ...base, color: '#ff336680', letterSpacing: 2, lineHeight: 1.5 })
    expect(markup).toContain('foreground="#ff3366"')
    expect(markup).toContain('alpha="50%"')
    expect(markup).toContain('letter_spacing="2048"')
    expect(markup).toContain('line_height="1.50"')
    expect(markup).toContain('你好 Canopy')
  })
})

describe('文字层渲染：真渲染', () => {
  it('Given 一行中英文，When 渲染，Then 出图有像素、宽度不超过文本框', async () => {
    const rendered = await renderTextToPng({ ...base, width: 300 })
    expect(rendered.width).toBeGreaterThan(0)
    expect(rendered.width).toBeLessThanOrEqual(300)
    expect(await opaquePixels(rendered.png)).toBeGreaterThan(50)
  }, 20_000)

  it('Given 超过文本框宽度的长句，When 渲染，Then 自动换行、高度大于单行', async () => {
    const single = await renderTextToPng({ ...base, text: '短', width: 400 })
    const wrapped = await renderTextToPng({ ...base, text: '这是一段很长很长的说明文字，用来验证文本框宽度会让它自动换行显示', width: 240 })
    expect(wrapped.width).toBeLessThanOrEqual(240)
    expect(wrapped.height).toBeGreaterThan(single.height * 1.8)
  }, 20_000)
})

describe('文字层渲染：PostScript 字体名', () => {
  it('Given 常见家族名，When 转 PostScript 名，Then 有独立粗体面的用真粗体、没有的仿粗', () => {
    expect(toPostScriptFontName('Microsoft YaHei', true)).toEqual({ name: 'MicrosoftYaHei-Bold', fauxBold: false })
    expect(toPostScriptFontName('微软雅黑', false)).toEqual({ name: 'MicrosoftYaHei', fauxBold: false })
    expect(toPostScriptFontName('SimHei', true)).toEqual({ name: 'SimHei', fauxBold: true })
    expect(toPostScriptFontName('Some Font', true)).toEqual({ name: 'SomeFont-Bold', fauxBold: false })
  })
})
