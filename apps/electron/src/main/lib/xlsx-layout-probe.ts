/**
 * xlsx 结构探测：不整份解析，只读出每个工作表的行数范围（`<dimension>`）与冻结窗格（`<pane state="frozen">`）。
 *
 * 用途：决定一份 xlsx 走 OfficeCLI 高保真预览，还是走渲染层的虚拟滚动表格。
 * OfficeCLI 每个工作表最多显示 5000 行（实测输出「Showing 5000 of 50001 rows」），
 * 5 万行的表格转换还要 7 秒、打开占 1GB 内存，所以大表必须在转换之前就分流。
 *
 * 做法：自己读 zip 中央目录，只解压 workbook.xml / rels（很小）和每个工作表 XML 的**开头一段**
 * （`<dimension>` 与 `<sheetViews>` 都在 `<sheetData>` 之前）。不把整个文件读进内存，也不整份解压，
 * 5MB 的表格探测只读几十 KB。zip64 / 加密 / 结构异常一律返回 null，由调用方按「不知道」处理。
 */

import { open, type FileHandle } from 'node:fs/promises'
import { constants as zlibConstants, inflateRawSync } from 'node:zlib'

export interface XlsxSheetLayout {
  name: string
  /** 读不到 `<dimension>` 时为 undefined */
  rows?: number
  frozenRows: number
  frozenCols: number
}

export interface XlsxLayout {
  sheets: XlsxSheetLayout[]
  /** 已知行数里的最大值；全部未知时为 undefined */
  maxRows?: number
}

interface ZipEntry {
  method: number
  compressedSize: number
  localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** 工作表 XML 只读开头这么多压缩字节：XML 压缩比通常 10 倍以上，足够覆盖 dimension 与 sheetViews */
const SHEET_PREFIX_COMPRESSED_BYTES = 64 * 1024
/** workbook.xml / rels 超过这个就不当作正常文件 */
const SMALL_PART_LIMIT = 4 * 1024 * 1024

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
}

