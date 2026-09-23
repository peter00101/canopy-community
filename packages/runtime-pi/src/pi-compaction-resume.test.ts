import { describe, expect, test } from 'bun:test'
import {
  PI_COMPACTION_CONTINUATION_PROMPT,
  PI_FINAL_OUTPUT_CONTINUATION_PROMPT,
  assistantEndsWithTrailingText,
  planPiCompactionContinuation,
  planPiFinalOutputContinuation,
  shouldResumeAfterAutoCompaction,
} from './pi-agent-adapter'

describe('自动压缩后续跑判定（压缩上下文后不继续的修复）', () => {
  const successEvent = {
    reason: 'threshold' as const,
    aborted: false,
    willRetry: false,
    hasResult: true,
  }

  test('Given 已完成 turn 后的 threshold 自动压缩成功 When 判定 Then 需要注入续跑（bug 场景本尊）', () => {
    expect(shouldResumeAfterAutoCompaction(successEvent, true)).toBe(true)
  })

  test('Given overflow 压缩且响应已完成（willRetry=false） When 判定 Then 需要续跑（Pi 明说 continue 不了 completed 响应）', () => {
    expect(shouldResumeAfterAutoCompaction({ ...successEvent, reason: 'overflow' }, true)).toBe(true)
  })

  test('Given 手动压缩或 CompactContext 工具（reason=manual） When 判定 Then 不续跑（前者语义即止步，后者自带续跑链防双重注入）', () => {
    expect(shouldResumeAfterAutoCompaction({ ...successEvent, reason: 'manual' }, true)).toBe(false)
  })

  test('Given overflow 中断恢复（willRetry=true） When 判定 Then 不续跑（Pi 自己会 agent.continue）', () => {
    expect(shouldResumeAfterAutoCompaction({ ...successEvent, reason: 'overflow', willRetry: true }, true)).toBe(false)
  })

  test('Given 压缩被取消（aborted） When 判定 Then 不续跑', () => {
    expect(shouldResumeAfterAutoCompaction({ ...successEvent, aborted: true }, true)).toBe(false)
  })

  test('Given 压缩失败（无 result） When 判定 Then 不续跑（失败提示已另行上屏，续跑会立刻再触发压缩）', () => {
    expect(shouldResumeAfterAutoCompaction({ ...successEvent, hasResult: false }, true)).toBe(false)
  })

  test('Given 轮前压缩（afterCompletedTurn=false，turn 中途） When 判定 Then 不续跑（agent loop 带新上下文自行继续）', () => {
    expect(shouldResumeAfterAutoCompaction(successEvent, false)).toBe(false)
  })
})

describe('压缩续跑提示编排（planPiCompactionContinuation，补齐零测试）', () => {
  test('Given 正常状态 When 规划续跑 Then 继续并携带续跑提示原文', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
    })
    expect(plan).toEqual({ shouldContinue: true, prompt: PI_COMPACTION_CONTINUATION_PROMPT })
  })

  test('Given 用户已请求停止 When 规划续跑 Then 以 aborted 拒绝', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 0,
      abortRequested: true,
      runtimeLimitReached: false,
    })
    expect(plan).toEqual({ shouldContinue: false, reason: 'aborted' })
  })

  test('Given 已达运行时长/预算限制 When 规划续跑 Then 以 runtime_limit 拒绝', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 3,
      abortRequested: false,
      runtimeLimitReached: true,
    })
    expect(plan).toEqual({ shouldContinue: false, reason: 'runtime_limit' })
  })

  test('Given 续跑次数达到 20 次上限 When 规划续跑 Then 以 continuation_limit 拒绝（防压缩-续跑死循环）', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 20,
      abortRequested: false,
      runtimeLimitReached: false,
    })
    expect(plan).toEqual({ shouldContinue: false, reason: 'continuation_limit' })
  })

  test('Given 续跑次数在上限边界内（19 次） When 规划续跑 Then 仍然继续', () => {
    const plan = planPiCompactionContinuation({
      continuationCount: 19,
      abortRequested: false,
      runtimeLimitReached: false,
    })
    expect(plan.shouldContinue).toBe(true)
  })

  test('Given 续跑提示文本 When 检查内容 Then 含「继续完成原始用户任务」与「不要重复已完成操作」两条关键纪律', () => {
    expect(PI_COMPACTION_CONTINUATION_PROMPT).toContain('继续完成原始用户任务')
    expect(PI_COMPACTION_CONTINUATION_PROMPT).toContain('不要重复已经完成或已提交的操作')
  })
})

