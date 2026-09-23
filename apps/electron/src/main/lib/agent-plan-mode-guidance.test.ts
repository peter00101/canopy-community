/**
 * 计划模式行动指引文案测试
 *
 * 钉住两件事：拦截文案必须带「重提 ExitPlanMode」行动指引（模型被拦后不再撞墙）；
 * 反馈包装必须含用户原文 + 同意语义的处理路径（「删了吧」→ 立即重提审批）。
 */

import { describe, test, expect } from 'bun:test'
import {
  PLAN_MODE_DENY_GUIDANCE,
  PLAN_MODE_WRITE_DENY_MESSAGE,
  buildExitPlanFeedbackMessage,
} from './agent-plan-mode-guidance'

describe('计划模式行动指引', () => {
  test('Given 写操作拦截文案 When 检查内容 Then 含重提 ExitPlanMode 的行动指引', () => {
    expect(PLAN_MODE_WRITE_DENY_MESSAGE).toContain('计划模式下不允许执行写操作')
    expect(PLAN_MODE_WRITE_DENY_MESSAGE).toContain('ExitPlanMode')
    expect(PLAN_MODE_DENY_GUIDANCE).toContain('ExitPlanMode')
    expect(PLAN_MODE_DENY_GUIDANCE).toContain('批准')
  })

  test('Given 用户反馈「删了吧」 When 包装为模型可见文本 Then 原文保留且含同意语义处理路径', () => {
    const message = buildExitPlanFeedbackMessage('删了吧')
    expect(message).toContain('删了吧')
    expect(message).toContain('同意/批准')
    expect(message).toContain('再次调用 ExitPlanMode')
    expect(message).toContain('不要在计划模式下直接尝试执行')
  })

  test('Given 反馈包装 When 检查口头批准指引 Then 同意路径带 userApproved、含糊路径明确禁止', () => {
    const message = buildExitPlanFeedbackMessage('执行')
    // 同意 → userApproved: true 直接获批；含糊 → 绝不可设置
    expect(message).toContain('userApproved: true')
    expect(message).toContain('直接获批')
    expect(message).toContain('绝不可设置 userApproved')
  })

  test('Given 反馈含多行与特殊字符 When 包装 Then 原文一字不差嵌入', () => {
    const feedback = '第一行\n第二行：改成 <plan-v3.md>'
    expect(buildExitPlanFeedbackMessage(feedback)).toContain(feedback)
  })
})
