/**
 * 旧版 Word（.doc，97-2003 二进制）内联预览：word-extractor 抽出的文字 → 可嵌入的 HTML。
 *
 * word-extractor 把表格一行输出成「单元格\t单元格\t」（行尾带一个制表符），据此把连续的表格行还原成表格；
 * 其余非空行作为段落。只有文字与表格，不还原图片与排版——预览顶部会说明这一点。
 * 输出由调用方再经 DOMPurify 净化后嵌入；这里先把全部文字做 HTML 转义。
 */

export interface LegacyDocParts {
  body: string
  headers?: string
  footnotes?: string
  endnotes?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isTableRow(line: string): boolean {
  return line.includes('\t') && line.endsWith('\t')
}

function renderBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let tableRows: string[][] = []
  const flushTable = (): void => {
    if (tableRows.length === 0) return
    const width = Math.max(...tableRows.map((row) => row.length))
    const rows = tableRows.map((row) => `<tr>${Array.from({ length: width }, (_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`)
    html.push(`<div class="office-table-wrap"><table><tbody>${rows.join('')}</tbody></table></div>`)
    tableRows = []
  }
  for (const line of lines) {
    if (isTableRow(line)) {
      tableRows.push(line.slice(0, -1).split('\t').map((cell) => cell.trim()))
      continue
    }
    flushTable()
    const paragraph = line.trim()
    if (paragraph) html.push(`<p>${escapeHtml(paragraph)}</p>`)
  }
  flushTable()
  return html.join('')
}

export function renderLegacyDocHtml(parts: LegacyDocParts): string {
  const sections: string[] = []
  const body = renderBlocks(parts.body)
  sections.push(body || '<div class="office-empty">没有可提取的文字内容</div>')
  const extras: Array<[string, string | undefined]> = [['页眉与页脚', parts.headers], ['脚注', parts.footnotes], ['尾注', parts.endnotes]]
  for (const [title, text] of extras) {
    const rendered = text?.trim() ? renderBlocks(text) : ''
    if (rendered) sections.push(`<h4>${title}</h4>${rendered}`)
  }
  return `<div class="office-preview office-preview-document"><div class="office-preview-notice">旧版 Word 文档（.doc）：仅显示文字与表格，不含图片和排版。</div><article class="office-legacy-doc">${sections.join('')}</article></div>`
}

/** 全文纯文本（供「复制」使用） */
export function legacyDocPlainText(parts: LegacyDocParts): string {
  return [parts.body, parts.headers, parts.footnotes, parts.endnotes]
    .map((text) => text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
}
