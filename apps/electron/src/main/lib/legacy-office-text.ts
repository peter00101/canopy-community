/**
 * 旧版 Office 97-2003 二进制格式（.doc / .xls / .ppt）的只读内容提取：Agent 的 OfficeInspect 与 Chat 附件共用。
 *
 * OfficeCLI 不认这些格式，所以不经它。这里是纯逻辑：主进程经 `legacy-office-parser.ts` 放到后台线程执行
 * （解析 8MB 的 .xls 要 1 秒左右，Agent 工具跑在主进程里，不能卡住它），单测直接调用。
 * 表格的输出结构与 OfficeCLI 读 .xlsx 时一致（sheets → rows → cells），模型不必学两套。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { CFB, read, utils, type CellObject, type WorkBook, type WorkSheet } from '@e965/xlsx'
// 纯逻辑模块，与界面预览的后台线程共用同一份 [MS-PPT] 解析
import { extractLegacyPptSlides, type LegacyPptSlide } from '../../renderer/lib/legacy-ppt-text'
import { spreadsheetReadInput } from '../../renderer/lib/spreadsheet-input'
import { legacyDocPlainText, type LegacyDocParts } from './legacy-doc-preview'
import { legacyOfficeKindOf, modernOfficeExtensionFor, type LegacyOfficeKind } from './legacy-office-formats'

const FORMAT_LABEL: Readonly<Record<LegacyOfficeKind, string>> = {
  document: 'Word 97-2003',
  spreadsheet: 'Excel 97-2003',
  presentation: 'PowerPoint 97-2003',
}

export type LegacyOfficeTask =
  | { type: 'inspect'; filePath: string; mode: 'outline' | 'text' | 'stats'; maxLines: number }
  | { type: 'plain-text'; filePath: string; maxRowsPerSheet: number; maxChars: number }

/** inspect 的结果形状与 OfficeCLI 的 JSON 信封一致，交给 describeEnvelope 转成给模型看的文字 */
export interface LegacyInspectResult {
  message: string
  data: unknown
}

export async function runLegacyOfficeTask(task: LegacyOfficeTask): Promise<LegacyInspectResult | string> {
  const kind = legacyOfficeKindOf(task.filePath)
  if (!kind) throw new Error(`不是旧版 Office 格式：${basename(task.filePath)}`)
  const bytes = readFileSync(task.filePath)
  try {
    if (task.type === 'plain-text') {
      if (kind === 'spreadsheet') return spreadsheetPlainText(readWorkbook(bytes, task.maxRowsPerSheet), task.maxRowsPerSheet, task.maxChars)
      if (kind === 'presentation') return capChars(presentationPlainText(readSlides(bytes), Number.POSITIVE_INFINITY).text, task.maxChars)
      return capChars(legacyDocPlainText(await readDocParts(bytes)), task.maxChars)
    }
    const fileName = basename(task.filePath)
    if (kind === 'spreadsheet') return inspectSpreadsheet(bytes, fileName, task.mode, task.maxLines)
    if (kind === 'presentation') return inspectPresentation(readSlides(bytes), fileName, task.mode, task.maxLines)
    return inspectLegacyDocumentParts(await readDocParts(bytes), fileName, task.mode, task.maxLines)
  } catch (error) {
    // 解析库的原始报错（如「Header Signature: Expected d0cf11e0…」）模型和用户都看不懂，补上可行动的说明
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法解析这个 ${FORMAT_LABEL[kind]} 文件（可能已损坏、加密，或扩展名与实际格式不符）：${reason}`)
  }
}

function readOnlyHint(kind: LegacyOfficeKind): string {
  // 实测：只写「需要时请用户另存」时，用户一句「直接改」模型就会 pip 装 xlrd / xlutils 去改写原文件，
  // 既丢格式又动了用户的 Python 环境，所以这里写成明确的禁令
  const target = modernOfficeExtensionFor(kind)
  return `旧版格式只读，不能修改、截图或按路径 / 选择器读取。即使用户要求直接修改，也不要用 Python 库、pip 安装的包或 LibreOffice 自行改写或转换这个文件（会丢失格式，还会改动用户电脑的环境）；请告诉用户先在 Office / WPS 里另存为 ${target}，再用 Office 工具修改`
}

function capChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（内容过长，只保留前 ${maxChars.toLocaleString()} 个字符）`
}

// ---------- 表格 ----------

function readWorkbook(bytes: Uint8Array, sheetRows?: number): WorkBook {
  const input = spreadsheetReadInput(bytes)
  // sheetRows 只限制读进内存的行数，!fullref 仍给出整表范围
  return read(input.data, { type: input.type, dense: true, cellStyles: false, cellHTML: false, ...(sheetRows ? { sheetRows } : {}) })
}

function sheetData(sheet: WorkSheet): Array<Array<CellObject | null | undefined> | null | undefined> {
  return (sheet as unknown as { '!data'?: Array<Array<CellObject | null | undefined>> })['!data'] ?? []
}

/** 整表行列数：按 !fullref（被 sheetRows 截断时仍是全表）或 !ref */
function sheetSize(sheet: WorkSheet): { rows: number; cols: number } {
  const reference = (sheet['!fullref'] as string | undefined) ?? sheet['!ref']
  if (!reference) return { rows: 0, cols: 0 }
  const range = utils.decode_range(reference)
  return { rows: range.e.r + 1, cols: range.e.c + 1 }
}

function cellString(cell: CellObject | null | undefined): string {
  if (!cell) return ''
  if (typeof cell.w === 'string') return cell.w
  if (cell.v === undefined || cell.v === null) return ''
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10)
  return String(cell.v)
}

