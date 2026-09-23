import { createRoot, type Root } from 'react-dom/client'
import DOMPurify from 'dompurify'
import { RangeSetBuilder, StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { highlightCode, highlightToTokens } from '@canopy/core'
import type { HighlightTokensResult } from '@canopy/core'
import { CodeBlock, MermaidBlock } from '@canopy/ui'
import { shouldRenderMermaidCodeBlock } from '@/lib/mermaid-detection'
import { copyTextToClipboard } from '@/lib/clipboard'
import { renderMarkdownMath } from '@/lib/markdown-math'
import {
  findInlineLiveMarkdownPreviews,
  findRawHtmlBlockEnd,
  getDisplayMathClosingDelimiter,
  getSingleLineDisplayMath,
} from './live-markdown-preview-syntax'
import {
  isLiveMarkdownTableSeparator,
  parseLiveMarkdownTable,
  serializeLiveMarkdownTable,
  shouldRenderLiveMarkdownBlockPreview,
  type LiveMarkdownTable,
} from './live-markdown-table'
import { renderLiveMarkdownTableCell } from './live-markdown-table-inline'
import { LiveMarkdownTableEditor, type LiveMarkdownTableFocus } from './LiveMarkdownTableEditor'
import { isDirectRenderableImageSrc } from './markdown-image-src'

type PreviewKind = 'code' | 'table' | 'mermaid' | 'thematic-break' | 'math' | 'raw-html'

export type ResolveLiveMarkdownImageSrc = (src: string) => Promise<string | null>
export type SaveLiveMarkdownPastedImage = (file: File) => Promise<string | null>

interface PreviewBlock {
  kind: PreviewKind
  from: number
  to: number
  decoration: Decoration
}

interface FencedCodeBlock {
  language: string
  code: string
  from: number
  to: number
}

const shikiRefreshEffect = StateEffect.define<string>()
const enterTableSourceEditEffect = StateEffect.define<number>()
const shikiTokenCache = new Map<string, HighlightTokensResult>()
const SHIKI_CACHE_LIMIT = 160

function currentShikiTheme(): string {
  return document.documentElement.classList.contains('dark') ? 'github-dark' : 'github-light'
}

/** CodeMirror 会在状态事务期间销毁 widget；推迟 React root 卸载避免与并发渲染竞争。 */
function unmountRootAfterRender(root: Root | null): void {
  if (!root) return
  queueMicrotask(() => root.unmount())
}

function findFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
  const lines = markdown.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) { starts.push(offset); offset += line.length + 1 }
  const blocks: FencedCodeBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const opening = (lines[index] ?? '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!opening) continue
    const marker = opening[1]![0]!
    const length = opening[1]!.length
    let closing = index + 1
    while (closing < lines.length && !new RegExp(`^ {0,3}\\${marker}{${length},}\\s*$`).test(lines[closing] ?? '')) closing += 1
    if (closing >= lines.length) continue
    const from = starts[index + 1] ?? starts[closing] ?? markdown.length
    const closingFrom = starts[closing] ?? markdown.length
    blocks.push({ language: opening[2]?.trim().split(/\s+/)[0] ?? '', code: markdown.slice(from, Math.max(from, closingFrom - 1)), from, to: Math.max(from, closingFrom - 1) })
    index = closing
  }
  return blocks
}

function needsShikiLoad(language: string, result: HighlightTokensResult | null): boolean {
  return language !== 'text' && (!result || result.language === 'text')
}

function shikiTokens(code: string, language: string, theme: string): HighlightTokensResult | null {
  const key = `${theme}\u0000${language}\u0000${code}`
  const cached = shikiTokenCache.get(key)
  if (cached) return cached
  const result = highlightToTokens({ code, language, theme })
  if (result && !needsShikiLoad(language, result)) {
    shikiTokenCache.set(key, result)
    if (shikiTokenCache.size > SHIKI_CACHE_LIMIT) shikiTokenCache.delete(shikiTokenCache.keys().next().value!)
  }
  return result
}

