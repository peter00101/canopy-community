/**
 * Office 预览后台线程：大表格 / 旧版 .xls 解析与取块、跨工作表搜索、旧版 .ppt 按页提取文字。
 *
 * 解析 5 万行表格要 1 秒多，放在页面线程会整页卡死，所以全部在这里做；页面只按可见区域取块。
 * 生产环境页面是 file://，实测模块 Worker 在现有 CSP 下可用（blob Worker 会被 CSP 拦下，别改成内联）。
 */

import { CFB, read, type WorkBook } from '@e965/xlsx'
import { extractLegacyPptSlides } from '../lib/legacy-ppt-text'
import { spreadsheetReadInput } from '../lib/spreadsheet-input'
import {
  buildSheetMeta,
  readBlock,
  searchSheets,
  type DenseSheetLike,
  type SpreadsheetSheetMeta,
} from '../lib/spreadsheet-worker-core'
import type { OfficePreviewWorkerRequest, OfficePreviewWorkerResponse } from '../lib/office-preview-worker-protocol'

let workbook: WorkBook | null = null
let sheets: Array<{ sheet: DenseSheetLike; meta: SpreadsheetSheetMeta }> = []

function openWorkbook(bytes: ArrayBuffer): SpreadsheetSheetMeta[] {
  // 文本冒充的 .xls（业务系统导出的 CSV / HTML）先解码，否则中文会被当单字节读成乱码
  const input = spreadsheetReadInput(new Uint8Array(bytes))
  workbook = read(input.data, { type: input.type, dense: true, cellStyles: true, cellDates: false })
  sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook!.Sheets[name] as unknown as DenseSheetLike
    return { sheet, meta: buildSheetMeta(name, sheet) }
  })
  return sheets.map((entry) => entry.meta)
}

function readPpt(bytes: ArrayBuffer) {
  const container = CFB.read(new Uint8Array(bytes), { type: 'array' })
  const documentStream = CFB.find(container, 'PowerPoint Document')
  if (!documentStream?.content) throw new Error('不是有效的 PowerPoint 97-2003 文件')
  const currentUser = CFB.find(container, 'Current User')
  const toBytes = (content: unknown): Uint8Array => content instanceof Uint8Array ? content : new Uint8Array(content as ArrayLike<number>)
  return extractLegacyPptSlides(toBytes(documentStream.content), currentUser?.content ? toBytes(currentUser.content) : undefined)
}

self.onmessage = (event: MessageEvent<OfficePreviewWorkerRequest>) => {
  const request = event.data
  const reply = (response: OfficePreviewWorkerResponse): void => self.postMessage(response)
  try {
    switch (request.type) {
      case 'open-workbook':
        reply({ id: request.id, ok: true, result: openWorkbook(request.bytes) })
        break
      case 'read-block': {
        const entry = sheets[request.sheet]
        if (!entry) throw new Error('工作表不存在')
        reply({ id: request.id, ok: true, result: readBlock(entry.sheet, request.rowStart, request.rowEnd, request.colStart, request.colEnd) })
        break
      }
      case 'search':
        reply({ id: request.id, ok: true, result: searchSheets(sheets, request.query, request.options, request.limit) })
        break
      case 'read-ppt':
        reply({ id: request.id, ok: true, result: readPpt(request.bytes) })
        break
      default:
        throw new Error('未知的请求类型')
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
