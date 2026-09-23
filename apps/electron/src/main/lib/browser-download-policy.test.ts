import { describe, expect, test } from 'bun:test'
import {
  MAX_BROWSER_DOWNLOAD_BYTES,
  buildPdfExportFilename,
  resolveUniqueFilename,
  sanitizeDownloadFilename,
  shouldCancelDownload,
} from './browser-download-policy'

describe('浏览器下载文件名消毒', () => {
  test('Given 含路径分隔与穿越串的文件名 When 消毒 Then 不再含分隔符与上级引用', () => {
    const sanitized = sanitizeDownloadFilename('..\\..\\evil/name.txt', 1)
    expect(sanitized).not.toContain('..')
    expect(sanitized).not.toContain('/')
    expect(sanitized).not.toContain('\\')
    expect(sanitizeDownloadFilename('../../etc/passwd', 1)).not.toContain('..')
    expect(sanitizeDownloadFilename('a/b\\c:d.txt', 1)).toBe('a_b_c_d.txt')
  })

  test('Given 空名或纯点串 When 消毒 Then 回退到带时间戳的兜底名', () => {
    expect(sanitizeDownloadFilename('', 42)).toBe('download-42')
    expect(sanitizeDownloadFilename('...', 42)).toBe('download-42')
    expect(sanitizeDownloadFilename('   ', 42)).toBe('download-42')
  })

  test('Given Windows 保留设备名 When 消毒 Then 加前缀避开', () => {
    expect(sanitizeDownloadFilename('con', 1)).toBe('_con')
    expect(sanitizeDownloadFilename('CON.txt', 1)).toBe('_CON.txt')
    expect(sanitizeDownloadFilename('aux.tar.gz', 1)).toBe('_aux.tar.gz')
  })

  test('Given 超长文件名 When 消毒 Then 截断至上限且保留扩展名', () => {
    const longName = 'a'.repeat(300) + '.pdf'
    const result = sanitizeDownloadFilename(longName, 1)
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith('.pdf')).toBe(true)
  })

  test('Given 截断点恰好落在空格或点上 When 消毒 Then 主体末尾不留空格/点（Win32 访问不到这类名字）', () => {
    // 第 120 位是空格：旧实现会产出以空格结尾的 120 字符名，资源管理器打不开也删不掉
    const spaceAt120 = 'a'.repeat(119) + ' ' + 'b'.repeat(20)
    const withSpace = sanitizeDownloadFilename(spaceAt120, 1)
    expect(withSpace.length).toBeLessThanOrEqual(120)
    expect(withSpace).toBe('a'.repeat(119))

    // 第 120 位是点
    const dotAt120 = 'x'.repeat(119) + '.' + 'y'.repeat(30)
    const withDot = sanitizeDownloadFilename(dotAt120, 1)
    expect(withDot).toBe('x'.repeat(119))

    // 带扩展名时截断点落在单个内部点之后，不能拼出 "name..pdf"
    const dotBeforeExt = 'r'.repeat(115) + '.' + 'z'.repeat(50) + '.pdf'
    const result = sanitizeDownloadFilename(dotBeforeExt, 1)
    expect(result.endsWith('.pdf')).toBe(true)
    expect(result).not.toContain('..')
    expect(result.slice(0, -4)).not.toMatch(/[\s.]$/)
  })

  test('Given 含控制字符的文件名 When 消毒 Then 控制字符被移除', () => {
    expect(sanitizeDownloadFilename('re\u0000po\u001frt.csv', 1)).toBe('report.csv')
  })
})

describe('浏览器下载重名处理', () => {
  test('Given 无同名文件 When 求唯一名 Then 原名返回', () => {
    expect(resolveUniqueFilename('report.pdf', () => false)).toBe('report.pdf')
  })

  test('Given 已有同名与 (1) 版本 When 求唯一名 Then 返回 (2) 版本', () => {
    const existing = new Set(['report.pdf', 'report (1).pdf'])
    expect(resolveUniqueFilename('report.pdf', (c) => existing.has(c))).toBe('report (2).pdf')
  })

  test('Given 无扩展名文件冲突 When 求唯一名 Then 序号直接附在末尾', () => {
    const existing = new Set(['LICENSE'])
    expect(resolveUniqueFilename('LICENSE', (c) => existing.has(c))).toBe('LICENSE (1)')
  })
})

describe('导出 PDF 文件名', () => {
  test('Given 正常页面标题 When 生成 Then 以标题命名并附 .pdf', () => {
    expect(buildPdfExportFilename('季度财报 - 腾讯网', 1)).toBe('季度财报 - 腾讯网.pdf')
  })

  test('Given 标题本身以 .pdf 结尾 When 生成 Then 不重复扩展名', () => {
    expect(buildPdfExportFilename('report.pdf', 1)).toBe('report.pdf')
  })

  test('Given 空标题 When 生成 Then 回退到 download 兜底名', () => {
    expect(buildPdfExportFilename('', 7)).toBe('download-7.pdf')
  })
})

describe('下载大小上限', () => {
  test('Given 声明总量超 1GB When 判定 Then 取消', () => {
    expect(shouldCancelDownload(0, MAX_BROWSER_DOWNLOAD_BYTES + 1)).toBe(true)
  })

  test('Given 未声明总量但接收超限 When 判定 Then 取消', () => {
    expect(shouldCancelDownload(MAX_BROWSER_DOWNLOAD_BYTES + 1, 0)).toBe(true)
  })

  test('Given 正常大小 When 判定 Then 放行', () => {
    expect(shouldCancelDownload(1024, 4096)).toBe(false)
    expect(shouldCancelDownload(0, 0)).toBe(false)
  })
})