function shikiDecorations(state: EditorState, theme: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const block of findFencedCodeBlocks(state.doc.toString())) {
    if (shouldRenderMermaidCodeBlock(block.language ? `language-${block.language}` : undefined, block.code)) continue
    const result = shikiTokens(block.code, block.language || 'text', theme)
    if (!result) continue
    let offset = block.from
    for (const [lineIndex, line] of result.lines.entries()) {
      for (const token of line) {
        const from = offset
        const to = Math.min(from + token.content.length, block.to)
        if (token.color && from < to) builder.add(from, to, Decoration.mark({ attributes: { style: `color: ${token.color}` } }))
        offset = to
      }
      if (lineIndex < result.lines.length - 1 && offset < block.to) offset += 1
    }
  }
  return builder.finish()
}

const shikiDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    const refresh = transaction.effects.find((effect) => effect.is(shikiRefreshEffect))
    return refresh ? shikiDecorations(transaction.state, refresh.value) : value.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

const liveMarkdownShikiHighlight: Extension = [
  shikiDecorationsField,
  ViewPlugin.fromClass(class {
    private pending = new Set<string>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private destroyed = false
    private theme = currentShikiTheme()
    private observer: MutationObserver
    constructor(private readonly view: EditorView) {
      this.observer = new MutationObserver(() => {
        const next = currentShikiTheme()
        if (next !== this.theme) { this.theme = next; this.refresh(0) }
      })
      this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      this.refresh(0)
    }
    update(update: { docChanged: boolean }): void { if (update.docChanged) this.refresh(120) }
    destroy(): void { this.destroyed = true; this.observer.disconnect(); if (this.timer) clearTimeout(this.timer) }
    private refresh(delay: number): void {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        const languages = new Set(findFencedCodeBlocks(this.view.state.doc.toString()).map((block) => block.language || 'text'))
        for (const language of languages) {
          const probe = highlightToTokens({ code: '', language, theme: this.theme })
          if (probe && !needsShikiLoad(language, probe)) continue
          const key = `${this.theme}:${language}`
          if (this.pending.has(key)) continue
          this.pending.add(key)
          void highlightCode({ code: '', language, theme: this.theme }).catch(() => {}).finally(() => {
            this.pending.delete(key)
            if (!this.destroyed) this.view.dispatch({ effects: shikiRefreshEffect.of(this.theme) })
          })
        }
        if (!this.destroyed) this.view.dispatch({ effects: shikiRefreshEffect.of(this.theme) })
      }, delay)
    }
  }),
]

interface PreviewState {
  activeLines: Set<number>
  blocks: PreviewBlock[]
  editingTableFrom: number | null
  decorations: DecorationSet
}

function activeLines(state: EditorState): Set<number> {
  return new Set(state.selection.ranges.map((range) => state.doc.lineAt(range.head).number))
}

function sameLines(left: Set<number>, right: Set<number>): boolean {
  return left.size === right.size && [...left].every((line) => right.has(line))
}

abstract class LiveMarkdownBlockWidget extends WidgetType {
  private observer: ResizeObserver | null = null

  protected observeSize(element: HTMLElement, view: EditorView): void {
    if (typeof ResizeObserver === 'undefined') return
    this.observer = new ResizeObserver(() => view.requestMeasure())
    this.observer.observe(element)
  }