describe('零总结收尾自动续跑（用户要的是结果，不是「请自己发继续」的提示）', () => {
  const base = {
    resultSubtype: 'success' as string | undefined,
    lastAssistantEndedWithText: false,
    continuationCount: 0,
    abortRequested: false,
    runtimeLimitReached: false,
  }

  test('Given run success 收尾且最后一条 assistant 没以 text 收尾 When 规划 Then 自动续跑补总结', () => {
    const plan = planPiFinalOutputContinuation(base)
    expect(plan).toEqual({ shouldContinue: true, prompt: PI_FINAL_OUTPUT_CONTINUATION_PROMPT })
  })

  test('Given 最后一条 assistant 已以非空 text 收尾 When 规划 Then 不续（正常回合零打扰）', () => {
    expect(planPiFinalOutputContinuation({ ...base, lastAssistantEndedWithText: true }).shouldContinue).toBe(false)
  })

  test('Given 终态不是 success（错误/中断另有交代） When 规划 Then 不续', () => {
    expect(planPiFinalOutputContinuation({ ...base, resultSubtype: 'error_during_execution' }).shouldContinue).toBe(false)
    expect(planPiFinalOutputContinuation({ ...base, resultSubtype: undefined }).shouldContinue).toBe(false)
  })

  test('Given 用户已停止或达运行限制 When 规划 Then 不续', () => {
    expect(planPiFinalOutputContinuation({ ...base, abortRequested: true }).shouldContinue).toBe(false)
    expect(planPiFinalOutputContinuation({ ...base, runtimeLimitReached: true }).shouldContinue).toBe(false)
  })

  test('Given 连续 2 次续跑仍零总结 When 规划 Then 放弃（防模型异常空转），UI 兜底提示行接手', () => {
    expect(planPiFinalOutputContinuation({ ...base, continuationCount: 2 }).shouldContinue).toBe(false)
    expect(planPiFinalOutputContinuation({ ...base, continuationCount: 1 }).shouldContinue).toBe(true)
  })

  test('Given Pi 侧 content 各种收尾形态 When 判定 trailing text Then 只有非空 text 收尾算数', () => {
    expect(assistantEndsWithTrailingText([{ type: 'text', text: '总结完毕' }])).toBe(true)
    expect(assistantEndsWithTrailingText([{ type: 'text', text: '过程' }, { type: 'toolCall' }])).toBe(false)
    expect(assistantEndsWithTrailingText([{ type: 'thinking' }])).toBe(false)
    expect(assistantEndsWithTrailingText([{ type: 'text', text: '   ' }])).toBe(false)
    expect(assistantEndsWithTrailingText([])).toBe(false)
  })
})

describe('零总结续跑提示的判断顺序（回复完又自己跑一轮的修复）', () => {
  const prompt = PI_FINAL_OUTPUT_CONTINUATION_PROMPT

  test('Given 续跑提示不上屏 When 模型读到它 Then 开头先讲明这是系统检查、不是用户的新消息', () => {
    expect(prompt).toContain('这是系统自动发出的检查，不是用户发来的新消息')
  })

  test('Given 模型本轮已经在向用户提问、等用户回答 When 读续跑提示 Then 要求复述问题就结束，且不准调用工具、不准开始新操作', () => {
    expect(prompt).toContain('正在等用户回答')
    expect(prompt).toContain('把问题再说一遍就结束')
    expect(prompt).toContain('不要调用任何工具')
    expect(prompt).toContain('不要开始新的操作')
  })

  test('Given 原始任务已经做完 When 读续跑提示 Then 只要求总结，不再调用工具', () => {
    expect(prompt).toContain('若原始任务已完成：用一段话向用户总结做了什么、结果是什么，不要再调用工具')
  })

  test('Given 任务确实没做完且不用等用户 When 读续跑提示 Then 仍然继续执行剩余步骤（自动续跑的原意保留）', () => {
    expect(prompt).toContain('若任务确实还没完成，而且不需要等用户回答：继续执行剩余步骤，全部完成后给出总结')
  })

  test('Given 提示要求按顺序判断 When 检查条目顺序 Then 「等用户回答」排在「已完成」和「继续执行」之前', () => {
    const waitingIndex = prompt.indexOf('正在等用户回答')
    const completedIndex = prompt.indexOf('若原始任务已完成')
    const continueIndex = prompt.indexOf('继续执行剩余步骤')
    expect(waitingIndex).toBeGreaterThan(-1)
    expect(waitingIndex).toBeLessThan(completedIndex)
    expect(completedIndex).toBeLessThan(continueIndex)
  })

  test('Given 续跑提示 When 检查收尾纪律与标签 Then 保留「不要重复已完成操作」且首尾标签成对', () => {
    expect(prompt).toContain('不要重复已经完成或已提交的操作')
    expect(prompt.startsWith('<app_final_output_continuation>')).toBe(true)
    expect(prompt.endsWith('</app_final_output_continuation>')).toBe(true)
  })

  test('Given 规划器决定续跑 When 取提示 Then 用的就是这份新提示', () => {
    const plan = planPiFinalOutputContinuation({
      resultSubtype: 'success',
      lastAssistantEndedWithText: false,
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
    })
    expect(plan).toEqual({ shouldContinue: true, prompt })
  })
})
