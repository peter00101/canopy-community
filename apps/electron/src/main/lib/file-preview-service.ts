/**
 * 文件预览服务 — 内联预览支持
 *
 * 提供文件路径解析、PDF 预览 HTML 生成、DOCX 转 HTML 等功能，
 * 供 PreviewPanel 内联面板使用。
 */

import { basename, join, dirname, extname, resolve, relative, sep, isAbsolute as isAbsolutePath, posix as pathPosix } from 'node:path'
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { DOMParser } from '@xmldom/xmldom'
import type { FilePreviewReadResult, OfficePreviewResult } from '@canopy/shared'
import { getBundledOfficeCliPath, isBundledOfficeCliTrusted, runBundledOfficeCli } from './officecli-manager'
import { buildPdfPreviewHtml } from './pdf-preview-viewer'
import { legacyDocPlainText, renderLegacyDocHtml } from './legacy-doc-preview'
import { probeXlsxLayout, type XlsxLayout } from './xlsx-layout-probe'

const require = createRequire(__filename)
const PDFJS_PACKAGE = 'pdfjs-dist'

/** 文件大小限制：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024
/** 文本预览上限：高亮器会把内容转为大量 DOM，不能沿用文档转换的 50MB 上限。 */
const MAX_TEXT_PREVIEW_SIZE = 5 * 1024 * 1024
const MAX_XLSX_SHEETS = 8
const MAX_XLSX_ROWS = 200
const MAX_XLSX_COLUMNS = 40
const MAX_PPTX_SLIDES = 80
/**
 * 回退解析链路（xlsx / pptx / mammoth）的体积门槛。
 *
 * 主路径 OfficeCLI 是独立进程且有 15s 超时，主进程不受影响；但它失败后的回退全部
 * **在主进程内解析**，且没有任何超时保护——主进程一阻塞，所有窗口一起冻结。
 * 上面那几个 MAX_XLSX_* 限的是输出 HTML 的量，解析仍要吃完整个文件。
 * 本机实测 `xlsx.read`：4.3MB → 246ms、**44.8MB → 2615ms**、184MB → 10.9s。
 * 取 15MB（约 800ms）作为可接受的冻结上限；超过则不再回退，交由渲染层的
 * UnsupportedFilePreview 给出说明与「用默认应用打开」。
 */
const MAX_FALLBACK_PARSE_SIZE = 15 * 1024 * 1024
const OFFICECLI_RENDER_TIMEOUT_MS = 15_000
const OFFICECLI_TEXT_RENDER_TIMEOUT_MS = 5_000
const OFFICECLI_MAX_HTML_SIZE = 20 * 1024 * 1024
/** OfficeCLI v1.0.147 每个工作表最多渲染的行数（实测输出「Showing 5000 of 50001 rows」）；超过就改走虚拟滚动表格 */
const OFFICECLI_XLSX_MAX_ROWS = 5000
/** OfficeCLI 截断时在页面里插入的提示元素 */
const OFFICECLI_TRUNCATION_MARKER = /class="truncation-warning"/
const PREVIEW_TEMP_FILE_TTL_MS = 60 * 60 * 1000
const execFileAsync = promisify(execFile)

// ─── 临时文件 ───

function getPreviewTmpDir(): string {
  const dir = join(tmpdir(), 'canopy-preview')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function writeTempHtml(html: string): string {
  const tmpDir = getPreviewTmpDir()
  const contentHash = createHash('md5').update(html).digest('hex').slice(0, 16)
  const tmpFile = join(tmpDir, `preview-${contentHash}.html`)
  if (!existsSync(tmpFile)) {
    writeFileSync(tmpFile, html, 'utf-8')
  }
  return tmpFile
}

function createOfficeCliOutputPath(sourcePath: string): string {
  const fileHash = createHash('sha256')
    .update(`${sourcePath}\0${Date.now()}\0${Math.random()}`)
    .digest('hex')
    .slice(0, 24)
  return join(getPreviewTmpDir(), `officecli-${fileHash}.html`)
}

function removeTempFileLater(path: string): void {
  const cleanup = setTimeout(() => {
    try { unlinkSync(path) } catch { /* 已由启动清理或其他路径删除 */ }
  }, PREVIEW_TEMP_FILE_TTL_MS)
  cleanup.unref()
}

/** 清理所有临时预览文件 */
export function cleanPreviewTmpDir(): number {
  const dir = join(tmpdir(), 'canopy-preview')
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    for (const f of readdirSync(dir)) {
      try { unlinkSync(join(dir, f)); count++ } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count
}

// ─── 路径解析 ───

/**
 * 解析待预览的文件路径。
 *
 * 仅按确定的候选根拼接，不扫描 home、根目录或同名文件。模型输出相对路径时，
 * 「猜中一个同名文件」比明确提示找不到更危险；最终授权边界由 IPC 层 realpath 校验
 * （见 preview-access-policy.ts）。上游 #2020 起不再有 searchFileInDir / homedir / '/' 兜底。
 */
export function isAbsolutePreviewPath(filePath: string): boolean {
  return filePath.startsWith('/') || filePath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filePath)
}

function isWithinBasePath(candidate: string, basePath: string): boolean {
  const relativePath = relative(resolve(basePath), candidate)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolutePath(relativePath)
  )
}

