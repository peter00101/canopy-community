import { describe, expect, test } from 'bun:test'
import { formatLocalDate, formatLocalTimestamp } from './crash-guard'

describe('崩溃日志的本地时间格式化', () => {
  test('Given 本地时间 2026-08-16 07:30 When 生成日志文件日期 Then 是本地的 08-16 而不是 UTC 日期', () => {
    // 用本地时区分量构造：无论测试机在哪个时区，这个 Date 的「本地日期」都是 08-16
    const crashedAt = new Date(2026, 7, 16, 7, 30, 0)

    expect(formatLocalDate(crashedAt)).toBe('2026-08-16')
  })

  test('Given 东八区早 8 点前的时刻 When 对比 UTC 写法 Then 旧写法会记进前一天（问题成立的前提）', () => {
    const crashedAt = new Date(2026, 7, 16, 7, 30, 0)
    const utcDay = crashedAt.toISOString().slice(0, 10)
    const localDay = formatLocalDate(crashedAt)

    // 只在 UTC+8 及以东的机器上两者才不同；其它时区跑到这里直接跳过断言，避免假红
    if (-crashedAt.getTimezoneOffset() >= 8 * 60) {
      expect(utcDay).toBe('2026-08-15')
      expect(localDay).toBe('2026-08-16')
    } else {
      expect(localDay).toBe('2026-08-16')
    }
  })

  test('Given 月/日/时/分/秒/毫秒都是个位数 When 格式化 Then 全部补零', () => {
    const at = new Date(2026, 0, 5, 3, 4, 5, 6)

    expect(formatLocalDate(at)).toBe('2026-01-05')
    expect(formatLocalTimestamp(at).startsWith('2026-01-05 03:04:05.006 ')).toBe(true)
  })

  test('Given 任意时刻 When 生成行内时间戳 Then 带显式时区偏移且日期段与文件名日期一致', () => {
    const at = new Date(2026, 7, 16, 23, 59, 59, 999)
    const stamp = formatLocalTimestamp(at)

    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/)
    expect(stamp.slice(0, 10)).toBe(formatLocalDate(at))

    // 偏移量必须与运行时一致（东八区应为 +08:00）
    const offsetMinutes = -at.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMinutes)
    const expectedOffset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(stamp.endsWith(expectedOffset)).toBe(true)
  })
})