async function readCentralDirectory(handle: FileHandle, fileSize: number): Promise<Map<string, ZipEntry> | null> {
  const tailLength = Math.min(fileSize, 65557)
  const tail = await readAt(handle, fileSize - tailLength, tailLength)
  let eocd = -1
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocd = index
      break
    }
  }
  if (eocd < 0) return null
  const entryCount = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || directoryOffset + directorySize > fileSize) return null

  const directory = await readAt(handle, directoryOffset, directorySize)
  const entries = new Map<string, ZipEntry>()
  let cursor = 0
  for (let index = 0; index < entryCount && cursor + 46 <= directory.length; index += 1) {
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null
    const method = directory.readUInt16LE(cursor + 10)
    const compressedSize = directory.readUInt32LE(cursor + 20)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const localHeaderOffset = directory.readUInt32LE(cursor + 42)
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.set(name.replace(/^\/+/, ''), { method, compressedSize, localHeaderOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 读条目的开头 maxCompressed 个压缩字节并解压（截断的 deflate 流用 SYNC_FLUSH 拿到已能解出的部分） */
async function readEntryPrefix(handle: FileHandle, entry: ZipEntry, maxCompressed: number): Promise<string | null> {
  const localHeader = await readAt(handle, entry.localHeaderOffset, 30)
  if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) return null
  const dataStart = entry.localHeaderOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28)
  const length = Math.min(entry.compressedSize, maxCompressed)
  const data = await readAt(handle, dataStart, length)
  if (entry.method === 0) return data.toString('utf8')
  if (entry.method !== 8) return null
  try {
    return inflateRawSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8')
  } catch {
    return null
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function readAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attributes.set(match[1]!, decodeXmlText(match[2]!))
  return attributes
}

function columnRowOf(reference: string): { row: number } | null {
  // 本文件一律用 String#match（非全局正则时与 RegExp#exec 等价）：本文件提到 OfficeCLI，调用点守卫测试会把「exec + 左括号」判成执行子进程
  const match = reference.match(/^\$?[A-Za-z]{1,3}\$?(\d+)$/)
  return match ? { row: Number(match[1]) } : null
}

/** `<dimension ref="A1:L50001"/>` → 50001；单格引用视为 1 行 */
export function parseDimensionRows(sheetXmlPrefix: string): number | undefined {
  const tag = sheetXmlPrefix.match(/<(?:\w+:)?dimension\b[^>]*>/)?.[0]
  const reference = tag ? readAttributes(tag).get('ref') : undefined
  if (!reference) return undefined
  const [start, end] = reference.split(':')
  const first = start ? columnRowOf(start) : null
  const last = end ? columnRowOf(end) : first
  if (!first || !last) return undefined
  return Math.max(last.row - first.row + 1, 1)
}

/** 第一个 sheetView 里 state 为 frozen / frozenSplit 的 pane → 冻结的行列数 */
export function parseFrozenPane(sheetXmlPrefix: string): { rows: number; cols: number } {
  const sheetView = sheetXmlPrefix.match(/<(?:\w+:)?sheetView\b[\s\S]*?(?:<\/(?:\w+:)?sheetView>|\/>)/)?.[0] ?? ''
  const pane = sheetView.match(/<(?:\w+:)?pane\b[^>]*>/)?.[0]
  if (!pane) return { rows: 0, cols: 0 }
  const attributes = readAttributes(pane)
  const state = attributes.get('state')
  if (state !== 'frozen' && state !== 'frozenSplit') return { rows: 0, cols: 0 }
  const toCount = (value: string | undefined): number => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
  }
  return { rows: toCount(attributes.get('ySplit')), cols: toCount(attributes.get('xSplit')) }
}

/** 解析 workbook.xml 与 rels，得到按顺序的「工作表名 → 部件路径」 */
export function resolveSheetParts(workbookXml: string, relsXml: string): Array<{ name: string; part: string }> {
  const targets = new Map<string, string>()
  for (const tag of relsXml.match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? []) {
    const attributes = readAttributes(tag)
    const id = attributes.get('Id')
    const target = attributes.get('Target')
    if (!id || !target || /^https?:/i.test(target)) continue
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    targets.set(id, part.replace(/\/\.\//g, '/'))
  }
  const sheets: Array<{ name: string; part: string }> = []
  for (const tag of workbookXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) ?? []) {
    const attributes = readAttributes(tag)
    const name = attributes.get('name')
    const relationshipId = attributes.get('r:id') ?? [...attributes.entries()].find(([key]) => key.endsWith(':id'))?.[1]
    const part = relationshipId ? targets.get(relationshipId) : undefined
    if (name && part) sheets.push({ name, part })
  }
  return sheets
}

export async function probeXlsxLayout(filePath: string): Promise<XlsxLayout | null> {
  let handle: FileHandle | null = null
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const entries = await readCentralDirectory(handle, size)
    if (!entries) return null
    const workbookEntry = entries.get('xl/workbook.xml')
    const relsEntry = entries.get('xl/_rels/workbook.xml.rels')
    if (!workbookEntry || !relsEntry || workbookEntry.compressedSize > SMALL_PART_LIMIT || relsEntry.compressedSize > SMALL_PART_LIMIT) return null
    const workbookXml = await readEntryPrefix(handle, workbookEntry, workbookEntry.compressedSize)
    const relsXml = await readEntryPrefix(handle, relsEntry, relsEntry.compressedSize)
    if (!workbookXml || !relsXml) return null

    const sheets: XlsxSheetLayout[] = []
    for (const { name, part } of resolveSheetParts(workbookXml, relsXml)) {
      const entry = entries.get(part)
      const prefix = entry ? await readEntryPrefix(handle, entry, SHEET_PREFIX_COMPRESSED_BYTES) : null
      const frozen = prefix ? parseFrozenPane(prefix) : { rows: 0, cols: 0 }
      sheets.push({ name, rows: prefix ? parseDimensionRows(prefix) : undefined, frozenRows: frozen.rows, frozenCols: frozen.cols })
    }
    if (sheets.length === 0) return null
    const known = sheets.map((sheet) => sheet.rows).filter((rows): rows is number => rows !== undefined)
    return { sheets, maxRows: known.length > 0 ? Math.max(...known) : undefined }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
