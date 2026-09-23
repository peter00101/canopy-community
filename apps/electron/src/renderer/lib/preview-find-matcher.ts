/**
 * 预览「文件内查找」的匹配规则（区分大小写 / 全词 / 正则）。
 *
 * DOM 高亮（PreviewFindBar）、PDF 文字层与大表格后台线程共用这一份语义，
 * 避免同一个关键词在不同格式里搜出不同结果。PDF 查看器跑在隔离的 iframe 里，
 * 由主进程注入一份同语义实现（pdf-preview-viewer.ts），有测试钉住两边一致。
 */

export interface PreviewFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export function escapePreviewFindRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 返回全局匹配用的正则；关键词为空或正则非法时返回 null */
export function buildPreviewFindMatcher(query: string, options: PreviewFindOptions): RegExp | null {
  if (!query) return null
  try {
    const source = options.regex ? query : escapePreviewFindRegExp(query)
    const wrappedSource = options.wholeWord ? `\\b(?:${source})\\b` : source
    return new RegExp(wrappedSource, `g${options.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

/** 在一段文字里找出全部命中（跳过零宽匹配），最多 limit 个 */
export function findPreviewMatches(text: string, matcher: RegExp, limit = Number.POSITIVE_INFINITY): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = []
  matcher.lastIndex = 0
  let match = matcher.exec(text)
  while (match && matches.length < limit) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1
    } else {
      matches.push({ start: match.index, end: match.index + match[0].length })
    }
    match = matcher.exec(text)
  }
  return matches
}
