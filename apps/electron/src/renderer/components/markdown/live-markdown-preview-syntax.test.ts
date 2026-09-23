import { describe, expect, test } from 'bun:test'
import {
  findInlineLiveMarkdownPreviews,
  getDisplayMathClosingDelimiter,
  getSingleLineDisplayMath,
} from './live-markdown-preview-syntax'

function mathContents(line: string): string[] {
  return findInlineLiveMarkdownPreviews(line)
    .filter((p) => p.kind === 'math')
    .map((p) => (p as { content: string }).content)
}

function escapeContents(line: string): string[] {
  return findInlineLiveMarkdownPreviews(line)
    .filter((p) => p.kind === 'escape')
    .map((p) => (p as { content: string }).content)
}

describe('getSingleLineDisplayMath：单行 $$…$$ 识别为块级公式（Typora/Obsidian 常见写法）', () => {
  test('Given 整行只有 $$公式$$ When 识别 Then 返回去定界符的公式体', () => {
    expect(getSingleLineDisplayMath('$$E=mc^2$$')).toBe('E=mc^2')
    expect(getSingleLineDisplayMath('  $$\\frac{1}{2} + \\frac{1}{3}$$  ')).toBe('\\frac{1}{2} + \\frac{1}{3}')
  })

  test('Given 仅 $$ 的开界行 When 识别 Then 返回 null 交给多行块逻辑', () => {
    expect(getSingleLineDisplayMath('$$')).toBeNull()
    expect(getDisplayMathClosingDelimiter('$$')).toBe('$$')
  })

  test('Given $$…$$ 前后还有别的文字 When 识别 Then 不按整行块处理', () => {
    expect(getSingleLineDisplayMath('前缀 $$x$$')).toBeNull()
    expect(getSingleLineDisplayMath('$$x$$ 后缀')).toBeNull()
  })

  test('Given 空内容或纯空白内容 When 识别 Then 返回 null', () => {
    expect(getSingleLineDisplayMath('$$$$')).toBeNull()
    expect(getSingleLineDisplayMath('$$   $$')).toBeNull()
  })

  test('Given 内容里还有 $（歧义写法） When 识别 Then 保守放弃', () => {
    expect(getSingleLineDisplayMath('$$a$b$$')).toBeNull()
  })
})

describe('行内公式识别：正常公式保持匹配', () => {
  test('Given 中文句子里的 $…$ When 扫描 Then 匹配公式体', () => {
    expect(mathContents('质能方程 $E=mc^2$ 嵌在句子里。')).toEqual(['E=mc^2'])
  })

  test('Given 内容含空格与反斜杠命令 When 扫描 Then 完整匹配', () => {
    expect(mathContents('$x_i^2 + y_j^3$')).toEqual(['x_i^2 + y_j^3'])
    expect(mathContents('$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$')).toEqual([
      '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    ])
  })

  test('Given \\(…\\) 定界符 When 扫描 Then 照旧匹配', () => {
    expect(mathContents('极限 \\(\\lim_{x \\to 0} x\\) 收尾')).toEqual(['\\lim_{x \\to 0} x'])
  })

  test('Given 公式后接标点或行尾 When 扫描 Then 照旧匹配', () => {
    expect(mathContents('$a^2+b^2=c^2$。')).toEqual(['a^2+b^2=c^2'])
    expect(mathContents('$100$')).toEqual(['100'])
  })

  test('Given 行内代码里的 $…$ When 扫描 Then 不当公式', () => {
    expect(mathContents('`$x$` 是代码')).toEqual([])
  })
})

describe('行内公式识别：美元价格与转义不再误判', () => {
  test('Given 两个美元价格隔开出现 When 扫描 Then 不配成一个公式', () => {
    expect(mathContents('这台机器卖 $100，那台卖 $200。')).toEqual([])
  })

  test('Given 收尾 $ 前是空格或后面紧跟数字 When 扫描 Then 不匹配', () => {
    expect(mathContents('$x $y')).toEqual([])
    expect(mathContents('$a$5 元')).toEqual([])
  })

  test('Given 开头 $ 后是空格 When 扫描 Then 不匹配', () => {
    expect(mathContents('$ x$')).toEqual([])
  })

  test('Given \\$ 转义美元号 When 扫描 Then 不开公式且产出转义预览', () => {
    expect(mathContents('\\$50 不是公式')).toEqual([])
    expect(escapeContents('\\$50 不是公式')).toEqual(['$'])
  })

  test('Given 行内代码里的 \\$ When 扫描 Then 不产出转义预览', () => {
    expect(escapeContents('`\\$50` 是代码')).toEqual([])
  })
})

describe('行内 $$…$$（未独占一行时）', () => {
  test('Given 句中出现 $$x$$ When 扫描 Then 作为一个公式匹配、无残留美元符', () => {
    const previews = findInlineLiveMarkdownPreviews('前 $$E=mc^2$$ 后')
    const math = previews.filter((p) => p.kind === 'math')
    expect(math).toHaveLength(1)
    expect((math[0] as { content: string }).content).toBe('E=mc^2')
    const line = '前 $$E=mc^2$$ 后'
    expect(line.slice((math[0] as { from: number }).from, (math[0] as { to: number }).to)).toBe('$$E=mc^2$$')
  })

  test('Given 单个 $ 公式与 $$ 公式同行 When 扫描 Then 各自独立匹配', () => {
    expect(mathContents('$a+b$ 与 $$c+d$$ 同行')).toEqual(['a+b', 'c+d'])
  })
})

describe('既有行为回归：图片与自动链接', () => {
  test('Given 图片与角括号链接 When 扫描 Then 种类与内容不变', () => {
    const previews = findInlineLiveMarkdownPreviews('![alt](a.png) 与 <https://example.com>')
    expect(previews.map((p) => p.kind).sort()).toEqual(['autolink', 'image'])
  })
})
