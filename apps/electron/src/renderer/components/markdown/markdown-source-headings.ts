import { getDisplayMathClosingDelimiter } from './live-markdown-preview-syntax'

/**
 * 从完整 Markdown 源码提取标题，作为 TOC 的稳定数据源。
 *
 * LiveMarkdown 预览基于 CodeMirror 视口虚拟化，DOM 里只有可见区附近的标题，
 * 从渲染结果提取（useTocHeadings 的做法）在长文档上必然不全、且随滚动整窗置换。
 * 这里改为纯文本单遍扫描：行号（1-based）与 CodeMirror 文档行号一一对应，
 * 跳转与滚动联动都用行号经 EditorView 完成，与视口内渲染了什么无关。
 */
export interface MarkdownSourceHeading {
  level: number
  text: string
  /** 1-based 源码行号；Setext 标题指向正文行而非下划线行 */
  line: number
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/
const ATX_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/

/** 标题展示文本：剥掉常见行内标记与零宽字符，保留纯文字。 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/[​‌‍﻿]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/([*_])([^*_\s][^*_]*?)\1/g, '$2')
    .trim()
}

export function extractMarkdownSourceHeadings(source: string): MarkdownSourceHeading[] {
  const lines = source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const headings: MarkdownSourceHeading[] = []
  let index = 0

  // YAML frontmatter：仅文档首行的 --- 开界，到下一个 --- / ... 收界
  if (lines[0]?.trim() === '---') {
    let close = 1
    while (close < lines.length && !/^(---|\.\.\.)[ \t]*$/.test(lines[close]!.trim())) close += 1
    if (close < lines.length) index = close + 1
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = line.match(FENCE_PATTERN)
    if (fence) {
      const marker = fence[1]![0]!
      const length = fence[1]!.length
      const closePattern = new RegExp(`^ {0,3}\\${marker}{${length},}[ \t]*$`)
      let close = index + 1
      while (close < lines.length && !closePattern.test(lines[close]!)) close += 1
      index = close // 未闭合时越过文末，循环自然结束（与渲染层「吞到 EOF」一致）
      continue
    }

    const mathClose = getDisplayMathClosingDelimiter(line)
    if (mathClose) {
      let close = index + 1
      while (close < lines.length && lines[close]!.trim() !== mathClose) close += 1
      if (close < lines.length) {
        index = close
        continue
      }
      // 未闭合的 $$ / \[ 当普通文本继续扫，与 LiveMarkdown 块渲染行为一致
    }

    const atx = line.match(ATX_PATTERN)
    if (atx) {
      const text = stripInlineMarkdown((atx[2] ?? '').replace(/(^|[ \t])#+[ \t]*$/, '$1'))
      if (text) headings.push({ level: atx[1]!.length, text, line: index + 1 })
      continue
    }

    const setext = line.match(SETEXT_PATTERN)
    if (setext && index > 0) {
      const previous = lines[index - 1]!
      // Setext 只作用于段落文字：上一行为空（此时 --- 是分隔线）、列表项、
      // 各类结构行时都不成立
      const previousIsStructural =
        !previous.trim() ||
        ATX_PATTERN.test(previous) ||
        FENCE_PATTERN.test(previous) ||
        SETEXT_PATTERN.test(previous) ||
        LIST_ITEM_PATTERN.test(previous) ||
        Boolean(getDisplayMathClosingDelimiter(previous))
      if (!previousIsStructural) {
        const text = stripInlineMarkdown(previous)
        if (text) headings.push({ level: setext[1]![0] === '=' ? 1 : 2, text, line: index })
      }
    }
  }
  return headings
}
