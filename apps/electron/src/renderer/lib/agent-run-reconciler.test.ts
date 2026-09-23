import { describe, expect, test } from 'bun:test'
import { STALE_RUN_CONFIRM_ROUNDS, reconcileStaleRunningSessions } from './agent-run-reconciler'

describe('Agent 运行态对账（防终态事件丢失后的永久转圈）', () => {
  test('Given 本地在跑且后端也在跑, When 对账, Then 不判定卡死且连击清零', () => {
    const suspects = new Map([['s1', 1]])
    const result = reconcileStaleRunningSessions(['s1'], ['s1'], suspects)
    expect(result.staleSessions).toEqual([])
    expect(result.nextSuspects.size).toBe(0)
  })

  test('Given 后端首次缺席, When 对账, Then 只记连击不判定（防查询瞬间正常结束的竞态误杀）', () => {
    const result = reconcileStaleRunningSessions(['s1'], [], new Map())
    expect(result.staleSessions).toEqual([])
    expect(result.nextSuspects.get('s1')).toBe(1)
  })

  test('Given 连续两轮缺席, When 对账, Then 判定卡死且移出连击表', () => {
    const round1 = reconcileStaleRunningSessions(['s1'], [], new Map())
    const round2 = reconcileStaleRunningSessions(['s1'], [], round1.nextSuspects)
    expect(round2.staleSessions).toEqual(['s1'])
    expect(round2.nextSuspects.has('s1')).toBe(false)
  })

  test('Given 缺席一轮后恢复, When 再次缺席, Then 连击从头计不判定', () => {
    const round1 = reconcileStaleRunningSessions(['s1'], [], new Map())
    const round2 = reconcileStaleRunningSessions(['s1'], ['s1'], round1.nextSuspects)
    expect(round2.nextSuspects.size).toBe(0)
    const round3 = reconcileStaleRunningSessions(['s1'], [], round2.nextSuspects)
    expect(round3.staleSessions).toEqual([])
    expect(round3.nextSuspects.get('s1')).toBe(1)
  })

  test('Given 会话已不在本地 running, When 对账, Then 旧连击被丢弃', () => {
    const suspects = new Map([['gone', STALE_RUN_CONFIRM_ROUNDS - 1]])
    const result = reconcileStaleRunningSessions([], [], suspects)
    expect(result.staleSessions).toEqual([])
    expect(result.nextSuspects.size).toBe(0)
  })

  test('Given 多会话混合状态, When 对账, Then 各会话独立判定', () => {
    const suspects = new Map([['stale', 1], ['recovered', 1]])
    const result = reconcileStaleRunningSessions(
      ['stale', 'recovered', 'fresh'],
      ['recovered', 'other-backend-run'],
      suspects,
    )
    expect(result.staleSessions).toEqual(['stale'])
    expect(result.nextSuspects.get('fresh')).toBe(1)
    expect(result.nextSuspects.has('recovered')).toBe(false)
  })

  test('Given 后端返回含 automation 等额外会话, When 对账, Then 不影响本地判定', () => {
    const result = reconcileStaleRunningSessions(['s1'], ['s1', 'headless-a', 'headless-b'], new Map())
    expect(result.staleSessions).toEqual([])
    expect(result.nextSuspects.size).toBe(0)
  })
})