function addCandidateWithinBase(candidates: string[], basePath: string, candidate: string): void {
  if (!isWithinBasePath(candidate, basePath) || candidates.includes(candidate)) return
  candidates.push(candidate)
}

function getRelativePathAfterBasePrefix(filePath: string, basePath: string): string[] | null {
  const inputParts = filePath.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.')
  const baseParts = resolve(basePath).replace(/\\/g, '/').split('/').filter(Boolean)
  if (inputParts.length === 0 || baseParts.length === 0) return null

  // 输入可能省略了绝对路径前缀，但完整保留了候选根的末段，例如
  // agent-workspaces/<workspace>/workspace-files/plan/report.md。仅当它严格包含
  // 某个候选根的连续后缀时才恢复；不会探测祖先目录或按文件名搜索。
  for (let start = 0; start < baseParts.length; start++) {
    const baseSuffix = baseParts.slice(start)
    if (inputParts.length <= baseSuffix.length) continue
    if (baseSuffix.every((part, index) => part === inputParts[index])) {
      return inputParts.slice(baseSuffix.length)
    }
  }
  return null
}

function candidatePathsForRelativeFile(filePath: string, basePaths: readonly string[]): string[] {
  const candidates: string[] = []
  for (const basePath of basePaths) {
    if (!basePath) continue
    addCandidateWithinBase(candidates, basePath, resolve(basePath, filePath))

    const relativeSuffix = getRelativePathAfterBasePrefix(filePath, basePath)
    if (relativeSuffix) {
      addCandidateWithinBase(candidates, basePath, resolve(basePath, ...relativeSuffix))
    }
  }
  return candidates
}

export function resolveTargetPath(filePath: string, basePaths?: string[]): string {
  if (filePath.includes('\0')) return ''
  if (isAbsolutePreviewPath(filePath)) return resolve(filePath)

  const bases = basePaths?.filter(Boolean) ?? []
  const candidates = candidatePathsForRelativeFile(filePath, bases)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? ''
}

// ─── Office Open XML 预览 ───

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml')
}

function getElementsByLocalName(root: Node, localName: string): Element[] {
  const result: Element[] = []

  function walk(node: Node): void {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children.item(i)
      if (child.nodeType === 1) {
        const element = child as Element
        if (element.localName === localName || element.nodeName === localName) {
          result.push(element)
        }
      }
      walk(child)
    }
  }

  walk(root)
  return result
}

function getDirectChildElementsByLocalName(root: Element | Document, localName: string): Element[] {
  const result: Element[] = []
  const children = root.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (child.nodeType !== 1) continue
    const element = child as Element
    if (element.localName === localName || element.nodeName === localName) {
      result.push(element)
    }
  }
  return result
}

function getFirstTextByLocalName(root: Element, localName: string): string {
  return getElementsByLocalName(root, localName)[0]?.textContent ?? ''
}

function readZipText(zip: AdmZip, path: string): string | null {
  const entry = zip.getEntry(path)
  return entry ? entry.getData().toString('utf-8') : null
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, '/')
  if (normalizedTarget.startsWith('/')) return normalizedTarget.slice(1)
  return pathPosix.normalize(pathPosix.join(baseDir, normalizedTarget))
}

function parseRelationships(zip: AdmZip, relsPath: string, baseDir: string): Map<string, string> {
  const relsXml = readZipText(zip, relsPath)
  const rels = new Map<string, string>()
  if (!relsXml) return rels

  const relsDoc = parseXml(relsXml)
  for (const rel of getElementsByLocalName(relsDoc, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (!id || !target) continue
    rels.set(id, normalizeZipTarget(baseDir, target))
  }
  return rels
}

function parseSharedStrings(zip: AdmZip): string[] {
  const sharedXml = readZipText(zip, 'xl/sharedStrings.xml')
  if (!sharedXml) return []

  const doc = parseXml(sharedXml)
  return getElementsByLocalName(doc, 'si').map((si) => (
    getElementsByLocalName(si, 't').map((node) => node.textContent ?? '').join('')
  ))
}

function isDateNumFmtId(numFmtId: number): boolean {
  return (
    (numFmtId >= 14 && numFmtId <= 22) ||
    (numFmtId >= 27 && numFmtId <= 36) ||
    (numFmtId >= 45 && numFmtId <= 47) ||
    (numFmtId >= 50 && numFmtId <= 58)
  )
}

function isDateFormatCode(formatCode: string): boolean {
  const normalized = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*]/g, '')
    .toLowerCase()
  return /[ymdhHsS]/.test(normalized)
}