  override destroy(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  override ignoreEvent(_event?: Event): boolean { return false }
}

class CodeBlockWidget extends LiveMarkdownBlockWidget {
  private root: Root | null = null
  constructor(
    private readonly code: string,
    private readonly language: string,
    private readonly from: number,
  ) { super() }
  override eq(other: CodeBlockWidget): boolean {
    return this.from === other.from && this.code === other.code && this.language === other.language
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'live-markdown-code-block'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    this.root = createRoot(wrapper)
    this.root.render(
      <CodeBlock onCopy={copyTextToClipboard}>
        <code className={this.language ? `language-${this.language}` : undefined}>{this.code}</code>
      </CodeBlock>,
    )
    this.observeSize(wrapper, view)
    return wrapper
  }
  override destroy(): void {
    super.destroy()
    unmountRootAfterRender(this.root)
    this.root = null
  }
}

/**
 * 表格改动落进文档后 widget 会整块重建；新实例靠这张表知道焦点该回到哪一格。
 * 按 view 存、按表格起点匹配，取出即删。
 */
const pendingTableFocus = new WeakMap<EditorView, { from: number; focus: LiveMarkdownTableFocus }>()

function takePendingTableFocus(view: EditorView, from: number): LiveMarkdownTableFocus | null {
  const pending = pendingTableFocus.get(view)
  if (!pending || pending.from !== from) return null
  pendingTableFocus.delete(view)
  return pending.focus
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

/**
 * 可编辑时渲染 `LiveMarkdownTableEditor`（点单元格就地编辑、右键行列操作、右键「编辑源码」）；
 * 只读时保持原来的纯渲染，点击仍按旧行为显示源码。
 */
class TableWidget extends LiveMarkdownBlockWidget {
  private root: Root | null = null

  constructor(
    private readonly table: LiveMarkdownTable,
    private readonly source: string,
    private readonly from: number,
    // 不能叫 editable：WidgetType 自带同名只读 getter，赋值会在构造时抛错（dev 实测踩到）。
    private readonly interactive: boolean,
  ) { super() }

  override eq(other: TableWidget): boolean {
    return this.from === other.from && this.source === other.source && this.interactive === other.interactive
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'vault-markdown-table'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    wrapper.dataset.liveMarkdownBlockKind = 'table'
    if (this.interactive) {
      wrapper.classList.add('is-editable')
      this.root = createRoot(wrapper)
      this.root.render(
        <LiveMarkdownTableEditor
          table={this.table}
          initialFocus={takePendingTableFocus(view, this.from)}
          onChange={(next, focus) => this.replaceSource(view, serializeLiveMarkdownTable(next, this.source), focus)}
          onDeleteTable={() => this.deleteTable(view)}
          onEditSource={() => this.editSource(view)}
          onSaveShortcut={() => this.forwardSaveShortcut(view)}
          onEditorShortcut={(event) => this.forwardEditorShortcut(view, event)}
        />,
      )
    } else {
      wrapper.appendChild(this.renderStaticTable())
    }
    this.observeSize(wrapper, view)
    return wrapper
  }

  /** 可编辑表格的鼠标 / 键盘事件全部由组件自己处理，不能让 CodeMirror 抢去移动选区。 */
  override ignoreEvent(): boolean { return this.interactive }

  override destroy(): void {
    super.destroy()
    unmountRootAfterRender(this.root)
    this.root = null
  }

  private renderStaticTable(): HTMLTableElement {
    const table = document.createElement('table')
    table.setAttribute('aria-label', 'Markdown 表格')
    const rows = [this.table.header, ...this.table.rows]
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr')
      row.forEach((value, column) => {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td')
        const alignment = this.table.alignments[column]
        if (alignment) cell.style.textAlign = alignment
        // 不能用 textContent：那样 **加粗**、`代码`、$公式$ 会原样显示成源码。
        // 渲染器只产出 strong/em/code/s/br/span.math，安全边界见该模块注释。
        cell.innerHTML = renderLiveMarkdownTableCell(value)
        tr.appendChild(cell)
      })
      table.appendChild(tr)
    })
    return table
  }

  /** 源码还是本 widget 建出来时那一份才写：别处（外部改动、另一次提交）已改过就放弃，绝不覆盖。 */
  private isSourceCurrent(view: EditorView): boolean {
    return view.state.sliceDoc(this.from, this.from + this.source.length) === this.source
  }

  private replaceSource(view: EditorView, nextSource: string, focus?: LiveMarkdownTableFocus): boolean {
    if (view.state.readOnly || !this.isSourceCurrent(view)) return false
    if (nextSource === this.source) return false
    if (focus) pendingTableFocus.set(view, { from: this.from, focus })
    view.dispatch({
      changes: { from: this.from, to: this.from + this.source.length, insert: nextSource },
      userEvent: 'input.table',
    })
    // 焦点只给 dispatch 里同步重建的那一个实例用；没被取走（例如 widget 未重建）就作废，免得日后错投。
    window.setTimeout(() => {
      if (pendingTableFocus.get(view)?.from === this.from) pendingTableFocus.delete(view)
    }, 0)
    return true
  }

  /**
   * 右键菜单是模态的，关闭前它的焦点陷阱还挂着：这时直接 `view.focus()` 会被拽回菜单，
   * 菜单随旧 widget 卸载后焦点就掉到 body，Mod+Z 撤不回来（dev 实测）。
   * 旧 React root 的卸载在 dispatch 里就排进了微任务，这里再排一个，保证在它之后聚焦。
   */
  private focusEditorAfterMenu(view: EditorView): void {
    queueMicrotask(() => view.focus())
  }