/** 与 OfficeCLI stats 的 dataTypeDistribution 同名 */
const CELL_TYPE_LABEL: Readonly<Record<string, string>> = { s: 'String', n: 'Number', b: 'Boolean', d: 'Date', e: 'Error' }

function inspectSpreadsheet(bytes: Uint8Array, fileName: string, mode: string, maxLines: number): LegacyInspectResult {
  const hint = readOnlyHint('spreadsheet')
  if (mode === 'outline') {
    const workbook = readWorkbook(bytes, 1)
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name]!
      return { name, ...sheetSize(sheet) }
    })
    return { message: `${FORMAT_LABEL.spreadsheet}（${fileName}）：${sheets.length} 个工作表。${hint}`, data: { fileName, format: FORMAT_LABEL.spreadsheet, sheets } }
  }
  if (mode === 'stats') {
    const workbook = readWorkbook(bytes)
    const distribution: Record<string, number> = {}
    let totalCells = 0
    let formulaCells = 0
    let errorCells = 0
    for (const name of workbook.SheetNames) {
      for (const row of sheetData(workbook.Sheets[name]!)) {
        for (const cell of row ?? []) {
          if (!cell || (cell.v === undefined && !cell.f)) continue
          totalCells += 1
          if (cell.f) formulaCells += 1
          if (cell.t === 'e') errorCells += 1
          const type = CELL_TYPE_LABEL[cell.t] ?? 'Other'
          distribution[type] = (distribution[type] ?? 0) + 1
        }
      }
    }
    return {
      message: `${FORMAT_LABEL.spreadsheet}（${fileName}）。${hint}`,
      data: { sheets: workbook.SheetNames.length, totalCells, formulaCells, errorCells, dataTypeDistribution: distribution },
    }
  }
  // text：与 OfficeCLI 的 --max-lines 一样按行数计，跨工作表累计
  const workbook = readWorkbook(bytes, maxLines)
  let remaining = maxLines
  let totalRows = 0
  const sheets: Array<{ name: string; rows: Array<{ row: number; cells: Record<string, string> }> }> = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!
    totalRows += sheetSize(sheet).rows
    const rows: Array<{ row: number; cells: Record<string, string> }> = []
    sheetData(sheet).forEach((row, rowIndex) => {
      if (remaining <= 0 || !row) return
      const cells: Record<string, string> = {}
      row.forEach((cell, colIndex) => {
        const text = cellString(cell)
        if (text !== '') cells[utils.encode_cell({ r: rowIndex, c: colIndex })] = text
      })
      if (Object.keys(cells).length === 0) return
      rows.push({ row: rowIndex + 1, cells })
      remaining -= 1
    })
    if (rows.length > 0) sheets.push({ name, rows })
    if (remaining <= 0) break
  }
  const listed = maxLines - remaining
  const more = remaining <= 0 ? `；只列出了前 ${listed} 行有内容的行，要看更多就调大 maxLines` : ''
  return {
    message: `${FORMAT_LABEL.spreadsheet}（${fileName}）：${workbook.SheetNames.length} 个工作表，按范围共约 ${totalRows.toLocaleString()} 行${more}。${hint}`,
    data: { sheets },
  }
}

function spreadsheetPlainText(workbook: WorkBook, maxRowsPerSheet: number, maxChars: number): string {
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!
    const size = sheetSize(sheet)
    const lines: string[] = [`## 工作表：${name}（${size.rows.toLocaleString()} 行 × ${size.cols.toLocaleString()} 列）`]
    for (const row of sheetData(sheet)) {
      // 单元格内的制表符与换行会打乱 TSV 的行列，换成空格
      const values = (row ?? []).map((cell) => cellString(cell).replace(/[\t\r\n]+/g, ' '))
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      if (values.length > 0) lines.push(values.join('\t'))
    }
    if (size.rows > maxRowsPerSheet) lines.push(`…（本表共 ${size.rows.toLocaleString()} 行，只列出前 ${maxRowsPerSheet.toLocaleString()} 行）`)
    parts.push(lines.join('\n'))
  }
  return capChars(parts.join('\n\n'), maxChars)
}