function parseXlsxDateStyleIndexes(zip: AdmZip): Set<number> {
  const stylesXml = readZipText(zip, 'xl/styles.xml')
  const dateStyleIndexes = new Set<number>()
  if (!stylesXml) return dateStyleIndexes

  const doc = parseXml(stylesXml)
  const customFormats = new Map<number, string>()
  for (const numFmt of getElementsByLocalName(doc, 'numFmt')) {
    const id = Number(numFmt.getAttribute('numFmtId'))
    const code = numFmt.getAttribute('formatCode') ?? ''
    if (Number.isFinite(id) && code) customFormats.set(id, code)
  }

  const cellXfs = getElementsByLocalName(doc, 'cellXfs')[0]
  if (!cellXfs) return dateStyleIndexes

  getDirectChildElementsByLocalName(cellXfs, 'xf').forEach((xf, index) => {
    const numFmtId = Number(xf.getAttribute('numFmtId'))
    if (!Number.isFinite(numFmtId)) return
    const customFormatCode = customFormats.get(numFmtId)
    if (isDateNumFmtId(numFmtId) || (customFormatCode && isDateFormatCode(customFormatCode))) {
      dateStyleIndexes.add(index)
    }
  })

  return dateStyleIndexes
}

function formatExcelSerialDate(rawValue: string): string {
  const serial = Number(rawValue)
  if (!Number.isFinite(serial)) return rawValue

  const millis = Math.round((serial - 25569) * 86400 * 1000)
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return rawValue

  const year = date.getUTCFullYear()
  if (year < 1900 || year > 9999) return rawValue

  const pad = (value: number) => String(value).padStart(2, '0')
  const dateText = `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const hasTime = Math.abs(serial - Math.floor(serial)) > 0.000001
  if (!hasTime) return dateText
  return `${dateText} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function columnIndexFromCellRef(cellRef: string): number {
  const letters = cellRef.match(/[A-Za-z]+/)?.[0]?.toUpperCase()
  if (!letters) return 0
  let index = 0
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return Math.max(0, index - 1)
}

function columnNameFromIndex(index: number): string {
  let value = index + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function getXlsxCellText(cell: Element, sharedStrings: string[], dateStyleIndexes: Set<number>): string {
  const type = cell.getAttribute('t')
  if (type === 'inlineStr') {
    return getElementsByLocalName(cell, 't').map((node) => node.textContent ?? '').join('')
  }

  const value = getFirstTextByLocalName(cell, 'v')
  if (!value) return ''

  if (type === 's') {
    const sharedIndex = Number(value)
    return Number.isInteger(sharedIndex) ? sharedStrings[sharedIndex] ?? '' : ''
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'

  const styleIndex = Number(cell.getAttribute('s'))
  if (!type && Number.isInteger(styleIndex) && dateStyleIndexes.has(styleIndex)) {
    return formatExcelSerialDate(value)
  }

  return value
}

function parseXlsxSheetRows(
  zip: AdmZip,
  sheetPath: string,
  sharedStrings: string[],
  dateStyleIndexes: Set<number>,
): { rows: string[][]; truncatedRows: boolean; truncatedColumns: boolean } {
  const sheetXml = readZipText(zip, sheetPath)
  if (!sheetXml) return { rows: [], truncatedRows: false, truncatedColumns: false }

  const doc = parseXml(sheetXml)
  const rows: string[][] = []
  let truncatedRows = false
  let truncatedColumns = false

  for (const row of getElementsByLocalName(doc, 'row')) {
    if (rows.length >= MAX_XLSX_ROWS) {
      truncatedRows = true
      break
    }

    const values: string[] = []
    for (const cell of getDirectChildElementsByLocalName(row, 'c')) {
      const cellRef = cell.getAttribute('r') ?? ''
      const colIndex = columnIndexFromCellRef(cellRef)
      if (colIndex >= MAX_XLSX_COLUMNS) {
        truncatedColumns = true
        continue
      }
      values[colIndex] = getXlsxCellText(cell, sharedStrings, dateStyleIndexes)
    }

    while (values.length > 0 && !values[values.length - 1]) values.pop()
    if (values.some((value) => value.trim().length > 0)) rows.push(values)
  }

  return { rows, truncatedRows, truncatedColumns }
}

function renderXlsxTable(rows: string[][]): string {
  if (rows.length === 0) {
    return '<div class="office-empty">这个工作表没有可预览的数据</div>'
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1)
  const headerCells = Array.from({ length: columnCount }, (_, index) => (
    `<th>${escapeHtml(columnNameFromIndex(index))}</th>`
  )).join('')
  const bodyRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, index) => (
      `<td>${escapeHtml(row[index] ?? '')}</td>`
    )).join('')
    return `<tr><th class="office-row-heading">${rowIndex + 1}</th>${cells}</tr>`
  }).join('')

  return `<div class="office-table-wrap"><table><thead><tr><th></th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
}

function convertXlsxToHtml(filePath: string, resolvedPath: string): OfficePreviewResult {
  const zip = new AdmZip(resolvedPath)
  const workbookXml = readZipText(zip, 'xl/workbook.xml')
  if (!workbookXml) throw new Error('Invalid XLSX: workbook.xml missing')

  const workbookDoc = parseXml(workbookXml)
  const relationships = parseRelationships(zip, 'xl/_rels/workbook.xml.rels', 'xl')
  const sharedStrings = parseSharedStrings(zip)
  const dateStyleIndexes = parseXlsxDateStyleIndexes(zip)
  const sheets = getElementsByLocalName(workbookDoc, 'sheet')

  let truncatedSheets = false
  let truncatedRows = false
  let truncatedColumns = false
  const textParts: string[] = []
  const htmlParts: string[] = []

  sheets.slice(0, MAX_XLSX_SHEETS).forEach((sheet, sheetIndex) => {
    const name = sheet.getAttribute('name') || `Sheet ${sheetIndex + 1}`
    const relationshipId = sheet.getAttribute('r:id') ?? sheet.getAttribute('id')
    const sheetPath = relationshipId ? relationships.get(relationshipId) : undefined
    if (!sheetPath) return

    const parsed = parseXlsxSheetRows(zip, sheetPath, sharedStrings, dateStyleIndexes)
    truncatedRows ||= parsed.truncatedRows
    truncatedColumns ||= parsed.truncatedColumns
    textParts.push(`[${name}]`)
    textParts.push(...parsed.rows.map((row) => row.join('\t')))
    htmlParts.push(`<section class="office-sheet"><h3>${escapeHtml(name)}</h3>${renderXlsxTable(parsed.rows)}</section>`)
  })

  if (htmlParts.length === 0) {
    throw new Error('Invalid XLSX: no worksheet data resolved')
  }

  truncatedSheets = sheets.length > MAX_XLSX_SHEETS
  const notices = [
    truncatedSheets ? `仅显示前 ${MAX_XLSX_SHEETS} 个工作表` : null,
    truncatedRows ? `每个工作表最多显示 ${MAX_XLSX_ROWS} 行` : null,
    truncatedColumns ? `每行最多显示 ${MAX_XLSX_COLUMNS} 列` : null,
  ].filter(Boolean)
  const noticeHtml = notices.length > 0
    ? `<div class="office-preview-notice">${escapeHtml(notices.join('，'))}</div>`
    : ''
  // 文件名不在这里重复：标签栏与预览工具行各显示一次已经够了（与 OfficeCLI 主路径的处置一致）。
  const html = `<div class="office-preview office-preview-spreadsheet">${noticeHtml}${htmlParts.join('')}</div>`

  return {
    resolvedPath,
    kind: 'spreadsheet',
    html,
    text: textParts.join('\n').trim(),
  }
}

function getPptxSlidePaths(zip: AdmZip): string[] {
  const presentationXml = readZipText(zip, 'ppt/presentation.xml')
  const relationships = parseRelationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt')
  if (presentationXml) {
    const doc = parseXml(presentationXml)
    const slidePaths = getElementsByLocalName(doc, 'sldId')
      .map((slide) => slide.getAttribute('r:id') ?? slide.getAttribute('id'))
      .map((relationshipId) => relationshipId ? relationships.get(relationshipId) : undefined)
      .filter((path): path is string => Boolean(path))
    if (slidePaths.length > 0) return slidePaths
  }

  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/.test(entryName))
    .sort((a, b) => {
      const aIndex = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      const bIndex = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
      return aIndex - bIndex
    })
}

function getPptxSlideText(zip: AdmZip, slidePath: string): string[] {
  const slideXml = readZipText(zip, slidePath)
  if (!slideXml) return []

  const doc = parseXml(slideXml)
  return getElementsByLocalName(doc, 'p')
    .map((paragraph) => getElementsByLocalName(paragraph, 't').map((textNode) => textNode.textContent ?? '').join('').trim())
    .filter(Boolean)
}

function convertPptxToHtml(filePath: string, resolvedPath: string): OfficePreviewResult {
  const zip = new AdmZip(resolvedPath)
  const slidePaths = getPptxSlidePaths(zip)
  const visibleSlidePaths = slidePaths.slice(0, MAX_PPTX_SLIDES)
  const textParts: string[] = []
  const slideHtml = visibleSlidePaths.map((slidePath, index) => {
    const lines = getPptxSlideText(zip, slidePath)
    textParts.push(`幻灯片 ${index + 1}`)
    textParts.push(...lines)
    const title = lines[0] || '（无标题）'
    const body = lines.length > 1
      ? `<ul>${lines.slice(1).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      : '<div class="office-empty">这页没有更多可提取文本</div>'
    return `<section class="office-slide"><div class="office-slide-index">幻灯片 ${index + 1}</div><h3>${escapeHtml(title)}</h3>${body}</section>`
  }).join('')

  const noticeHtml = slidePaths.length > MAX_PPTX_SLIDES
    ? `<div class="office-preview-notice">仅显示前 ${MAX_PPTX_SLIDES} 页幻灯片</div>`
    : ''
  const emptyHtml = slideHtml || '<div class="office-empty">这个 PPTX 没有可提取的文本内容</div>'
  const html = `<div class="office-preview office-preview-presentation">${noticeHtml}${emptyHtml}</div>`

  return {
    resolvedPath,
    kind: 'presentation',
    html,
    text: textParts.join('\n').trim(),
  }
}

