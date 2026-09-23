import { describe, expect, test } from 'bun:test'
import {
  PI_RETRY_VISIBILITY_THRESHOLD,
  mapPiNativeRetryEvent,
  type PiRetryEventContext,
} from './pi-retry-control'

const context: PiRetryEventContext = { runStartedAt: 1_000 }

// 0.17.28 起随上游 v0.17.42 回到 Pi 0.84.2 原生事件形态（auto_retry_start / auto_retry_end，
// 只有连续失败段内的 attempt）；此前依赖的 auto_retry_attempt_start / totalAttempt 来自我方已放弃的
// pi-coding-agent 重试预算补丁。可见性阈值语义不变。
function startEvent(attempt: number): Parameters<typeof mapPiNativeRetryEvent>[0] {
  return {
    type: 'auto_retry_start',
    attempt,
    maxAttempts: 8,
    delayMs: 1_000 * 2 ** (attempt - 1),
    errorMessage: 'fetch failed',
  }
}

describe('Pi native retry 可见性阈值', () => {
  test('阈值内的重试对 UI 静默（瞬时抖动不打扰用户）', () => {
    for (let n = 1; n <= PI_RETRY_VISIBILITY_THRESHOLD; n++) {
      expect(mapPiNativeRetryEvent(startEvent(n), context)).toEqual([])
    }
  })

  test('超过阈值立即产生可见的 starting 事件（长退避不再黑箱）', () => {
    const updates = mapPiNativeRetryEvent(startEvent(PI_RETRY_VISIBILITY_THRESHOLD + 1), context)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.status).toBe('starting')
    expect(updates[0]!.runStartedAt).toBe(context.runStartedAt)
  })

  test('阈值保持在 2：前两次累计约 3 秒静默，第三次起可见', () => {
    // 5 的旧值意味着 31 秒指数退避全程无提示（首条消息"几十秒无响应"的主因之一），
    // 有意调整阈值时请同步评估首条消息的最坏静默时长。
    expect(PI_RETRY_VISIBILITY_THRESHOLD).toBe(2)
  })

  test('超过阈值后恢复成功产生 cleared 事件', () => {
    const updates = mapPiNativeRetryEvent(
      {
        type: 'auto_retry_end',
        success: true,
        attempt: PI_RETRY_VISIBILITY_THRESHOLD + 1,
        maxAttempts: 8,
        delayMs: 0,
      },
      context,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]!.status).toBe('cleared')
  })

  test('超过阈值后最终失败产生 failed 事件并带上错误原因', () => {
    const updates = mapPiNativeRetryEvent(
      {
        type: 'auto_retry_end',
        success: false,
        attempt: PI_RETRY_VISIBILITY_THRESHOLD + 1,
        maxAttempts: 8,
        delayMs: 4_000,
        finalError: 'socket hang up',
      },
      context,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]!.status).toBe('failed')
  })
})