  private deleteTable(view: EditorView): void {
    if (view.state.readOnly || !this.isSourceCurrent(view)) return
    const from = this.from
    let to = from + this.source.length
    const blankBefore = from === 0 || view.state.sliceDoc(Math.max(0, from - 2), from) === '\n\n' || view.state.sliceDoc(0, from) === '\n'
    // 表格夹在两个空行之间：连后面的空行一起删，两段之间只留一个空行；否则只删表格末尾的换行，不把上下两段粘在一起。
    if (blankBefore && view.state.sliceDoc(to, to + 2) === '\n\n') to += 2
    else if (view.state.sliceDoc(to, to + 1) === '\n') to += 1
    view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'delete.table' })
    this.focusEditorAfterMenu(view)
  }

  private editSource(view: EditorView): void {
    if (!this.isSourceCurrent(view)) return
    view.dispatch({
      selection: { anchor: this.from },
      effects: [enterTableSourceEditEffect.of(this.from), EditorView.scrollIntoView(this.from, { y: 'nearest' })],
    })
    this.focusEditorAfterMenu(view)
  }

  /**
   * 焦点停在格子上时按 Mod+Z / Mod+Shift+Z / Mod+Y / Mod+S：widget 的事件 CodeMirror 一律不收，
   * 所以把焦点交还编辑器、原样重发这个按键，撤销 / 重做 / 保存都走编辑器自己的快捷键表。
   * 撤销会重建表格，焦点留在编辑器里，连按 Mod+Z 可以一路撤回去。
   */
  private forwardEditorShortcut(view: EditorView, event: KeyboardEvent): void {
    view.focus()
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      bubbles: true,
      cancelable: true,
    }))
  }

  /**
   * 编辑框在 widget 里，CodeMirror 的 Mod-s 快捷键收不到。草稿已同步落进文档，
   * 但宿主的保存函数读的是 React 状态（onChange 触发的 setState 要下一轮才生效），
   * 所以推迟一个宏任务再把快捷键转发给编辑器，走宿主原本的保存逻辑。
   */
  private forwardSaveShortcut(view: EditorView): void {
    window.setTimeout(() => {
      const mac = isMacPlatform()
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        keyCode: 83,
        ctrlKey: !mac,
        metaKey: mac,
        bubbles: true,
        cancelable: true,
      }))
    }, 0)
  }
}

class HorizontalRuleWidget extends LiveMarkdownBlockWidget {
  constructor(private readonly from: number) { super() }
  override eq(other: HorizontalRuleWidget): boolean { return this.from === other.from }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'vault-horizontal-rule'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    wrapper.appendChild(document.createElement('hr'))
    this.observeSize(wrapper, view)
    return wrapper
  }
}

class MermaidWidget extends LiveMarkdownBlockWidget {
  private root: Root | null = null
  constructor(private readonly code: string, private readonly from: number) { super() }
  override eq(other: MermaidWidget): boolean { return this.from === other.from && this.code === other.code }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'vault-mermaid-block'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    this.root = createRoot(wrapper)
    this.root.render(<MermaidBlock code={this.code} />)
    this.observeSize(wrapper, view)
    return wrapper
  }
  override destroy(): void {
    super.destroy()
    unmountRootAfterRender(this.root)
    this.root = null
  }
}

class MathWidget extends LiveMarkdownBlockWidget {
  constructor(private readonly latex: string, private readonly from: number) { super() }
  override eq(other: MathWidget): boolean { return this.from === other.from && this.latex === other.latex }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'live-markdown-math-block'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    wrapper.innerHTML = renderMarkdownMath(this.latex, true)
    this.observeSize(wrapper, view)
    return wrapper
  }
}

class InlineMathWidget extends WidgetType {
  constructor(private readonly latex: string, private readonly from: number) { super() }
  override eq(other: InlineMathWidget): boolean { return this.latex === other.latex && this.from === other.from }
  override toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'live-markdown-math-inline'
    element.dataset.liveMarkdownInlineFrom = String(this.from)
    element.setAttribute('aria-label', '点击编辑公式')
    element.innerHTML = renderMarkdownMath(this.latex)
    return element
  }
  override ignoreEvent(): boolean { return false }
}

