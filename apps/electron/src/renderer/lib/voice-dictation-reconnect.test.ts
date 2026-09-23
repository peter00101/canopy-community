import { describe, expect, test } from 'bun:test'
import {
  ASR_RECONNECT_DELAYS_MS,
  buildAsrReconnectGiveUpMessage,
  createAsrReconnectState,
  markAsrHealthy,
  planAsrReconnect,
} from './voice-dictation-reconnect'

describe('ASR 自动重连保险丝', () => {
  test('Given 首次被服务端关闭 When 决策 Then 立即重连（保住 VAD 静音超时这类正常场景的无感重连）', () => {
    const decision = planAsrReconnect(createAsrReconnectState())
    expect(decision).toEqual({ action: 'reconnect', delayMs: 0, attempt: 1, next: { attempts: 1 } })
  })

  test('Given 连续被关闭 When 逐次决策 Then 等待时间按表递增，直到超过上限才放弃', () => {
    let state = createAsrReconnectState()
    const delays: number[] = []
    for (;;) {
      const decision = planAsrReconnect(state)
      if (decision.action === 'give-up') {
        expect(decision.attempts).toBe(ASR_RECONNECT_DELAYS_MS.length)
        break
      }
      delays.push(decision.delayMs)
      state = decision.next
    }
    expect(delays).toEqual([...ASR_RECONNECT_DELAYS_MS])
    // 5 次重连累计等待 7.5s，之后放弃——不再有「每秒死循环」
    expect(delays.reduce((sum, d) => sum + d, 0)).toBe(7500)
  })

  test('Given 中途收到识别结果（健康信号） When 计数清零 Then 下一次关闭又从立即重连开始', () => {
    let state = createAsrReconnectState()
    for (let i = 0; i < 3; i++) {
      const decision = planAsrReconnect(state)
      if (decision.action !== 'reconnect') throw new Error('前三次应仍可重连')
      state = decision.next
    }
    expect(state.attempts).toBe(3)
    state = markAsrHealthy(state)
    expect(planAsrReconnect(state)).toMatchObject({ action: 'reconnect', delayMs: 0, attempt: 1 })
  })

  test('Given 放弃重连 When 生成文案 Then 说明次数与排查方向', () => {
    const message = buildAsrReconnectGiveUpMessage(5)
    expect(message).toContain('5 次')
    expect(message).toContain('凭证')
  })
})
