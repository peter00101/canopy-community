import MarkdownIt from 'markdown-it'
import { renderMarkdownMath } from '@/lib/markdown-math'

/**
 * 表格单元格的**行内**格式渲染。
 *
 * LiveMarkdown 里的表格是 CodeMirror block widget（可编辑时点单元格就地编辑，只读时点击看源码），
 * 此前单元格走 `cell.textContent = value`，于是 `**加粗**`、`` `代码` ``、`$公式$`
 * 一律原样显示成源码——维护者 2026-09-09 报的就是这个。Agent 回复那条链路走
 * react-markdown + remarkGfm，本来就正常，只有本链路有这个洞。
 *
 * 安全边界（`html: false` + 禁用 link / image / autolink）：
 * ① 单元格本身就是「点击编辑」的热区，嵌套 `<a>` 会抢走这个点击；
 * ② 不渲染图片与外链，表格就不会在渲染时自己发起任何网络请求——md 文件可能来自
 *    Agent 下载或他人分享，不能让它一打开就外连。
 * 于是产出的标签只可能是 strong / em / code / s / br 与
 * `span.live-markdown-table-math`，可以安全地交给 innerHTML。
 */
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false })
  .disable(['link', 'image', 'autolink'])

/**
 * `$x$` / `\(x\)` / `\[x\]` 三种写法都交给 KaTeX。
 * 必须排在 `escape` 之前——否则 `\(` 会先被转义规则吃掉，公式就断了。
 */
markdown.inline.ruler.before('escape', 'table_math', (state, silent) => {
  const remaining = state.src.slice(state.pos, state.posMax)
  const match = remaining.match(/^(?:\$([^$\n]+)\$|\\\((.+?)\\\)|\\\[([\s\S]+?)\\\])/)
  if (!match) return false
  if (!silent) {
    const token = state.push('table_math', '', 0)
    token.content = match[1] ?? match[2] ?? match[3] ?? ''
    token.block = Boolean(match[3])
  }
  state.pos += match[0].length
  return true
})

/**
 * 单元格内用 `<br>` 换行是 Markdown 表格的通行写法（表格行不能真的换行），
 * 但 `html: false` 会把它当普通文本原样吐出来，所以单独认这一个标签。
 */
markdown.inline.ruler.before('html_inline', 'table_break', (state, silent) => {
  const match = state.src.slice(state.pos, state.posMax).match(/^<br\s*\/?>/i)
  if (!match) return false
  if (!silent) state.push('hardbreak', 'br', 0)
  state.pos += match[0].length
  return true
})

markdown.renderer.rules.table_math = (tokens, index) => {
  const token = tokens[index]!
  const latex = token.content
  const html = renderMarkdownMath(latex, token.block)
  // renderMarkdownMath 在 KaTeX 抛错时原样返回入参；那条路径必须转义后再进 HTML。
  const safeHtml = html === latex ? markdown.utils.escapeHtml(latex) : html
  return `<span class="live-markdown-table-math${token.block ? ' is-display' : ''}">${safeHtml}</span>`
}

/**
 * markdown-it 默认把换行渲染成 `<br>\n`。表格挂在 CodeMirror 的 `.cm-content` 里，
 * 那里是 `white-space: pre-wrap`，尾巴上的 `\n` 会再折一行——单元格里 `上<br>下` 显示成中间空一行。
 */
markdown.renderer.rules.hardbreak = () => '<br>'

markdown.renderer.rules.code_inline = (tokens, index) => {
  const value = markdown.utils.escapeHtml(tokens[index]!.content)
  return `<code class="live-markdown-table-code">${value}</code>`
}

/**
 * 把一个单元格的 Markdown 源码渲染成可直接 innerHTML 的片段。
 *
 * 用 `renderInline` 而不是 `render`：单元格不该被包成 `<p>`，也不该触发
 * 标题、列表、代码块这些块级规则。
 */
export function renderLiveMarkdownTableCell(source: string): string {
  if (!source) return ''
  return markdown.renderInline(source)
}
