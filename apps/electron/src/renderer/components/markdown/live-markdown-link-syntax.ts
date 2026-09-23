import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']

/** 一条行内链接 `[text](dest "title")` 在文档里的关键范围。 */
export interface MarkdownInlineLink {
  /** 链接文字（`[` 与 `]` 之间）的范围；阅读态保留并加链接样式 */
  textFrom: number
  textTo: number
  /** 目标段的范围：`(` 之后到 `)` 之前，含 URL、可选标题以及二者之间的空白；阅读态整段隐藏 */
  destinationFrom: number
  destinationTo: number
  /** 去掉尖括号后的目标（用于 title 提示与 Ctrl/Cmd+点击） */
  href: string
  /** 链接起始所在行号（1-based），与语法隐藏的活动行判定同口径 */
  line: number
}

function sliceNode(state: EditorState, node: { from: number; to: number }): string {
  return state.doc.sliceString(node.from, node.to)
}

/**
 * 从 CodeMirror 已维护的 Markdown 语法树里找出所有行内链接（`[text](dest)` 形态）。
 *
 * 只处理 Lezer 的 `Link` 节点：`Image`（`![alt](src)`）与 `Autolink`（`<https://…>`）的 `URL`
 * 父节点不同，这里不碰——图片由行内预览换成图片 widget，尖括号自动链接由 AngleAutolinkWidget 接管。
 * 引用式链接 `[text][ref]` 没有 `(`/`)` 两枚标记，同样不在此列。
 */
export function findMarkdownInlineLinks(state: EditorState): MarkdownInlineLink[] {
  const links: MarkdownInlineLink[] = []
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.type.name !== 'Link') return
      const link: SyntaxNode = ref.node
      const marks = link.getChildren('LinkMark')
      const url = link.getChild('URL')
      if (marks.length < 4 || !url) return
      const open = marks[0]!
      const close = marks[1]!
      const paren = marks[2]!
      const closeParen = marks[marks.length - 1]!
      if (
        sliceNode(state, open) !== '['
        || sliceNode(state, close) !== ']'
        || sliceNode(state, paren) !== '('
        || sliceNode(state, closeParen) !== ')'
      ) return

      const rawHref = sliceNode(state, url)
      const href = rawHref.startsWith('<') && rawHref.endsWith('>') ? rawHref.slice(1, -1) : rawHref
      links.push({
        textFrom: open.to,
        textTo: close.from,
        destinationFrom: paren.to,
        destinationTo: closeParen.from,
        href,
        line: state.doc.lineAt(link.from).number,
      })
    },
  })
  return links
}

/** Ctrl/Cmd+点击只放行 http(s) 外链；相对路径与其他协议交由后续的 Vault 内部跳转处理。 */
export function isOpenableMarkdownLinkHref(href: string | undefined): href is string {
  return typeof href === 'string' && /^https?:\/\//i.test(href)
}