/** Raw HTML 在阅读态保持可用，但先经 DOMPurify 处理，避免 Markdown 文件执行脚本。 */
class RawHtmlBlockWidget extends LiveMarkdownBlockWidget {
  constructor(
    private readonly html: string,
    private readonly from: number,
    private readonly resolveImageSrc?: ResolveLiveMarkdownImageSrc,
  ) { super() }
  override eq(other: RawHtmlBlockWidget): boolean { return this.from === other.from && this.html === other.html }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'live-markdown-raw-html-block'
    wrapper.dataset.liveMarkdownBlockFrom = String(this.from)
    wrapper.innerHTML = DOMPurify.sanitize(this.html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style'],
      FORBID_ATTR: ['style'],
    })
    for (const link of Array.from(wrapper.querySelectorAll('a'))) {
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
    }
    if (this.resolveImageSrc) {
      for (const image of Array.from(wrapper.querySelectorAll('img'))) {
        const src = image.getAttribute('src') ?? ''
        if (!src || isDirectRenderableImageSrc(src)) continue
        // 本地路径按渲染层 origin 加载必 404，先摘掉避免碎图，解析成功再回填
        image.removeAttribute('src')
        void this.resolveImageSrc(src).then((resolved) => {
          if (resolved) image.src = resolved
        }).catch(() => {})
      }
    }
    this.observeSize(wrapper, view)
    return wrapper
  }
}

class InlineImageWidget extends WidgetType {
  private destroyed = false

  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly title: string,
    private readonly from: number,
    private readonly resolveImageSrc?: ResolveLiveMarkdownImageSrc,
  ) { super() }

  override eq(other: InlineImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt && this.title === other.title && this.from === other.from
  }

  override toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('span')
    element.className = 'live-markdown-image'
    element.dataset.liveMarkdownInlineFrom = String(this.from)
    element.setAttribute('aria-label', '点击编辑图片')

    const image = document.createElement('img')
    image.alt = this.alt
    image.title = this.title
    image.loading = 'lazy'
    image.addEventListener('load', () => view.requestMeasure())
    image.addEventListener('error', () => view.requestMeasure())
    element.appendChild(image)

    if (isDirectRenderableImageSrc(this.src)) {
      image.src = this.src
    } else if (this.resolveImageSrc) {
      void this.resolveImageSrc(this.src).then((resolved) => {
        if (!this.destroyed && resolved) image.src = resolved
      }).catch(() => {})
    }
    return element
  }

  override destroy(): void { this.destroyed = true }
  override ignoreEvent(): boolean { return false }
}

/** 阅读态把 \$ 一类转义序列显示为其字面字符，点击进入源码编辑。 */
class EscapedTextWidget extends WidgetType {
  constructor(private readonly text: string, private readonly from: number) { super() }
  override eq(other: EscapedTextWidget): boolean { return this.text === other.text && this.from === other.from }
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'live-markdown-escape'
    span.dataset.liveMarkdownInlineFrom = String(this.from)
    span.textContent = this.text
    return span
  }
  override ignoreEvent(): boolean { return false }
}

/** CommonMark angle autolinks are not interpreted by ink-mde, so retain their normal link behavior. */
class AngleAutolinkWidget extends WidgetType {
  constructor(private readonly href: string) { super() }
  override eq(other: AngleAutolinkWidget): boolean { return this.href === other.href }
  override toDOM(): HTMLElement {
    const link = document.createElement('a')
    link.className = 'live-markdown-autolink'
    link.href = this.href
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.textContent = this.href
    return link
  }
  override ignoreEvent(): boolean { return false }
}

