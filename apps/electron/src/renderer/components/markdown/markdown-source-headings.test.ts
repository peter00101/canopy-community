import { describe, expect, test } from 'bun:test'
import { extractMarkdownSourceHeadings } from './markdown-source-headings'

describe('extractMarkdownSourceHeadings：从完整 Markdown 源码提取标题（虚拟化安全的 TOC 数据源）', () => {
  test('Given 各级 ATX 标题 When 提取 Then 级别、文本与 1-based 行号齐全', () => {
    const source = ['# 一级', '', '## 二级', '正文', '###### 六级'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([
      { level: 1, text: '一级', line: 1 },
      { level: 2, text: '二级', line: 3 },
      { level: 6, text: '六级', line: 5 },
    ])
  })

  test('Given 前导空格 When 提取 Then 3 空格内算标题、4 空格是缩进代码不算', () => {
    const source = ['   ## 缩进三格', '    ## 缩进四格'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 2, text: '缩进三格', line: 1 }])
  })

  test('Given 尾部闭合井号与空标题 When 提取 Then 闭合号剥掉、空标题跳过', () => {
    const source = ['## 标题 ##', '##', '##   ##'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 2, text: '标题', line: 1 }])
  })

  test('Given fenced code 里的 # 行 When 提取 Then 不算标题（``` 与 ~~~ 都认）', () => {
    const source = ['```py', '# 注释不是标题', '```', '~~~', '## 也不是', '~~~', '# 真标题'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 1, text: '真标题', line: 7 }])
  })

  test('Given 未闭合的 fence When 提取 Then 其后内容全部跳过', () => {
    const source = ['# 前', '```', '# 里面', '# 还在里面'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 1, text: '前', line: 1 }])
  })

  test('Given YAML frontmatter When 提取 Then 整段跳过、其内 key 行与 --- 不算标题', () => {
    const source = ['---', 'title: x', '---', '# 正文标题'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 1, text: '正文标题', line: 4 }])
  })

  test('Given $$ 块级公式内的 # When 提取 Then 不算标题', () => {
    const source = ['$$', '# 公式里', '$$', '# 真标题'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 1, text: '真标题', line: 4 }])
  })

  test('Given Setext 下划线 When 提取 Then === 为一级、--- 为二级、行号指向正文行', () => {
    const source = ['标题甲', '===', '', '标题乙', '---'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([
      { level: 1, text: '标题甲', line: 1 },
      { level: 2, text: '标题乙', line: 4 },
    ])
  })

  test('Given 空行或列表项后的 --- When 提取 Then 是分隔线/不误判成 Setext', () => {
    const source = ['', '---', '- 列表项', '---'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([])
  })

  test('Given 标题文本带行内 Markdown When 提取 Then 剥掉标记留纯文本', () => {
    const source = ['# **加粗** 与 [链接](https://x) 和 `code` 与 ![图](u.png)'].join('\n')
    expect(extractMarkdownSourceHeadings(source)).toEqual([
      { level: 1, text: '加粗 与 链接 和 code 与 图', line: 1 },
    ])
  })

  test('Given 零宽字符混入标题 When 提取 Then 剔除后保留可见文本', () => {
    const source = '# 标​题'
    expect(extractMarkdownSourceHeadings(source)).toEqual([{ level: 1, text: '标题', line: 1 }])
  })

  test('Given CRLF 换行 When 提取 Then 行号与文本不受 \\r 影响', () => {
    const source = '# 甲\r\n正文\r\n## 乙\r\n'
    expect(extractMarkdownSourceHeadings(source)).toEqual([
      { level: 1, text: '甲', line: 1 },
      { level: 2, text: '乙', line: 3 },
    ])
  })

  test('Given 空文档 When 提取 Then 空列表', () => {
    expect(extractMarkdownSourceHeadings('')).toEqual([])
  })
})
