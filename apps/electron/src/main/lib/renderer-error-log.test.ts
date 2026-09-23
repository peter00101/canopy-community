/**
 * 根级错误边界日志转发（renderer-error-log）的 BDD 测试。
 *
 * 守住：只转「level 为 error 且以 [RootErrorBoundary] 开头」的 console 消息；前缀与渲染层同源；
 * 监听按 Electron 43 的事件对象形式取 level / message（位置参数已废弃，数字 level 不作数）。
 */

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { buildRootErrorLogMessage, ROOT_ERROR_LOG_PREFIX } from '../../renderer/lib/render-error-report'
import {
  formatRendererErrorLogDetail,
  forwardRootErrorBoundaryLogs,
  isRootErrorBoundaryConsoleMessage,
  MAX_RENDERER_ERROR_DETAIL_CHARS,
  RENDERER_ERROR_CRASH_KIND,
} from './renderer-error-log'
import type { ConsoleMessageSource } from './renderer-error-log'

const BOUNDARY_MESSAGE = `${ROOT_ERROR_LOG_PREFIX} 界面渲染异常（窗口：main）\nCanopy 界面错误报告\n错误：TypeError: boom`

describe('isRootErrorBoundaryConsoleMessage：哪些 console 消息转进 crash 日志', () => {
  test('给定 level 为 error 且以 [RootErrorBoundary] 开头 当判定 则转发', () => {
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error', message: BOUNDARY_MESSAGE })).toBe(true)
  })

  test.each(['info', 'warning', 'debug'])('给定带前缀但 level 为 %s 当判定 则不转发', (level) => {
    expect(isRootErrorBoundaryConsoleMessage({ level, message: BOUNDARY_MESSAGE })).toBe(false)
  })

  test('给定 level 为 error 但不是根边界的日志 当判定 则不转发', () => {
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error', message: '[用量统计] 获取失败: Error: x' })).toBe(false)
  })

  test('给定前缀出现在消息中间而非开头 当判定 则不转发', () => {
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error', message: `别的模块转述 ${ROOT_ERROR_LOG_PREFIX} 的日志` })).toBe(false)
  })

  test('给定事件对象缺 message、message 不是字符串或整个为空 当判定 则不转发也不抛错', () => {
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error' })).toBe(false)
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error', message: 42 as unknown as string })).toBe(false)
    expect(isRootErrorBoundaryConsoleMessage(undefined)).toBe(false)
    expect(isRootErrorBoundaryConsoleMessage(null)).toBe(false)
  })

  test('给定渲染层 RootErrorBoundary 实际打出的日志文本 当判定 则转发（前缀两端同源不漂移）', () => {
    const message = buildRootErrorLogMessage({ error: new TypeError('avatar.startsWith is not a function'), scope: 'quick-task' })
    expect(isRootErrorBoundaryConsoleMessage({ level: 'error', message })).toBe(true)
  })
})

describe('formatRendererErrorLogDetail：crash 日志正文', () => {
  test('给定窗口标识与消息 当生成正文 则以 window=<窗口> 开头并保留原消息', () => {
    expect(formatRendererErrorLogDetail('workspace-memory', BOUNDARY_MESSAGE)).toBe(`window=workspace-memory ${BOUNDARY_MESSAGE}`)
  })

  test('给定超出上限的消息 当生成正文 则截断到上限并注明原文长度', () => {
    const long = `${ROOT_ERROR_LOG_PREFIX} ${'x'.repeat(MAX_RENDERER_ERROR_DETAIL_CHARS * 2)}`
    const detail = formatRendererErrorLogDetail('main', long)
    expect(detail.startsWith(`window=main ${ROOT_ERROR_LOG_PREFIX}`)).toBe(true)
    expect(detail).toContain(`（已截断，原文 ${long.length} 字符）`)
    expect(detail.length).toBeLessThan(MAX_RENDERER_ERROR_DETAIL_CHARS + 100)
  })
})

describe('forwardRootErrorBoundaryLogs：挂在窗口 webContents 上', () => {
  function setup(windowLabel: string): { contents: EventEmitter; calls: [string, unknown][] } {
    const contents = new EventEmitter()
    const calls: [string, unknown][] = []
    forwardRootErrorBoundaryLogs(contents as unknown as ConsoleMessageSource, windowLabel, (kind, detail) => {
      calls.push([kind, detail])
    })
    return { contents, calls }
  }

  test('给定根边界打出错误日志 当 webContents 按 Electron 43 形式发出 console-message 则以 renderer-error 记一条', () => {
    const { contents, calls } = setup('main')

    // Electron 43：第一个参数是事件对象，后面仍附带已废弃的位置参数（数字 level = 3 表示 error）
    contents.emit('console-message', { level: 'error', message: BOUNDARY_MESSAGE, lineNumber: 12, sourceId: 'file:///index.js' }, 3, BOUNDARY_MESSAGE, 12, 'file:///index.js')

    expect(calls).toEqual([[RENDERER_ERROR_CRASH_KIND, `window=main ${BOUNDARY_MESSAGE}`]])
    expect(RENDERER_ERROR_CRASH_KIND).toBe('renderer-error')
  })

  test('给定普通 console.error、info 级别的带前缀日志 当发出 console-message 则一条都不记', () => {
    const { contents, calls } = setup('quick-task')

    contents.emit('console-message', { level: 'error', message: '[AgentSettings] 加载失败' }, 3, '[AgentSettings] 加载失败', 1, '')
    contents.emit('console-message', { level: 'info', message: BOUNDARY_MESSAGE }, 1, BOUNDARY_MESSAGE, 1, '')

    expect(calls).toEqual([])
  })

  test('给定只有旧式位置参数（事件对象里没有 level 字符串） 当发出 console-message 则不按数字 level 误判', () => {
    const { contents, calls } = setup('detached-preview')

    contents.emit('console-message', {}, 3, BOUNDARY_MESSAGE, 1, '')

    expect(calls).toEqual([])
  })
})
