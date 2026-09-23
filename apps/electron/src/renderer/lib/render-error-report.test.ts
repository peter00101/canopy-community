import { describe, expect, test } from 'bun:test'
import {
  buildRenderErrorReport,
  buildRootErrorLogMessage,
  describeRenderError,
  formatRenderErrorHeadline,
  formatReportTimestamp,
  ROOT_ERROR_LOG_PREFIX,
} from './render-error-report'

describe('界面渲染错误摘要', () => {
  test('给定标准 Error 当整理摘要 则保留类型、说明与堆栈', () => {
    const error = new TypeError('avatar.startsWith is not a function')
    const summary = describeRenderError(error)
    expect(summary.name).toBe('TypeError')
    expect(summary.message).toBe('avatar.startsWith is not a function')
    expect(summary.stack).toContain('avatar.startsWith is not a function')
    expect(formatRenderErrorHeadline(summary)).toBe('TypeError: avatar.startsWith is not a function')
  })

  test.each([
    ['null', null, '未知错误（抛出值为 null）'],
    ['undefined', undefined, '未知错误（抛出值为 undefined）'],
    ['字符串', '  出错了  ', '出错了'],
    ['空字符串', '', '未知错误（抛出空字符串）'],
    ['带 message 的普通对象', { message: '对象错误' }, '对象错误'],
    ['普通对象', { code: 500 }, '{"code":500}'],
    ['数字', 404, '404'],
  ])('给定抛出值为%s 当整理摘要 则给出可读一行说明', (_label, value, expected) => {
    expect(describeRenderError(value).message).toBe(expected)
  })

  test('给定 toString 与 JSON 序列化都会抛错的对象 当整理摘要 则不抛错并给兜底说明', () => {
    const hostile = {
      toJSON() { throw new Error('no json') },
      toString() { throw new Error('no string') },
    }
    let message = ''
    expect(() => { message = describeRenderError(hostile).message }).not.toThrow()
    expect(message).toBe('未知错误（抛出了无法描述的对象）')
  })

  test('给定 message 读取会抛错的 Error 当整理摘要 则不抛错', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'message', { get() { throw new Error('boom') } })
    expect(() => describeRenderError(error)).not.toThrow()
    expect(describeRenderError(error).message).toBe('未知错误（错误信息无法读取）')
  })
})

describe('界面错误报告文本', () => {
  test('给定错误与组件堆栈 当生成报告 则包含品牌、版本、窗口、message、stack 与 componentStack', () => {
    const error = new TypeError('avatar.startsWith is not a function')
    error.stack = 'TypeError: avatar.startsWith is not a function\n    at isImageUrl (UserAvatar.tsx:25:17)'
    const report = buildRenderErrorReport({
      error,
      componentStack: '\n    at UserAvatar\n    at LeftSidebar',
      appVersion: '0.18.99',
      scope: 'main',
      occurredAt: new Date(2026, 8, 17, 9, 5, 3),
    })
    expect(report.startsWith('Canopy 界面错误报告')).toBe(true)
    expect(report).toContain('版本：0.18.99')
    expect(report).toContain('窗口：main')
    expect(report).toContain('时间：2026-09-17 09:05:03 ')
    expect(report).toContain('错误：TypeError: avatar.startsWith is not a function')
    expect(report).toContain('at isImageUrl (UserAvatar.tsx:25:17)')
    expect(report).toContain('at UserAvatar\n    at LeftSidebar')
    expect(report).not.toMatch(/pr[o]ma/i)
  })

  test('给定没有堆栈也没有组件堆栈 当生成报告 则对应段落标注（无）', () => {
    const report = buildRenderErrorReport({ error: 'plain', occurredAt: new Date(2026, 0, 1) })
    expect(report).toContain('错误堆栈：\n（无）')
    expect(report).toContain('组件堆栈：\n（无）')
    expect(report).not.toContain('版本：')
  })

  test('给定本地时间 当格式化时间戳 则为带时区偏移的本地时间', () => {
    expect(formatReportTimestamp(new Date(2026, 8, 17, 23, 59, 58))).toMatch(
      /^2026-09-17 23:59:58 [+-]\d{2}:\d{2}$/,
    )
    expect(formatReportTimestamp(new Date(Number.NaN))).toBe('未知时间')
  })
})

describe('根级边界写进 console 的日志文本', () => {
  test('给定错误与组件堆栈 当生成日志文本 则以固定前缀开头，并带窗口、错误、堆栈与组件堆栈', () => {
    const error = new TypeError('avatar.startsWith is not a function')
    error.stack = 'TypeError: avatar.startsWith is not a function\n    at isImageUrl (UserAvatar.tsx:25:17)'
    const message = buildRootErrorLogMessage({
      error,
      componentStack: '\n    at UserAvatar\n    at LeftSidebar',
      scope: 'quick-task',
      appVersion: '0.18.99',
      occurredAt: new Date(2026, 8, 17, 9, 5, 3),
    })

    expect(ROOT_ERROR_LOG_PREFIX).toBe('[RootErrorBoundary]')
    expect(message.startsWith('[RootErrorBoundary] 界面渲染异常（窗口：quick-task）\n')).toBe(true)
    expect(message).toContain('版本：0.18.99')
    expect(message).toContain('错误：TypeError: avatar.startsWith is not a function')
    expect(message).toContain('at isImageUrl (UserAvatar.tsx:25:17)')
    expect(message).toContain('at UserAvatar\n    at LeftSidebar')
  })

  test('给定没有窗口标识、抛出值为 null 当生成日志文本 则不抛错，窗口记为 unknown', () => {
    let message = ''
    expect(() => { message = buildRootErrorLogMessage({ error: null }) }).not.toThrow()
    expect(message.startsWith('[RootErrorBoundary] 界面渲染异常（窗口：unknown）')).toBe(true)
    expect(message).toContain('未知错误（抛出值为 null）')
  })
})
