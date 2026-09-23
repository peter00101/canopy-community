import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CFB, utils, write } from '@e965/xlsx'
import { inspectLegacyDocumentParts, runLegacyOfficeTask, type LegacyInspectResult } from './legacy-office-text'
import { legacyOfficeKindOf } from './legacy-office-formats'

// ---------- 夹具：SheetJS 直接写出 BIFF8（.xls）；.ppt 用最小 [MS-PPT] 记录拼流再装进 CFB 容器 ----------

let dir: string

function writeXls(name: string, sheets: Record<string, unknown[][]>): string {
  const book = utils.book_new()
  for (const [sheetName, rows] of Object.entries(sheets)) utils.book_append_sheet(book, utils.aoa_to_sheet(rows), sheetName)
  const path = join(dir, name)
  writeFileSync(path, write(book, { bookType: 'biff8', type: 'buffer' }))
  return path
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

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function utf16(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i += 1) {
    out[i * 2] = text.charCodeAt(i) & 0xff
    out[i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return out
}

/** 没有 Current User 流时解析器按 Slide 容器出现顺序出页 */
function writePpt(name: string, slides: string[][]): string {
  const stream = concat(slides.map((texts) => record(0x0f, 0, 0x03ee, record(0x0f, 0, 0xf00d, concat(texts.map((text) => record(0, 0, 0x0fa0, utf16(text))))))))
  const container = CFB.utils.cfb_new()
  CFB.utils.cfb_add(container, 'PowerPoint Document', stream)
  const path = join(dir, name)
  writeFileSync(path, CFB.write(container, { type: 'buffer' }))
  return path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-legacy-office-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const inspect = async (filePath: string, mode: 'outline' | 'text' | 'stats', maxLines = 200) =>
  await runLegacyOfficeTask({ type: 'inspect', filePath, mode, maxLines }) as LegacyInspectResult

describe('旧版格式判定', () => {
  test('Given 主格式与模板 / 放映变体 When 判定 Then 归到对应类别，新格式与其他扩展名不算', () => {
    expect(['a.DOC', 'a.dot', 'a.xls', 'a.XLT', 'a.ppt', 'a.pps', 'a.pot'].map(legacyOfficeKindOf))
      .toEqual(['document', 'document', 'spreadsheet', 'spreadsheet', 'presentation', 'presentation', 'presentation'])
    expect(['a.docx', 'a.xlsx', 'a.pptx', 'a.txt', 'noext'].map(legacyOfficeKindOf)).toEqual([null, null, null, null, null])
  })
})

describe('OfficeInspect 读旧版 .xls', () => {
  test('Given 两个工作表 When mode=text Then 输出结构与 OfficeCLI 读 .xlsx 一致（sheets → rows → cells），空行空格不列', async () => {
    const file = writeXls('two.xls', { 明细: [['城市', '金额'], [], ['北京', 12.5]], 汇总: [['合计', 12.5]] })
    const result = await inspect(file, 'text')
    expect(result.data).toEqual({
      sheets: [
        { name: '明细', rows: [{ row: 1, cells: { A1: '城市', B1: '金额' } }, { row: 3, cells: { A3: '北京', B3: '12.5' } }] },
        { name: '汇总', rows: [{ row: 1, cells: { A1: '合计', B1: '12.5' } }] },
      ],
    })
    expect(result.message).toContain('Excel 97-2003')
    expect(result.message).toContain('另存为 .xlsx')
    // 实测回归：只说「需要时请用户另存」时，用户一句「直接改」模型就 pip 装 xlutils 改写了原文件
    expect(result.message).toContain('即使用户要求直接修改，也不要用 Python 库、pip 安装的包或 LibreOffice 自行改写或转换')
  })

  test('Given maxLines 小于总行数 When mode=text Then 跨工作表累计计数、到上限即停，并提示调大 maxLines', async () => {
    const file = writeXls('many.xls', { 一: [['a'], ['b'], ['c']], 二: [['d']] })
    const result = await inspect(file, 'text', 2)
    expect(result.data).toEqual({ sheets: [{ name: '一', rows: [{ row: 1, cells: { A1: 'a' } }, { row: 2, cells: { A2: 'b' } }] }] })
    expect(result.message).toContain('调大 maxLines')
  })

  test('Given 表格 When mode=outline / stats Then 给出各表整表行列数与单元格类型分布', async () => {
    const file = writeXls('outline.xls', { 明细: [['城市', '金额'], ['北京', 1], ['上海', 2]], 汇总: [['合计']] })
    expect((await inspect(file, 'outline')).data).toEqual({
      fileName: 'outline.xls',
      format: 'Excel 97-2003',
      sheets: [{ name: '明细', rows: 3, cols: 2 }, { name: '汇总', rows: 1, cols: 1 }],
    })
    expect((await inspect(file, 'stats')).data).toEqual({
      sheets: 2, totalCells: 7, formulaCells: 0, errorCells: 0, dataTypeDistribution: { String: 5, Number: 2 },
    })
  })
})

describe('OfficeInspect 读旧版 .ppt', () => {
  test('Given 三页（一页无文字）When text / outline / stats Then 按页列文字、标题取首段、统计空页', async () => {
    const file = writePpt('deck.ppt', [['第一页标题', '要点一'], [], ['第三页']])
    const text = await inspect(file, 'text')
    expect(text.data).toBe(['## 幻灯片 1', '第一页标题', '要点一', '## 幻灯片 2', '（本页没有文字）', '## 幻灯片 3', '第三页'].join('\n'))
    expect(text.message).toContain('不含图片与版式')
    expect((await inspect(file, 'outline')).data).toEqual({
      fileName: 'deck.ppt',
      format: 'PowerPoint 97-2003',
      slides: [{ slide: 1, title: '第一页标题' }, { slide: 2, title: '' }, { slide: 3, title: '第三页' }],
    })
    expect((await inspect(file, 'stats')).data).toEqual({ slides: 3, paragraphs: 3, characters: 11, slidesWithoutText: 1 })
  })

  test('Given maxLines 限制 When mode=text Then 只列前几行并说明共多少行', async () => {
    const file = writePpt('long.ppt', [['一', '二', '三'], ['四']])
    const result = await inspect(file, 'text', 3)
    expect(result.data).toBe(['## 幻灯片 1', '一', '二'].join('\n'))
    expect(result.message).toContain('共 6 行，只列出前 3 行')
  })
})

describe('OfficeInspect 读旧版 .doc（word-extractor 的提取结果）', () => {
  const parts = { body: '标题\n正文第一段\n项目\t负责人\n预览\tCanopy\n', footnotes: '脚注' }

  test('Given 正文、表格行与脚注 When text / outline / stats Then 表格以制表符分隔，脚注接在正文后', () => {
    expect(inspectLegacyDocumentParts(parts, 'a.doc', 'text', 200).data).toBe('标题\n正文第一段\n项目\t负责人\n预览\tCanopy\n\n脚注')
    expect(inspectLegacyDocumentParts(parts, 'a.doc', 'outline', 200).data).toEqual({
      fileName: 'a.doc',
      format: 'Word 97-2003',
      paragraphs: 5,
      hasHeadersOrFooters: false,
      hasFootnotes: true,
      hasEndnotes: false,
      firstParagraphs: ['标题', '正文第一段', '项目\t负责人', '预览\tCanopy', '脚注'],
    })
    expect(inspectLegacyDocumentParts(parts, 'a.doc', 'stats', 200).data).toEqual({ paragraphs: 5, characters: 24, tableRows: 2 })
  })

  test('Given maxLines 限制 When mode=text Then 截断并提示', () => {
    const result = inspectLegacyDocumentParts(parts, 'a.doc', 'text', 2)
    expect(result.data).toBe('标题\n正文第一段')
    expect(result.message).toContain('只列出前 2 行')
  })
})

describe('Chat 附件：旧版表格 / 演示文稿转纯文本', () => {
  test('Given 表格 When 转纯文本 Then 每表一段、行内制表符分隔，格内的制表符与换行换成空格', async () => {
    const file = writeXls('attach.xls', { 明细: [['城市', '备注'], ['北京', `第一行\n第二行\t尾`]] })
    const text = await runLegacyOfficeTask({ type: 'plain-text', filePath: file, maxRowsPerSheet: 100, maxChars: 10_000 })
    expect(text).toBe(['## 工作表：明细（2 行 × 2 列）', '城市\t备注', '北京\t第一行 第二行 尾'].join('\n'))
  })

  test('Given 行数超过每表上限 When 转纯文本 Then 只列前 N 行并注明全表行数', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => [`第${index + 1}行`])
    const file = writeXls('rows.xls', { 大表: rows })
    const text = await runLegacyOfficeTask({ type: 'plain-text', filePath: file, maxRowsPerSheet: 5, maxChars: 10_000 }) as string
    expect(text.split('\n').slice(1, 6)).toEqual(['第1行', '第2行', '第3行', '第4行', '第5行'])
    expect(text).toContain('本表共 30 行，只列出前 5 行')
  })

  test('Given 内容超过字符上限 When 转纯文本 Then 截断并注明', async () => {
    const file = writePpt('chars.ppt', [['很长的一段文字'.repeat(20)]])
    const text = await runLegacyOfficeTask({ type: 'plain-text', filePath: file, maxRowsPerSheet: 100, maxChars: 30 }) as string
    expect(text.startsWith('## 幻灯片 1\n')).toBe(true)
    expect(text).toContain('只保留前 30 个字符')
  })
})

describe('坏文件与错误输入', () => {
  test('Given 扩展名是 .ppt / .xls 但文件损坏 When 解析 Then 报可理解的原因而不是解析库的原始报错', async () => {
    const fakePpt = join(dir, 'fake.ppt')
    writeFileSync(fakePpt, 'plain text')
    await expect(inspect(fakePpt, 'text')).rejects.toThrow(/无法解析这个 PowerPoint 97-2003 文件（可能已损坏、加密，或扩展名与实际格式不符）/)
    // 只有复合文档文件头、内容被截断
    const truncatedXls = join(dir, 'truncated.xls')
    writeFileSync(truncatedXls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]))
    await expect(inspect(truncatedXls, 'outline')).rejects.toThrow(/无法解析这个 Excel 97-2003 文件/)
  })

  test('Given 业务系统导出的「.xls」其实是 UTF-8 / GBK 文本表格 When 解析 Then 照常读出且中文不乱码', async () => {
    const expected = {
      sheets: [{ name: 'Sheet1', rows: [{ row: 1, cells: { A1: '城市', B1: '金额' } }, { row: 2, cells: { A2: '北京', B2: '12' } }] }],
    }
    const utf8Xls = join(dir, 'export-utf8.xls')
    writeFileSync(utf8Xls, '城市\t金额\n北京\t12\n')
    expect((await inspect(utf8Xls, 'text')).data).toEqual(expected)
    const gbkXls = join(dir, 'export-gbk.xls')
    // 「城市\t金额\n北京\t12\n」的 GBK 编码
    writeFileSync(gbkXls, Buffer.from([0xb3, 0xc7, 0xca, 0xd0, 0x09, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xb1, 0xb1, 0xbe, 0xa9, 0x09, 0x31, 0x32, 0x0a]))
    expect((await inspect(gbkXls, 'text')).data).toEqual(expected)
  })

  test('Given 非旧版格式 When 执行任务 Then 直接拒绝', async () => {
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    await expect(runLegacyOfficeTask({ type: 'plain-text', filePath: txt, maxRowsPerSheet: 1, maxChars: 1 })).rejects.toThrow(/不是旧版 Office 格式/)
  })
})