// ─── 导出：内联预览 API ───

/**
 * 读取并验证文件内容是否适合内联文本预览，返回已完成严格校验的文本。
 *
 * 不能只依赖扩展名：Agent 可能引用任意路径，且扩展名可缺失或伪装。
 * 预览文本交给 @pierre/diffs 前，先在主进程验证整个文件都是安全文本；
 * 否则诸如 DMG 的二进制内容会被当作 UTF-8 传入高亮器，可能造成渲染进程崩溃。
 */
function readSafeText(content: Buffer): string | null {
  if (content.includes(0)) return null

  // 只有严格合法的 UTF-8 才能进入基于文本的高亮器。readFile(..., 'utf-8')
  // 会把非法字节替换成 U+FFFD，掩盖二进制内容并把风险留给渲染进程。
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }

  // 纯 7-bit 二进制可能没有 NUL 且也能通过 UTF-8 校验。正常文本只会使用
  // tab、换行和回车等控制字符；标准 ANSI CSI 转义（ESC [）也允许出现在日志中。
  let unsafeControlCount = 0
  for (let index = 0; index < content.length; index++) {
    const byte = content[index]!
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      if (byte === 0x1b && content[index + 1] === 0x5b) continue
      unsafeControlCount += 1
    }
  }
  if (unsafeControlCount > Math.max(4, Math.floor(content.length * 0.01))) return null
  return text
}