function buildBlocks(state: EditorState, resolveImageSrc?: ResolveLiveMarkdownImageSrc): PreviewBlock[] {
  const blocks: PreviewBlock[] = []
  const lines = Array.from({ length: state.doc.lines }, (_, index) => state.doc.line(index + 1).text)
  for (let number = 1; number <= lines.length; number += 1) {
    const line = lines[number - 1] ?? ''
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const marker = fence[1]![0]!
      const length = fence[1]!.length
      let closing = number + 1
      while (closing <= lines.length && !new RegExp(`^ {0,3}\\${marker}{${length},}\\s*$`).test(lines[closing - 1] ?? '')) closing += 1
      if (closing <= lines.length) {
        const info = fence[2]?.trim().split(/\s+/)[0] ?? ''
        const from = state.doc.line(number).from
        const to = state.doc.line(closing).to
        const code = lines.slice(number, closing - 1).join('\n')
        if (shouldRenderMermaidCodeBlock(info ? `language-${info}` : undefined, code)) {
          blocks.push({ kind: 'mermaid', from, to, decoration: Decoration.replace({ widget: new MermaidWidget(code, from), block: true }) })
        } else {
          blocks.push({ kind: 'code', from, to, decoration: Decoration.replace({ widget: new CodeBlockWidget(code, info, from), block: true }) })
        }
        number = closing
      }
      continue
    }
    const singleLineMath = getSingleLineDisplayMath(line)
    if (singleLineMath !== null) {
      const from = state.doc.line(number).from
      const to = state.doc.line(number).to
      blocks.push({ kind: 'math', from, to, decoration: Decoration.replace({ widget: new MathWidget(singleLineMath, from), block: true }) })
      continue
    }
    const closingDelimiter = getDisplayMathClosingDelimiter(line)
    if (closingDelimiter) {
      let closing = number + 1
      while (closing <= lines.length && (lines[closing - 1] ?? '').trim() !== closingDelimiter) closing += 1
      if (closing <= lines.length) {
        const from = state.doc.line(number).from
        const to = state.doc.line(closing).to
        blocks.push({ kind: 'math', from, to, decoration: Decoration.replace({ widget: new MathWidget(lines.slice(number, closing - 1).join('\n'), from), block: true }) })
        number = closing
      }
      continue
    }
    const rawHtmlEnd = findRawHtmlBlockEnd(lines, number - 1)
    if (rawHtmlEnd !== null) {
      const from = state.doc.line(number).from
      const to = state.doc.line(rawHtmlEnd + 1).to
      const html = lines.slice(number - 1, rawHtmlEnd + 1).join('\n')
      blocks.push({ kind: 'raw-html', from, to, decoration: Decoration.replace({ widget: new RawHtmlBlockWidget(html, from, resolveImageSrc), block: true }) })
      number = rawHtmlEnd + 1
      continue
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      const from = state.doc.line(number).from
      blocks.push({ kind: 'thematic-break', from, to: state.doc.line(number).to, decoration: Decoration.replace({ widget: new HorizontalRuleWidget(from), block: true }) })
      continue
    }
    if (line.includes('|') && number < lines.length && isLiveMarkdownTableSeparator(lines[number] ?? '')) {
      let end = number + 1
      while (end < lines.length && (lines[end] ?? '').trim() && (lines[end] ?? '').includes('|')) end += 1
      const from = state.doc.line(number).from
      const to = state.doc.line(end).to
      const source = state.sliceDoc(from, to)
      const table = parseLiveMarkdownTable(source)
      if (table) {
        blocks.push({ kind: 'table', from, to, decoration: Decoration.replace({ widget: new TableWidget(table, source, from, !state.readOnly), block: true }) })
      }
      number = end
    }
  }
  return blocks
}

function buildDecorations(
  state: EditorState,
  blocks: PreviewBlock[],
  lines: Set<number>,
  editingTableFrom: number | null,
  resolveImageSrc?: ResolveLiveMarkdownImageSrc,
): DecorationSet {
  const entries: Array<{ from: number; to: number; decoration: Decoration }> = []
  const protectedRanges = blocks.map((block) => ({ from: block.from, to: block.to }))
  for (const block of blocks) {
    const first = state.doc.lineAt(block.from).number
    const last = state.doc.lineAt(block.to).number
    // 表格只在用户主动要源码时切换（可编辑：右键「编辑源码」；只读：点击），避免初始光标刚好落在首行时阅读态消失。
    const hasActiveSelectionInBlock = [...lines].some((line) => line >= first && line <= last)
    const isExplicitlyEditingTable = block.kind === 'table' && editingTableFrom === block.from
    if (shouldRenderLiveMarkdownBlockPreview(block.kind === 'table' ? 'table' : 'other', hasActiveSelectionInBlock, isExplicitlyEditingTable)) entries.push(block)
  }
  for (let number = 1; number <= state.doc.lines; number += 1) {
    if (lines.has(number)) continue
    const line = state.doc.line(number)
    for (const preview of findInlineLiveMarkdownPreviews(line.text)) {
      const from = line.from + preview.from
      const to = line.from + preview.to
      if (protectedRanges.some((range) => from >= range.from && to <= range.to)) continue
      const widget = preview.kind === 'math'
        ? new InlineMathWidget(preview.content, from)
        : preview.kind === 'image'
          ? new InlineImageWidget(preview.src, preview.alt, preview.title, from, resolveImageSrc)
          : preview.kind === 'escape'
            ? new EscapedTextWidget(preview.content, from)
            : new AngleAutolinkWidget(preview.content)
      entries.push({ from, to, decoration: Decoration.replace({ widget }) })
    }
  }
  entries.sort((left, right) => left.from - right.from || left.to - right.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const entry of entries) builder.add(entry.from, entry.to, entry.decoration)
  return builder.finish()
}

