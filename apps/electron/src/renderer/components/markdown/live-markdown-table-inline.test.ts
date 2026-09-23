import { describe, expect, it } from 'bun:test'
import { renderLiveMarkdownTableCell } from './live-markdown-table-inline'

/**
 * 维护者 2026-09-09 报障：md 文档的表格里写 `**字**`，渲染出来还是 `**字**`。
 * 根因是 TableWidget 走 `cell.textContent = value` 把整格当纯文本。
 *
 * 这批用例分两半：前半钉「该渲染的要渲染」，后半钉「不该渲染的一个都不许出现」
 * ——单元格结果是直接 innerHTML 进 DOM 的，安全边界破了就是 XSS 与静默外连。
 */
describe('表格单元格行内格式 — 该渲染的', () => {
  it('Given **加粗**，When 渲染，Then 出 strong 且不留星号', () => {
    const html = renderLiveMarkdownTableCell('**重要**')
    expect(html).toContain('<strong>重要</strong>')
    expect(html).not.toContain('**')
  })

  it('Given 一格里加粗与普通文字混排，When 渲染，Then 只包住加粗那段', () => {
    expect(renderLiveMarkdownTableCell('前 **中** 后'))
      .toBe('前 <strong>中</strong> 后')
  })

  it('Given *斜体*，When 渲染，Then 出 em', () => {
    expect(renderLiveMarkdownTableCell('*斜*')).toContain('<em>斜</em>')
  })

  it('Given ~~删除线~~，When 渲染，Then 出 s', () => {
    expect(renderLiveMarkdownTableCell('~~废~~')).toContain('<s>废</s>')
  })

  it('Given 行内代码，When 渲染，Then 出带类名的 code 且内容转义', () => {
    const html = renderLiveMarkdownTableCell('`a<b>c`')
    expect(html).toContain('<code class="live-markdown-table-code">')
    expect(html).toContain('a&lt;b&gt;c')
    expect(html).not.toContain('<b>')
  })

  it('Given 加粗套代码，When 渲染，Then 两层都在', () => {
    const html = renderLiveMarkdownTableCell('**`x`**')
    expect(html).toContain('<strong>')
    expect(html).toContain('<code')
  })

  it('Given $行内公式$，When 渲染，Then 交给 KaTeX 并挂表格公式类名', () => {
    const html = renderLiveMarkdownTableCell('$a^2$')
    expect(html).toContain('live-markdown-table-math')
    expect(html).not.toContain('$a^2$')
  })

  it('Given \\(...\\) 与 \\[...\\] 两种公式写法，When 渲染，Then 同样识别', () => {
    expect(renderLiveMarkdownTableCell('\\(x\\)')).toContain('live-markdown-table-math')
    const display = renderLiveMarkdownTableCell('\\[y\\]')
    expect(display).toContain('live-markdown-table-math')
    // 方括号形态是展示态公式，要能被样式区分出来
    expect(display).toContain('is-display')
  })

  it('Given 单元格里用 <br> 换行，When 渲染，Then 出真正的换行标签', () => {
    const html = renderLiveMarkdownTableCell('上<br>下')
    expect(html).toContain('<br')
    expect(html).not.toContain('&lt;br')
    // 表格在 pre-wrap 的 .cm-content 里，<br> 后面再跟 \n 会多折出一个空行
    expect(html).not.toContain('\n')
  })

  it('Given 纯文本，When 渲染，Then 原样返回', () => {
    expect(renderLiveMarkdownTableCell('普通一格')).toBe('普通一格')
  })

  it('Given 空字符串，When 渲染，Then 返回空而不是抛错', () => {
    expect(renderLiveMarkdownTableCell('')).toBe('')
  })

  it('Given 不该被当成块级语法的内容，When 渲染，Then 不产生 p / h1 / li', () => {
    const html = renderLiveMarkdownTableCell('# 不是标题')
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('<p>')
    expect(html).toContain('# 不是标题')
  })
})

describe('表格单元格行内格式 — 安全边界', () => {
  it('Given 原始 HTML，When 渲染，Then 整段转义而不是当标签执行', () => {
    const html = renderLiveMarkdownTableCell('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('Given 带事件属性的标签，When 渲染，Then 同样被转义', () => {
    const html = renderLiveMarkdownTableCell('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('Given Markdown 链接，When 渲染，Then 不产生 a 标签（表格整块是进编辑的点击热区）', () => {
    const html = renderLiveMarkdownTableCell('[点我](https://example.com)')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href')
  })

  it('Given 裸 URL，When 渲染，Then 不自动链接', () => {
    const html = renderLiveMarkdownTableCell('https://example.com')
    expect(html).not.toContain('<a ')
  })

  it('Given Markdown 图片，When 渲染，Then 不产生 img（打开表格不该发起网络请求）', () => {
    const html = renderLiveMarkdownTableCell('![alt](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://example.com/a.png"')
  })

  it('Given HTML 特殊字符，When 渲染，Then 转义', () => {
    expect(renderLiveMarkdownTableCell('a & b < c')).toContain('&amp;')
    expect(renderLiveMarkdownTableCell('a & b < c')).toContain('&lt;')
  })

  it('Given KaTeX 无法解析的公式，When 渲染，Then 回退文本也要转义', () => {
    // renderMarkdownMath 抛错时原样返回入参，那条路径不转义就是注入口子
    const html = renderLiveMarkdownTableCell('$\\begin{<script>}$')
    expect(html).not.toContain('<script>')
  })
})