/** 解析文件路径并读取内容（供内联文本/代码预览使用） */
export function resolveAndReadFile(filePath: string, basePaths?: string[]): FilePreviewReadResult | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    const metadata = {
      name: basename(safePath),
      extension: extname(safePath).toLowerCase(),
      size: st.size,
      modifiedAt: st.mtimeMs,
    }
    if (st.size > MAX_TEXT_PREVIEW_SIZE) {
      return { resolvedPath: safePath, content: '', isBinary: false, isTooLarge: true, metadata }
    }
    const rawContent = readFileSync(safePath)
    const content = readSafeText(rawContent)
    if (content === null) {
      return { resolvedPath: safePath, content: '', isBinary: true, isTooLarge: false, metadata }
    }
    return { resolvedPath: safePath, content, isBinary: false, isTooLarge: false, metadata }
  } catch {
    return null
  }
}

/** 仅解析文件路径（不读取内容），供图片等用 canopy-file:// 协议加载的场景使用 */
export function resolveFilePath(filePath: string, basePaths?: string[]): string | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  return existsSync(safePath) ? safePath : null
}

/**
 * 为内联 HTML 预览生成受限 URL（供 iframe sandbox 加载）。
 * 注册 HTML 所在目录而非单文件，使相对路径的 CSS/JS/图片可随文档加载；
 * 目录逃逸由 canopy-file:// 协议 handler 统一拦截。
 *
 * `directoryScope: false`（IPC 层判定 HTML 父目录不在显式授权根内、仅单文件授权时传入）：
 * 只注册 HTML 本体，同目录资源按授权边界拒绝，不能因预览把整个父目录注册成 URL 根。
 */
