import { describe, expect, test } from 'bun:test'
import {
  UTILITY_PROCESS_START_CANCELLED_CODE,
  UTILITY_PROCESS_START_RETRY_DELAYS_MS,
  isRetryableUtilityProcessStartupError,
  isUtilityProcessStartupCancelledError,
  startUtilityProcessWithRetry,
} from './utility-process-startup'

describe('utility 进程启动重试（收上游 #2074）', () => {
  test('Given Windows 同步 ENOTCONN When 启动重试 Then 按 25/100 退避并返回成功进程', async () => {
    let attempts = 0
    const delays: number[] = []

    const result = await startUtilityProcessWithRetry(() => {
      attempts++
      if (attempts < 3) {
        const error = new Error('read ENOTCONN') as Error & { code: string }
        error.code = 'ENOTCONN'
        throw error
      }
      return 'started'
    }, {
      platform: 'win32',
      sleep: async (milliseconds) => { delays.push(milliseconds) },
    })

    expect(result).toBe('started')
    expect(attempts).toBe(3)
    expect(delays).toEqual([...UTILITY_PROCESS_START_RETRY_DELAYS_MS])
  })

  test('Given 退避次数用尽 When 仍然 ENOTCONN Then 抛出原始错误而不是取消错误', async () => {
    const error = new Error('read ENOTCONN') as Error & { code: string }
    error.code = 'ENOTCONN'
    let attempts = 0

    await expect(startUtilityProcessWithRetry(() => {
      attempts++
      throw error
    }, {
      platform: 'win32',
      sleep: async () => {},
    })).rejects.toBe(error)

    // 首次 + 两次重试 = 3 次，与退避表长度一致
    expect(attempts).toBe(UTILITY_PROCESS_START_RETRY_DELAYS_MS.length + 1)
  })

  test('Given Windows ENOTCONN 退避期间被停止 When 再次启动 Then 返回显式取消错误并带原因', async () => {
    let shouldContinue = true
    const error = new Error('read ENOTCONN') as Error & { code: string }
    error.code = 'ENOTCONN'

    await expect(startUtilityProcessWithRetry(() => {
      throw error
    }, {
      platform: 'win32',
      shouldContinue: () => shouldContinue,
      sleep: async () => { shouldContinue = false },
    })).rejects.toMatchObject({
      code: UTILITY_PROCESS_START_CANCELLED_CODE,
      cause: error,
    })
  })

  test('Given 启动前就已被停止 When 调用 Then 一次都不 fork，直接取消', async () => {
    let started = 0

    let caught: unknown
    try {
      await startUtilityProcessWithRetry(() => {
        started++
        return 'started'
      }, { platform: 'win32', shouldContinue: () => false })
    } catch (error) {
      caught = error
    }

    expect(isUtilityProcessStartupCancelledError(caught)).toBe(true)
    expect(started).toBe(0)
  })

  test('Given 非 Windows 平台或非 ENOTCONN When 启动失败 Then 不重试', async () => {
    const enotconn = new Error('read ENOTCONN') as Error & { code: string }
    enotconn.code = 'ENOTCONN'

    expect(isRetryableUtilityProcessStartupError(enotconn, 'darwin')).toBe(false)
    expect(isRetryableUtilityProcessStartupError(new Error('other failure'), 'win32')).toBe(false)

    // mac 上同样的错误必须一次就抛出，不能白等退避
    let attempts = 0
    await expect(startUtilityProcessWithRetry(() => {
      attempts++
      throw enotconn
    }, { platform: 'darwin', sleep: async () => {} })).rejects.toBe(enotconn)
    expect(attempts).toBe(1)
  })

  test('Given 错误只在 message 里带 ENOTCONN When 判定 Then 仍按可重试处理', () => {
    expect(isRetryableUtilityProcessStartupError(new Error('spawn failed: read ENOTCONN'), 'win32')).toBe(true)
    // 词边界：避免把 ENOTCONNECTED 之类的别的错误误判成可重试
    expect(isRetryableUtilityProcessStartupError(new Error('ENOTCONNECTED'), 'win32')).toBe(false)
  })

  test('Given 首次即成功 When 启动 Then 不产生任何退避等待', async () => {
    const delays: number[] = []
    const result = await startUtilityProcessWithRetry(() => 'ok', {
      platform: 'win32',
      sleep: async (ms) => { delays.push(ms) },
    })

    expect(result).toBe('ok')
    expect(delays).toEqual([])
  })
})