// ---------- 演示文稿 ----------

function readSlides(bytes: Uint8Array): LegacyPptSlide[] {
  const container = CFB.read(bytes, { type: 'buffer' })
  const documentStream = CFB.find(container, 'PowerPoint Document')
  if (!documentStream?.content) throw new Error('不是有效的 PowerPoint 97-2003 文件')
  const currentUser = CFB.find(container, 'Current User')
  const toBytes = (content: unknown): Uint8Array => content instanceof Uint8Array ? content : new Uint8Array(content as ArrayLike<number>)
  return extractLegacyPptSlides(toBytes(documentStream.content), currentUser?.content ? toBytes(currentUser.content) : undefined)
}

function presentationPlainText(slides: LegacyPptSlide[], maxLines: number): { text: string; listedLines: number; totalLines: number } {
  const lines: string[] = []
  let totalLines = 0
  for (const slide of slides) {
    const slideLines = [`## 幻灯片 ${slide.index}`, ...(slide.paragraphs.length > 0 ? slide.paragraphs : ['（本页没有文字）'])]
    totalLines += slideLines.length
    for (const line of slideLines) if (lines.length < maxLines) lines.push(line)
  }
  return { text: lines.join('\n'), listedLines: lines.length, totalLines }
}

function inspectPresentation(slides: LegacyPptSlide[], fileName: string, mode: string, maxLines: number): LegacyInspectResult {
  const hint = readOnlyHint('presentation')
  if (mode === 'outline') {
    return {
      message: `${FORMAT_LABEL.presentation}（${fileName}）：${slides.length} 页。${hint}`,
      data: { fileName, format: FORMAT_LABEL.presentation, slides: slides.map((slide) => ({ slide: slide.index, title: slide.paragraphs[0] ?? '' })) },
    }
  }
  if (mode === 'stats') {
    const paragraphs = slides.reduce((sum, slide) => sum + slide.paragraphs.length, 0)
    const characters = slides.reduce((sum, slide) => sum + slide.paragraphs.join('').length, 0)
    return {
      message: `${FORMAT_LABEL.presentation}（${fileName}）。${hint}`,
      data: { slides: slides.length, paragraphs, characters, slidesWithoutText: slides.filter((slide) => slide.paragraphs.length === 0).length },
    }
  }
  const { text, listedLines, totalLines } = presentationPlainText(slides, maxLines)
  const more = listedLines < totalLines ? `；共 ${totalLines} 行，只列出前 ${listedLines} 行，要看更多就调大 maxLines` : ''
  return { message: `${FORMAT_LABEL.presentation}（${fileName}）：${slides.length} 页，只含文字、不含图片与版式${more}。${hint}`, data: text }
}

// ---------- 文档 ----------

async function readDocParts(bytes: Buffer): Promise<LegacyDocParts> {
  const WordExtractor = (await import('word-extractor')).default
  const document = await new WordExtractor().extract(bytes)
  return {
    body: document.getBody(),
    headers: document.getHeaders({ includeFooters: true }),
    footnotes: document.getFootnotes(),
    endnotes: document.getEndnotes(),
  }
}

/** 导出供单测：word-extractor 需要真实 .doc，这里直接喂提取结果 */
export function inspectLegacyDocumentParts(parts: LegacyDocParts, fileName: string, mode: string, maxLines: number): LegacyInspectResult {
  const hint = readOnlyHint('document')
  const lines = legacyDocPlainText(parts).split('\n').map((line) => line.trimEnd())
  const paragraphs = lines.filter((line) => line.trim() !== '')
  if (mode === 'outline') {
    return {
      message: `${FORMAT_LABEL.document}（${fileName}）：${paragraphs.length} 段。${hint}`,
      data: {
        fileName,
        format: FORMAT_LABEL.document,
        paragraphs: paragraphs.length,
        hasHeadersOrFooters: Boolean(parts.headers?.trim()),
        hasFootnotes: Boolean(parts.footnotes?.trim()),
        hasEndnotes: Boolean(parts.endnotes?.trim()),
        firstParagraphs: paragraphs.slice(0, 10),
      },
    }
  }
  if (mode === 'stats') {
    return {
      message: `${FORMAT_LABEL.document}（${fileName}）。${hint}`,
      data: { paragraphs: paragraphs.length, characters: paragraphs.join('').length, tableRows: paragraphs.filter((line) => line.includes('\t')).length },
    }
  }
  const listed = lines.slice(0, maxLines)
  const more = lines.length > maxLines ? `；共 ${lines.length} 行，只列出前 ${maxLines} 行，要看更多就调大 maxLines` : ''
  return { message: `${FORMAT_LABEL.document}（${fileName}）：只含文字与表格文字，不含图片与排版（表格单元格以制表符分隔）${more}。${hint}`, data: listed.join('\n') }
}