export async function prepareHtmlPreview(
  filePath: string,
  basePaths?: string[],
  options?: { directoryScope?: boolean },
): Promise<{ resolvedPath: string; url: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    if (!st.isFile() || st.size > MAX_FILE_SIZE) return null
    const { registerAppDirectoryPath, registerAppFilePath } = await import('./local-file-protocol')
    if (options?.directoryScope === false) {
      return { resolvedPath: safePath, url: registerAppFilePath(safePath) }
    }
    const dirUrl = registerAppDirectoryPath(dirname(safePath))
    return { resolvedPath: safePath, url: `${dirUrl}/${encodeURIComponent(basename(safePath))}` }
  } catch (err) {
    console.error('[file-preview] prepareHtmlPreview failed:', err)
    return null
  }
}

/** 为内联 PDF 预览生成临时 HTML 文件（使用 canopy-file:// 加载 PDF，无体积膨胀） */
export async function preparePdfPreview(filePath: string, basePaths?: string[]): Promise<{ resolvedPath: string; tmpHtmlUrl: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  const st = statSync(safePath)
  if (st.size > MAX_FILE_SIZE) return null

  let registerFilePath: (path: string) => string
  let html: string
  try {
    const { registerAppDirectoryPath, registerAppFilePath } = await import('./local-file-protocol')
    registerFilePath = registerAppFilePath
    const pdfPackageDir = dirname(require.resolve(`${PDFJS_PACKAGE}/package.json`))
    // 查看器（懒渲染 / 文字层 / 查找）见 pdf-preview-viewer.ts；cMapUrl 让未嵌入 CMap 的中文 PDF 也能出字
    html = buildPdfPreviewHtml({
      fileUrl: registerAppFilePath(safePath),
      pdfScriptUrl: registerAppFilePath(require.resolve(`${PDFJS_PACKAGE}/build/pdf.min.mjs`)),
      pdfWorkerUrl: registerAppFilePath(require.resolve(`${PDFJS_PACKAGE}/build/pdf.worker.min.mjs`)),
      standardFontDataUrl: `${registerAppDirectoryPath(join(pdfPackageDir, 'standard_fonts'))}/`,
      cMapUrl: `${registerAppDirectoryPath(join(pdfPackageDir, 'cmaps'))}/`,
    })
  } catch (err) {
    console.error('[file-preview] preparePdfPreview asset resolution failed:', err)
    return null
  }

  const tmpHtmlPath = writeTempHtml(html)
  const tmpHtmlUrl = registerFilePath(tmpHtmlPath)
  return { resolvedPath: safePath, tmpHtmlUrl }
}

/** 将 DOCX 文件转换为 HTML（供内联预览使用） */
function renderOfficeTextFallback(filePath: string, text: string, kind: OfficePreviewResult['kind']): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  const body = paragraphs.length > 0
    ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('')
    : '<div class="office-empty">没有可提取的文本内容</div>'
  return `<div class="office-preview office-preview-${kind}">${body}</div>`
}

function getOfficeCliCandidates(): string[] {
  return [getBundledOfficeCliPath()]
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    if (process.platform === 'win32') return true
    return (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * OfficeCLI 自己在 body 顶部画一条「文件名标题条」（xlsx 是 Excel 绿色 div.file-title，
 * pptx 是 h1.file-title；docx 没有）。在 Canopy 里它是这个文件名的**第三次**出现——
 * 标签栏一次、预览工具行一次、再来这一条，用户反馈「一个文件三个菜单栏」。
 * 它不承载任何控件（工作表页签是独立的 .sheet-tabs，在底部），OfficeCLI 自己的
 * 打印样式也把它 display:none，所以这里按同一判断隐藏掉。
 *
 * 用注入 CSS 而不是改 HTML 结构：iframe 是 sandbox 无 allow-same-origin，渲染层碰不到
 * 它的 DOM；且选择器万一随 OfficeCLI 升级失效，后果只是标题条重新出现，不会报错。
 */
const OFFICE_CLI_CHROME_STYLE = '<style>.file-title{display:none !important}</style>'

export function restrictOfficeCliHtml(html: string): string {
  const contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; media-src data: blob:"
  const policyTag = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`
  // 样式插在 </head> 之前，排在 OfficeCLI 自己的 <style> 之后，无需靠 !important 之外的优先级。
  if (/<\/head>/i.test(html)) {
    return html
      .replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policyTag}`)
      .replace(/<\/head>/i, `${OFFICE_CLI_CHROME_STYLE}</head>`)
  }
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policyTag}${OFFICE_CLI_CHROME_STYLE}`)
  }
  return html.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head>${policyTag}${OFFICE_CLI_CHROME_STYLE}</head>`)
}