/** Common live preview for block Markdown that ink-mde does not render itself. */
export function createLiveMarkdownBlockPreview(
  resolveImageSrc?: ResolveLiveMarkdownImageSrc,
  savePastedImage?: SaveLiveMarkdownPastedImage,
): Extension {
  return [
  liveMarkdownShikiHighlight,
  StateField.define<PreviewState>({
    create: (state) => {
      const lines = activeLines(state)
      const blocks = buildBlocks(state, resolveImageSrc)
      return {
        activeLines: lines,
        blocks,
        editingTableFrom: null,
        decorations: buildDecorations(state, blocks, lines, null, resolveImageSrc),
      }
    },
    update: (value, transaction) => {
      const lines = activeLines(transaction.state)
      const enterSourceEdit = transaction.effects.find((effect) => effect.is(enterTableSourceEditEffect))
      let editingTableFrom = enterSourceEdit ? enterSourceEdit.value : value.editingTableFrom
      const blocks = transaction.docChanged ? buildBlocks(transaction.state, resolveImageSrc) : value.blocks
      if (editingTableFrom !== null) {
        const table = blocks.find((block) => block.kind === 'table' && block.from === editingTableFrom)
        const selectionRemainsInTable = table && transaction.state.selection.ranges.every((range) => range.from >= table.from && range.to <= table.to)
        if (!selectionRemainsInTable) editingTableFrom = null
      }
      if (!transaction.docChanged && sameLines(lines, value.activeLines) && editingTableFrom === value.editingTableFrom) return value
      return {
        activeLines: lines,
        blocks,
        editingTableFrom,
        decorations: buildDecorations(transaction.state, blocks, lines, editingTableFrom, resolveImageSrc),
      }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  }),
  EditorView.domEventHandlers({
    paste: (event, view) => {
      const image = Array.from(event.clipboardData?.files ?? []).find((file) => /^image\/(?:png|jpeg|gif|webp)$/i.test(file.type))
      if (!image || !savePastedImage || view.state.readOnly) return false
      event.preventDefault()
      void savePastedImage(image).then((src) => {
        if (!src) return
        const position = view.state.selection.main.from
        const alt = image.name.replace(/[\\[\]]/g, '\\$&') || '粘贴的图片'
        const markdown = `![${alt}](<${src}>)`
        view.dispatch({ changes: { from: position, insert: markdown }, selection: { anchor: position + markdown.length } })
      }).catch(() => {})
      return true
    },
    mousedown: (event, view) => {
      const target = event.target as HTMLElement | null
      const block = target?.closest<HTMLElement>('[data-live-markdown-block-from]')
      const inlineMath = target?.closest<HTMLElement>('[data-live-markdown-inline-from]')
      if (!block && !inlineMath) return false
      // CodeBlock 的复制按钮必须在外层选区切换之前收到完整 click 序列。
      // 否则 mousedown 会把预览切回源码并卸载按钮，导致 click 永远无法触发。
      // `.cm-content` 本身就是 contenteditable；把它纳入排除条件会让所有
      // widget 点击都被提前吞掉。只给真正需要原生 click 序列的交互控件让路。
      if (target?.closest('button, a, input, select, textarea, [role="button"]')) return true
      const from = Number(block?.dataset.liveMarkdownBlockFrom ?? inlineMath?.dataset.liveMarkdownInlineFrom)
      if (!Number.isSafeInteger(from)) return false
      // Replacement widget 没有可供 CodeMirror 命中的文本位置；默认命中会跳到邻行。
      // 直接选中其源码起点，下一次 decorations 更新便会展示该行的公式标记。
      event.preventDefault()
      view.dispatch({
        selection: { anchor: from },
        effects: block?.dataset.liveMarkdownBlockKind === 'table' ? enterTableSourceEditEffect.of(from) : undefined,
      })
      view.focus()
      return true
    },
  }),
  ]
}

/** Default extension for consumers that do not need local-media resolution. */
export const liveMarkdownBlockPreview = createLiveMarkdownBlockPreview()
