import { describe, expect, test } from 'bun:test'
import { extractLegacyPptSlides, readPersistDirectory, splitPptText } from './legacy-ppt-text'

const CR = String.fromCharCode(13)
const VT = String.fromCharCode(11)

// ---------- 拼二进制记录的小工具（[MS-PPT] 记录头：verInst u16 / type u16 / len u32） ----------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function record(version: number, instance: number, type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, (instance << 4) | version, true)
  view.setUint16(2, type, true)
  view.setUint32(4, body.length, true)
  out.set(body, 8)
  return out
}

const container = (type: number, children: Uint8Array[], instance = 0): Uint8Array => record(0x0f, instance, type, concat(children))
const atom = (type: number, body: Uint8Array, instance = 0): Uint8Array => record(0, instance, type, body)

function utf16(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    out[i * 2] = text.charCodeAt(i) & 0xff
    out[i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return out
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0))
}

function u32s(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return out
}

const textChars = (text: string): Uint8Array => atom(0x0fa0, utf16(text))
const textBytes = (text: string): Uint8Array => atom(0x0fa8, latin1(text))
const slidePersist = (persistId: number): Uint8Array => atom(0x03f3, u32s(persistId, 0, 0, 0, 0))
/** 形状文字放在嵌套容器里（模拟 Drawing → ClientTextbox） */
const slideContainer = (...texts: Uint8Array[]): Uint8Array => container(0x03ee, [container(0xf00d, texts)])

function userEdit(offsetLastEdit: number, offsetPersistDirectory: number, documentPersistId: number): Uint8Array {
  const body = new Uint8Array(28)
  const view = new DataView(body.buffer)
  view.setUint32(8, offsetLastEdit, true)
  view.setUint32(12, offsetPersistDirectory, true)
  view.setUint32(16, documentPersistId, true)
  return atom(0x0ff5, body)
}

function persistDirectory(firstId: number, offsets: number[]): Uint8Array {
  return atom(0x1772, u32s((offsets.length << 20) | firstId, ...offsets))
}

function currentUser(offsetToCurrentEdit: number): Uint8Array {
  const body = new Uint8Array(24)
  new DataView(body.buffer).setUint32(16, offsetToCurrentEdit, true)
  return body
}

/** 组装一份最小可解析的 PowerPoint Document 流 */
function buildDeck(): { stream: Uint8Array; user: Uint8Array; offsets: Record<string, number> } {
  const slideA = slideContainer(textChars('形状文字 A'), textChars('第一页标题'))
  const slideB = slideContainer(textBytes('Shape B'))
  const slideList = container(0x0ff0, [
    // 放映顺序：先 persist 3（slideB），再 persist 2（slideA）
    slidePersist(3), textChars(`第一页标题${CR}正文一${VT}换行`),
    slidePersist(2), textBytes('Page two'),
  ], 0)
  const masterList = container(0x0ff0, [slidePersist(9), textChars('母版文字不应出现')], 1)
  const documentRecord = container(0x03e8, [masterList, slideList])

  const offsets: Record<string, number> = {}
  const parts: Uint8Array[] = []
  const push = (name: string, bytes: Uint8Array): void => {
    offsets[name] = parts.reduce((sum, part) => sum + part.length, 0)
    parts.push(bytes)
  }
  push('slideA', slideA)
  push('slideB', slideB)
  push('document', documentRecord)
  const directoryOffset = parts.reduce((sum, part) => sum + part.length, 0)
  push('directory', persistDirectory(1, [offsets.document!, offsets.slideA!, offsets.slideB!]))
  push('edit', userEdit(0, directoryOffset, 1))
  return { stream: concat(parts), user: currentUser(offsets.edit!), offsets }
}

describe('旧版 PPT 段落拆分', () => {
  test('Given CR 分段与 VT 段内换行 When 拆分 Then 按段落输出、段内换行保留、空段去掉', () => {
    expect(splitPptText(`标题${CR}${CR}正文${VT}第二行${CR}`)).toEqual(['标题', `正文\n第二行`])
  })
})

describe('旧版 PPT 按页提取文字', () => {
  test('Given 完整的持久化目录 When 提取 Then 按放映顺序出页，占位符文字在前、形状文字在后，母版文字不混入', () => {
    const { stream, user } = buildDeck()
    expect(extractLegacyPptSlides(stream, user)).toEqual([
      { index: 1, paragraphs: ['第一页标题', `正文一\n换行`, 'Shape B'] },
      { index: 2, paragraphs: ['Page two', '形状文字 A', '第一页标题'] },
    ])
  })

  test('Given 同一段文字既在大纲又在形状里 When 提取 Then 只出现一次', () => {
    const slide = slideContainer(textChars('重复标题'), textChars('只在形状里'))
    const list = container(0x0ff0, [slidePersist(2), textChars('重复标题')], 0)
    const doc = container(0x03e8, [list])
    const directoryOffset = slide.length + doc.length
    const edit = userEdit(0, directoryOffset, 1)
    const stream = concat([slide, doc, persistDirectory(1, [slide.length, 0]), edit])
    const editOffset = directoryOffset + persistDirectory(1, [0, 0]).length
    expect(extractLegacyPptSlides(stream, currentUser(editOffset))).toEqual([
      { index: 1, paragraphs: ['重复标题', '只在形状里'] },
    ])
  })

  test('Given 两次编辑 When 合并持久化目录 Then 以最新一次的偏移为准，旧编辑不覆盖', () => {
    const { stream, offsets } = buildDeck()
    // 追加一次新编辑：把 persist 2 改指向一个新的 slide 容器
    const newSlide = slideContainer(textChars('改过的第二页'))
    const newSlideOffset = stream.length
    const newDirectoryOffset = newSlideOffset + newSlide.length
    const newDirectory = persistDirectory(2, [newSlideOffset])
    const newEditOffset = newDirectoryOffset + newDirectory.length
    const edited = concat([stream, newSlide, newDirectory, userEdit(offsets.edit!, newDirectoryOffset, 1)])
    const view = new DataView(edited.buffer)

    const directory = readPersistDirectory(view, newEditOffset)
    expect(directory?.persist.get(2)).toBe(newSlideOffset)
    expect(directory?.persist.get(3)).toBe(offsets.slideB)

    const slides = extractLegacyPptSlides(edited, currentUser(newEditOffset))
    expect(slides[1]?.paragraphs).toEqual(['Page two', '改过的第二页'])
  })

  test('Given 缺少 Current User 流 When 提取 Then 退化为按流里 Slide 容器出现的顺序', () => {
    const { stream } = buildDeck()
    expect(extractLegacyPptSlides(stream)).toEqual([
      { index: 1, paragraphs: ['形状文字 A', '第一页标题'] },
      { index: 2, paragraphs: ['Shape B'] },
    ])
  })

  test('Given 偏移指向垃圾数据 When 提取 Then 不抛错，退化路径照样出内容', () => {
    const { stream } = buildDeck()
    expect(extractLegacyPptSlides(stream, currentUser(stream.length + 999)).length).toBe(2)
  })

  test('Given 没有任何 Slide 容器只有零散文字 When 提取 Then 全部文字归为一页；什么都没有时返回空数组', () => {
    expect(extractLegacyPptSlides(concat([textChars('孤立文字'), textBytes('loose')]))).toEqual([
      { index: 1, paragraphs: ['孤立文字', 'loose'] },
    ])
    expect(extractLegacyPptSlides(new Uint8Array(16))).toEqual([])
  })
})
