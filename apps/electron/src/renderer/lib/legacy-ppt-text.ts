/**
 * 旧版 PowerPoint（.ppt，97-2003 二进制）按页提取文字。
 *
 * 依据微软公开的 [MS-PPT] 格式：
 * - 「Current User」流里的 CurrentUserAtom 给出最新一次编辑（UserEditAtom）在「PowerPoint Document」流里的偏移；
 * - 沿 UserEditAtom.offsetLastEdit 往回走，合并各次编辑的 PersistDirectoryAtom，得到 persistId → 记录偏移；
 * - Document 容器里 instance=0 的 SlideListWithText 按放映顺序列出每页的 SlidePersistAtom，
 *   其后跟着该页占位符（标题 / 正文）的文字记录；
 * - 每页自己的 Slide 容器里还有文本框、表格单元格等形状的文字（ClientTextbox 里的文字记录）。
 *
 * 只取文字，不还原图片与版式。持久化目录读坏时退化为「按流里 Slide 容器出现的顺序」收集，
 * 再坏就把全部文字记录当成一页，尽量让用户看到内容而不是报错。
 */

const RT_DOCUMENT = 0x03e8
const RT_SLIDE = 0x03ee
const RT_SLIDE_PERSIST_ATOM = 0x03f3
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0
const RT_USER_EDIT_ATOM = 0x0ff5
const RT_PERSIST_DIRECTORY_ATOM = 0x1772
const RT_TEXT_CHARS_ATOM = 0x0fa0
const RT_TEXT_BYTES_ATOM = 0x0fa8
/** 母版 / 备注页的文字不算正文 */
const SLIDE_LIST_INSTANCE_SLIDES = 0

export interface LegacyPptSlide {
  /** 放映顺序，从 1 开始 */
  index: number
  paragraphs: string[]
}

interface RecordHeader {
  version: number
  instance: number
  type: number
  length: number
  /** 记录体起点（紧跟 8 字节头） */
  bodyStart: number
  /** 记录体终点（不含） */
  end: number
}

function readHeader(view: DataView, offset: number): RecordHeader | null {
  if (offset < 0 || offset + 8 > view.byteLength) return null
  const versionInstance = view.getUint16(offset, true)
  const type = view.getUint16(offset + 2, true)
  const length = view.getUint32(offset + 4, true)
  const bodyStart = offset + 8
  const end = bodyStart + length
  if (end > view.byteLength) return null
  return { version: versionInstance & 0x0f, instance: versionInstance >> 4, type, length, bodyStart, end }
}

function decodeUtf16(bytes: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let offset = start; offset + 1 < end; offset += 2) text += String.fromCharCode(bytes[offset]! | (bytes[offset + 1]! << 8))
  return text
}

function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let offset = start; offset < end; offset += 1) text += String.fromCharCode(bytes[offset]!)
  return text
}