async function registerOfficeCliOutputFile(path: string): Promise<string> {
  const { registerAppFilePath } = await import('./local-file-protocol')
  return registerAppFilePath(path)
}

export async function renderOfficeWithOfficeCli(
  resolvedPath: string,
  registerFilePath: (path: string) => string | Promise<string> = registerOfficeCliOutputFile,
  officeCliCandidates = getOfficeCliCandidates(),
  expectedExtensions: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.pptx']),
): Promise<{ htmlUrl: string; text: string; truncated: boolean } | null> {
  if (!expectedExtensions.has(extname(resolvedPath).toLowerCase())) return null

  const outputPath = createOfficeCliOutputPath(resolvedPath)
  let lastError: unknown
  for (const candidate of officeCliCandidates) {
    if (!isExecutableFile(candidate)) continue
    // 完整性自检：二进制被自更新或外部换掉时不使用它，回退内置 OOXML 解析器。
    // 进程内只算一次哈希，且先比字节数，正常路径几乎零开销。
    if (!await isBundledOfficeCliTrusted(candidate)) continue
    try {
      await runBundledOfficeCli(candidate, ['view', resolvedPath, 'html', '-o', outputPath], {
        timeoutMs: OFFICECLI_RENDER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
      const outputStat = statSync(outputPath)
      if (outputStat.size <= 0 || outputStat.size > OFFICECLI_MAX_HTML_SIZE) {
        throw new Error(`OfficeCLI HTML 输出大小异常: ${outputStat.size}`)
      }
      const html = restrictOfficeCliHtml(readFileSync(outputPath, 'utf-8'))
      if (!html.includes('<html') || !html.includes('</html>')) throw new Error('OfficeCLI HTML 输出不完整')
      // OfficeCLI 每个工作表最多渲染 5000 行，超出时自己在页面里加一条「Showing 5000 of N rows」
      const truncated = OFFICECLI_TRUNCATION_MARKER.test(html)
      writeFileSync(outputPath, html, 'utf-8')
      const htmlUrl = await registerFilePath(outputPath)
      let text = ''
      try {
        const result = await runBundledOfficeCli(candidate, ['view', resolvedPath, 'text', '--max-lines', '10000'], {
          timeoutMs: OFFICECLI_TEXT_RENDER_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        })
        text = result.stdout.trim()
      } catch (textError) {
        console.warn('[file-preview] OfficeCLI 文本提取失败，预览仍可用:', textError instanceof Error ? textError.message : textError)
      }
      removeTempFileLater(outputPath)
      return { htmlUrl, text, truncated }
    } catch (error) {
      lastError = error
      try { unlinkSync(outputPath) } catch { /* 输出可能尚未生成 */ }
    }
  }

  if (lastError) {
    console.warn('[file-preview] OfficeCLI 文档渲染不可用，回退内置解析器:', lastError instanceof Error ? lastError.message : lastError)
  }
  return null
}

export async function renderXlsxWithOfficeCli(
  resolvedPath: string,
  registerFilePath: (path: string) => string | Promise<string> = registerOfficeCliOutputFile,
  officeCliCandidates = getOfficeCliCandidates(),
): Promise<{ htmlUrl: string; text: string; truncated: boolean } | null> {
  return renderOfficeWithOfficeCli(resolvedPath, registerFilePath, officeCliCandidates, new Set(['.xlsx']))
}

/** 大表格 / 被 OfficeCLI 截断的表格：主进程不产出 HTML，交给渲染层虚拟滚动表格 */
function spreadsheetGridResult(
  resolvedPath: string,
  reason: 'large' | 'truncated',
  layout: XlsxLayout | null,
): OfficePreviewResult {
  const frozenPanes = Object.fromEntries(
    (layout?.sheets ?? [])
      .filter((sheet) => sheet.frozenRows > 0 || sheet.frozenCols > 0)
      .map((sheet) => [sheet.name, { rows: sheet.frozenRows, cols: sheet.frozenCols }]),
  )
  return {
    resolvedPath,
    kind: 'spreadsheet',
    html: '',
    text: '',
    renderer: 'grid',
    grid: { reason, maxRows: layout?.maxRows, frozenPanes },
  }
}

async function convertLegacyDocToHtml(resolvedPath: string, size: number): Promise<OfficePreviewResult | null> {
  // word-extractor 在主进程内解析，沿用回退解析器的体积门槛，大文件不在这里拖住主进程
  if (size > MAX_FALLBACK_PARSE_SIZE) {
    console.warn(`[file-preview] 旧版 .doc 文件 ${(size / 1024 / 1024).toFixed(1)}MB 超过内置解析门槛，放弃内联预览: ${resolvedPath}`)
    return null
  }
  const WordExtractor = (await import('word-extractor')).default
  const document = await new WordExtractor().extract(resolvedPath)
  const parts = {
    body: document.getBody(),
    headers: document.getHeaders({ includeFooters: true }),
    footnotes: document.getFootnotes(),
    endnotes: document.getEndnotes(),
  }
  return { resolvedPath, kind: 'document', html: renderLegacyDocHtml(parts), text: legacyDocPlainText(parts), renderer: 'builtin' }
}

/** 将 XLSX/PPTX 转成可内联展示的 HTML 预览 */
export async function convertOfficeToHtml(filePath: string, basePaths?: string[]): Promise<OfficePreviewResult | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null

  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null

    const ext = extname(safePath).toLowerCase()
    if (ext === '.doc') return await convertLegacyDocToHtml(safePath, st.size)
    if (ext === '.xlsx' || ext === '.docx' || ext === '.pptx') {
      // 行数超过 OfficeCLI 显示上限的表格在转换前就分流：OfficeCLI 转 5 万行要 7 秒、打开占 1GB 内存，且只显示前 5000 行
      const layout = ext === '.xlsx' ? await probeXlsxLayout(safePath) : null
      if (layout?.maxRows !== undefined && layout.maxRows > OFFICECLI_XLSX_MAX_ROWS) {
        return spreadsheetGridResult(safePath, 'large', layout)
      }
      const officeCliResult = await renderOfficeWithOfficeCli(safePath)
      if (officeCliResult && ext === '.xlsx' && officeCliResult.truncated) {
        // 探测不到行数（工作表没写 dimension）但 OfficeCLI 自报截断：同样交给虚拟滚动表格，不让用户看半张表
        return spreadsheetGridResult(safePath, 'truncated', layout)
      }
      if (officeCliResult) {
        const kind: OfficePreviewResult['kind'] = ext === '.xlsx'
          ? 'spreadsheet'
          : ext === '.docx'
            ? 'document'
            : 'presentation'
        return {
          resolvedPath: safePath,
          kind,
          html: '',
          htmlUrl: officeCliResult.htmlUrl,
          text: officeCliResult.text,
          renderer: 'officecli',
        }
      }
      // OfficeCLI 没渲染出来才走到这里。以下三条回退都在主进程内解析且无超时，
      // 大文件会连累所有窗口一起冻结，所以单独设一道更低的体积门槛。
      if (st.size > MAX_FALLBACK_PARSE_SIZE) {
        console.warn(`[file-preview] OfficeCLI 未产出且文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过回退解析门槛，放弃内联预览: ${safePath}`)
        return null
      }
      if (ext === '.xlsx') return convertXlsxToHtml(filePath, safePath)
      if (ext === '.pptx') return convertPptxToHtml(filePath, safePath)
      const mammoth = await import('mammoth')
      const result = await mammoth.convertToHtml({ path: safePath })
      return { resolvedPath: safePath, kind: 'document', html: result.value, text: result.value.replace(/<[^>]+>/g, ' ') }
    }
    return null
  } catch (err) {
    console.error('[file-preview] convertOfficeToHtml structured preview failed:', err)
    try {
      // 纯文本兜底同样在主进程解析，沿用回退门槛，别让大文件在这里把主进程拖住。
      if (statSync(safePath).size > MAX_FALLBACK_PARSE_SIZE) return null
      const officeParser = await import('officeparser')
      const text = await officeParser.parseOfficeAsync(safePath)
      const ext = extname(safePath).toLowerCase()
      const kind: OfficePreviewResult['kind'] = ext === '.pptx'
        ? 'presentation'
        : ext === '.docx'
          ? 'document'
          : 'spreadsheet'
      return {
        resolvedPath: safePath,
        kind,
        html: renderOfficeTextFallback(filePath, text, kind),
        text,
      }
    } catch (fallbackErr) {
      console.error('[file-preview] convertOfficeToHtml text fallback failed:', fallbackErr)
      return null
    }
  }
}
