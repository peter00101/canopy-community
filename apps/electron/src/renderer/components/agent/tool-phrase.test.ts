/**
 * 工具行结果摘要测试（计划审批文案特判）
 *
 * ExitPlanMode 的 error 只有「用户拒绝 / 用户提修改意见 / 中止」三种来源，
 * 全是正常的用户决策；显示成「失败」曾让提意见的维护者以为发送失败。
 */

import { describe, test, expect } from 'bun:test'
import { getToolResultSummary, isPlanDecisionError } from './tool-phrase'

describe('getToolResultSummary 计划审批特判', () => {
  test('Given ExitPlanMode 的 error 结果 When 取摘要 Then 显示「计划未获批准」而非「失败」', () => {
    expect(getToolResultSummary('ExitPlanMode', '用户要求修改计划', true)).toBe('计划未获批准')
  })

  test('Given 其他工具的 error 结果 When 取摘要 Then 仍显示「失败」', () => {
    expect(getToolResultSummary('Bash', 'command not found', true)).toBe('失败')
    expect(getToolResultSummary('Read', 'no such file', true)).toBe('失败')
  })

  test('Given ExitPlanMode 正常结果 When 取摘要 Then 不受特判影响', () => {
    expect(getToolResultSummary('ExitPlanMode', '计划已获批准，可以继续执行。', false)).toBeNull()
  })

  test('Given 工具名 When 判定是否用户决策型 error Then 仅 ExitPlanMode 命中', () => {
    expect(isPlanDecisionError('ExitPlanMode')).toBe(true)
    expect(isPlanDecisionError('EnterPlanMode')).toBe(false)
    expect(isPlanDecisionError('Bash')).toBe(false)
  })
})
