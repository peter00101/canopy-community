import { describe, expect, test } from 'bun:test'
import { spreadsheetReadInput } from './spreadsheet-input'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
/** 「北京」的 GBK 编码 */
const GBK_BEIJING = [0xb1, 0xb1, 0xbe, 0xa9]

describe('表格文件字节 → SheetJS 输入', () => {
  test('Given 复合文档 .xls、zip 包 .xlsx、BIFF 裸流 When 转换 Then 原样按二进制交给 SheetJS', () => {
    const cfb = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00)
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14)
    const biff5 = bytes(0x09, 0x08, 0x08, 0x00)
    for (const input of [cfb, zip, biff5]) expect(spreadsheetReadInput(input)).toEqual({ data: input, type: 'array' })
  })

  test('Given 业务系统导出的 UTF-8 文本表格（带或不带 BOM）When 转换 Then 解码成字符串，中文不乱码', () => {
    expect(spreadsheetReadInput(utf8('城市\t金额\n北京\t12'))).toEqual({ data: '城市\t金额\n北京\t12', type: 'string' })
    expect(spreadsheetReadInput(bytes(0xef, 0xbb, 0xbf, ...utf8('北京')))).toEqual({ data: '北京', type: 'string' })
  })

  test('Given 不是合法 UTF-8 的 GBK 文本 When 转换 Then 按 GB18030 解码', () => {
    expect(spreadsheetReadInput(bytes(...GBK_BEIJING, 0x09, 0x31, 0x32))).toEqual({ data: '北京\t12', type: 'string' })
  })

  test('Given UTF-16 BOM When 转换 Then 按对应字节序解码并去掉 BOM', () => {
    expect(spreadsheetReadInput(bytes(0xff, 0xfe, 0x17, 0x53, 0xac, 0x4e))).toEqual({ data: '北京', type: 'string' })
    expect(spreadsheetReadInput(bytes(0xfe, 0xff, 0x53, 0x17, 0x4e, 0xac))).toEqual({ data: '北京', type: 'string' })
  })
})