/** PPT 用 CR 分段、VT（0x0B）表示段内换行；拆成段落并去掉空段与其余控制字符 */
const VERTICAL_TAB = new RegExp(String.fromCharCode(0x0b), 'g')
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}]`, 'g')

export function splitPptText(raw: string): string[] {
  return raw
    .replace(VERTICAL_TAB, '\n')
    .split('\r')
    .map((paragraph) => paragraph.replace(CONTROL_CHARACTERS, '').trim())
    .filter(Boolean)
}

/** 深度优先收集某个容器（含嵌套容器）里的全部文字记录 */
export function collectTextRecords(view: DataView, bytes: Uint8Array, start: number, end: number, output: string[], depth = 0): void {
  let offset = start
  while (offset + 8 <= end) {
    const header = readHeader(view, offset)
    if (!header || header.end > end) return
    if (header.version === 0x0f) {
      if (depth < 32) collectTextRecords(view, bytes, header.bodyStart, header.end, output, depth + 1)
    } else if (header.type === RT_TEXT_CHARS_ATOM) {
      output.push(...splitPptText(decodeUtf16(bytes, header.bodyStart, header.end)))
    } else if (header.type === RT_TEXT_BYTES_ATOM) {
      output.push(...splitPptText(decodeLatin1(bytes, header.bodyStart, header.end)))
    }
    offset = header.end
  }
}

/** 合并 UserEditAtom 链上的全部持久化目录；新的编辑覆盖旧的 */
export function readPersistDirectory(view: DataView, currentEditOffset: number): { persist: Map<number, number>; documentPersistId: number } | null {
  const persist = new Map<number, number>()
  let documentPersistId = -1
  let offset = currentEditOffset
  const visited = new Set<number>()
  while (offset > 0 || (offset === 0 && visited.size === 0)) {
    if (visited.has(offset)) break
    visited.add(offset)
    const edit = readHeader(view, offset)
    if (!edit || edit.type !== RT_USER_EDIT_ATOM || edit.length < 20) return persist.size > 0 && documentPersistId >= 0 ? { persist, documentPersistId } : null
    const offsetLastEdit = view.getUint32(edit.bodyStart + 8, true)
    const offsetPersistDirectory = view.getUint32(edit.bodyStart + 12, true)
    if (documentPersistId < 0) documentPersistId = view.getUint32(edit.bodyStart + 16, true)
    const directory = readHeader(view, offsetPersistDirectory)
    if (directory && directory.type === RT_PERSIST_DIRECTORY_ATOM) {
      let cursor = directory.bodyStart
      while (cursor + 4 <= directory.end) {
        const packed = view.getUint32(cursor, true)
        const firstId = packed & 0x000fffff
        const count = packed >>> 20
        cursor += 4
        for (let index = 0; index < count && cursor + 4 <= directory.end; index += 1) {
          const persistId = firstId + index
          // 沿链从新到旧走：先写入的是最新的偏移，旧编辑不能覆盖
          if (!persist.has(persistId)) persist.set(persistId, view.getUint32(cursor, true))
          cursor += 4
        }
      }
    }
    if (offsetLastEdit === 0 || offsetLastEdit === offset) break
    offset = offsetLastEdit
  }
  return persist.size > 0 && documentPersistId >= 0 ? { persist, documentPersistId } : null
}

function slidesFromPersistDirectory(view: DataView, bytes: Uint8Array, currentEditOffset: number): LegacyPptSlide[] | null {
  const directory = readPersistDirectory(view, currentEditOffset)
  if (!directory) return null
  const documentOffset = directory.persist.get(directory.documentPersistId)
  const document = documentOffset === undefined ? null : readHeader(view, documentOffset)
  if (!document || document.type !== RT_DOCUMENT) return null

  const slides: LegacyPptSlide[] = []
  let offset = document.bodyStart
  while (offset + 8 <= document.end) {
    const header = readHeader(view, offset)
    if (!header) break
    if (header.type === RT_SLIDE_LIST_WITH_TEXT && header.instance === SLIDE_LIST_INSTANCE_SLIDES) {
      let current: { persistId: number; paragraphs: string[] } | null = null
      const flush = (): void => {
        if (!current) return
        const slideOffset = directory.persist.get(current.persistId)
        const slide = slideOffset === undefined ? null : readHeader(view, slideOffset)
        const shapeTexts: string[] = []
        if (slide && slide.type === RT_SLIDE) collectTextRecords(view, bytes, slide.bodyStart, slide.end, shapeTexts)
        // 占位符文字两处都可能出现，去重但保持先大纲后形状的顺序
        const seen = new Set(current.paragraphs)
        slides.push({ index: slides.length + 1, paragraphs: [...current.paragraphs, ...shapeTexts.filter((text) => !seen.has(text))] })
        current = null
      }
      let child = header.bodyStart
      while (child + 8 <= header.end) {
        const item = readHeader(view, child)
        if (!item) break
        if (item.type === RT_SLIDE_PERSIST_ATOM && item.length >= 4) {
          flush()
          current = { persistId: view.getUint32(item.bodyStart, true), paragraphs: [] }
        } else if (current && item.type === RT_TEXT_CHARS_ATOM) {
          current.paragraphs.push(...splitPptText(decodeUtf16(bytes, item.bodyStart, item.end)))
        } else if (current && item.type === RT_TEXT_BYTES_ATOM) {
          current.paragraphs.push(...splitPptText(decodeLatin1(bytes, item.bodyStart, item.end)))
        }
        child = item.end
      }
      flush()
    }
    offset = header.end
  }
  return slides.length > 0 ? slides : null
}

function slidesByStreamOrder(view: DataView, bytes: Uint8Array): LegacyPptSlide[] {
  const slides: LegacyPptSlide[] = []
  let offset = 0
  while (offset + 8 <= view.byteLength) {
    const header = readHeader(view, offset)
    if (!header) break
    if (header.type === RT_SLIDE) {
      const paragraphs: string[] = []
      collectTextRecords(view, bytes, header.bodyStart, header.end, paragraphs)
      slides.push({ index: slides.length + 1, paragraphs })
    }
    offset = header.end
  }
  return slides
}

/**
 * @param documentStream 「PowerPoint Document」流的字节
 * @param currentUserStream 「Current User」流的字节（缺失时直接走退化路径）
 */
export function extractLegacyPptSlides(documentStream: Uint8Array, currentUserStream?: Uint8Array): LegacyPptSlide[] {
  const view = new DataView(documentStream.buffer, documentStream.byteOffset, documentStream.byteLength)
  if (currentUserStream && currentUserStream.byteLength >= 20) {
    const userView = new DataView(currentUserStream.buffer, currentUserStream.byteOffset, currentUserStream.byteLength)
    const currentEditOffset = userView.getUint32(16, true)
    try {
      const slides = slidesFromPersistDirectory(view, documentStream, currentEditOffset)
      if (slides) return slides
    } catch {
      // 走退化路径
    }
  }
  const byOrder = slidesByStreamOrder(view, documentStream)
  if (byOrder.some((slide) => slide.paragraphs.length > 0)) return byOrder
  const all: string[] = []
  collectTextRecords(view, documentStream, 0, view.byteLength, all)
  return all.length > 0 ? [{ index: 1, paragraphs: all }] : []
}
