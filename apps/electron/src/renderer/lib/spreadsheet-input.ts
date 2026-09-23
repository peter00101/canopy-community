/**
 * 把表格文件的字节转成 SheetJS 的输入（界面预览的后台线程与主进程的旧版 Office 解析线程共用）。
 *
 * 真正的二进制表格（复合文档 .xls、zip 包 .xlsx、早期 BIFF 流）原样交给 SheetJS。
 * 业务系统常把 CSV / TSV / HTML 表格直接起名成 .xls，SheetJS 按单字节读会把中文读成乱码，
 * 所以文本内容先按 BOM → UTF-8 → GB18030 解码成字符串再交给它。
 */

export interface SpreadsheetReadInput {
  data: Uint8Array | string
  type: 'array' | 'string'
}

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

/** BIFF2~BIFF5 裸流以 BOF 记录开头：类型 0x0009 / 0x0209 / 0x0409 / 0x0809 */
function isRawBiffStream(bytes: Uint8Array): boolean {
  return bytes[0] === 0x09 && (bytes[1] === 0x00 || bytes[1] === 0x02 || bytes[1] === 0x04 || bytes[1] === 0x08)
}

export function spreadsheetReadInput(bytes: Uint8Array): SpreadsheetReadInput {
  if (startsWith(bytes, CFB_SIGNATURE) || startsWith(bytes, ZIP_SIGNATURE) || isRawBiffStream(bytes)) {
    return { data: bytes, type: 'array' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { data: new TextDecoder('utf-16le').decode(bytes.subarray(2)), type: 'string' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { data: new TextDecoder('utf-16be').decode(bytes.subarray(2)), type: 'string' }
  try {
    // TextDecoder 默认会吃掉 UTF-8 BOM
    return { data: new TextDecoder('utf-8', { fatal: true }).decode(bytes), type: 'string' }
  } catch {
    // 不是合法 UTF-8：国内系统导出的文本表格绝大多数是 GBK，GB18030 是它的超集
    return { data: new TextDecoder('gb18030').decode(bytes), type: 'string' }
  }
}
