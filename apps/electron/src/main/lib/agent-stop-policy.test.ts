import { describe, expect, test } from 'bun:test'
import { shouldStopBeforeAgentRun } from './agent-stop-policy'

describe('预运行窗口的 stop 记忆判定（上游 #1784）', () => {
  test('Given 会话已预留槽位但 run 尚未到达 orchestrator When 收到 stop Then 判定须记住这次 stop', () => {
    expect(shouldStopBeforeAgentRun(true, false)).toBe(true)
  })

  test('Given deferred queue 正在派发排队消息 When 收到 stop Then 判定须记住这次 stop', () => {
    expect(shouldStopBeforeAgentRun(false, true)).toBe(true)
  })

  test('Given 既无预留槽位也无队列派发（run 已真实活跃或根本没有 run） When 收到 stop Then 不需要预记 stop', () => {
    expect(shouldStopBeforeAgentRun(false, false)).toBe(false)
  })

  test('Given 预留与派发同时成立 When 收到 stop Then 仍判定须记住', () => {
    expect(shouldStopBeforeAgentRun(true, true)).toBe(true)
  })
})
