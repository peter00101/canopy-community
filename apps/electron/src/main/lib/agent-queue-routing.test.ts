import { describe, expect, test } from 'bun:test'
import { isStaleActiveQueueError, shouldRouteAsExitPlanFeedback } from './agent-queue-routing'

describe('计划审批挂起时主输入框消息转反馈判定', () => {
  const base = { dispatch: 'now' as const, sessionActive: true, hasPendingExitPlan: true, rawText: '删除他' }

  test('Given 审批挂起且会话活跃 When 立即发送 Then 转为审批反馈（不打断不排队）', () => {
    expect(shouldRouteAsExitPlanFeedback(base)).toBe(true)
  })

  test('Given 用户显式选择排队（after_current） When 判定 Then 尊重排队语义不转反馈', () => {
    expect(shouldRouteAsExitPlanFeedback({ ...base, dispatch: 'after_current' })).toBe(false)
  })

  test('Given 无挂起审批 When 判定 Then 走正常发送路由', () => {
    expect(shouldRouteAsExitPlanFeedback({ ...base, hasPendingExitPlan: false })).toBe(false)
  })

  test('Given 会话已不活跃（审批残留） When 判定 Then 不转反馈，交由失效兜底处理', () => {
    expect(shouldRouteAsExitPlanFeedback({ ...base, sessionActive: false })).toBe(false)
  })

  test('Given 空白文本 When 判定 Then 不转反馈', () => {
    expect(shouldRouteAsExitPlanFeedback({ ...base, rawText: '   ' })).toBe(false)
  })
})

describe('陈旧活跃通道错误判定（上游 #1787：注入失败转 deferred queue 而非报错）', () => {
  test('Given 带 code agent.query.not_active 的错误对象 When 判定 Then 视为陈旧通道错误', () => {
    expect(isStaleActiveQueueError({ code: 'agent.query.not_active' })).toBe(true)
  })

  test('Given Error 携带主进程四种「会话未运行」类消息 When 判定 Then 全部视为陈旧通道错误', () => {
    expect(isStaleActiveQueueError(new Error('会话未运行，无法追加消息'))).toBe(true)
    expect(isStaleActiveQueueError(new Error('无活跃消息通道可注入队列消息'))).toBe(true)
    expect(isStaleActiveQueueError(new Error('当前会话没有正在运行的 Agent'))).toBe(true)
    expect(isStaleActiveQueueError(new Error('Agent session is not active'))).toBe(true)
  })

  test('Given 与运行态无关的普通错误 When 判定 Then 不吞掉，按真实发送失败处理', () => {
    expect(isStaleActiveQueueError(new Error('网络连接超时'))).toBe(false)
    expect(isStaleActiveQueueError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false)
  })

  test('Given 非对象错误（null/undefined/数字） When 判定 Then 安全返回 false 不抛异常', () => {
    expect(isStaleActiveQueueError(null)).toBe(false)
    expect(isStaleActiveQueueError(undefined)).toBe(false)
    expect(isStaleActiveQueueError(42)).toBe(false)
  })

  test('Given 字符串形式抛出的错误文本含关键消息 When 判定 Then 经 String() 兜底仍能识别', () => {
    expect(isStaleActiveQueueError('会话未运行，无法追加消息')).toBe(true)
  })
})
