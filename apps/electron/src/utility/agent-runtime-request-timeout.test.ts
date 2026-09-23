/**
 * Utility Process → 主进程请求超时的 BDD 测试（上游 #1772，0.17.34 合入时上游未带测试）。
 *
 * AskUserQuestion 是用户主导的自由文本输入，默认 2 分钟不够用；但只放宽这一个工具，
 * 其他跨进程能力调用仍保持 2 分钟的故障检测能力。
 */

import { describe, expect, it } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@canopy/shared'
import { ASK_USER_QUESTION_TIMEOUT_MS, getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

const DEFAULT_MS = 120_000

describe('Utility Process 请求主进程的超时', () => {
  it('给定是 AskUserQuestion 的权限询问，当取超时时间时，则给 15 分钟', () => {
    const timeout = getParentRequestTimeoutMs(
      AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      { toolName: 'AskUserQuestion' },
    )

    expect(timeout).toBe(ASK_USER_QUESTION_TIMEOUT_MS)
    expect(ASK_USER_QUESTION_TIMEOUT_MS).toBe(15 * 60_000)
  })

  it('给定是别的工具的权限询问，当取超时时间时，则仍是默认 2 分钟（不放宽故障检测）', () => {
    for (const toolName of ['Bash', 'BrowserNavigate', 'Write', 'ExitPlanMode']) {
      expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { toolName }))
        .toBe(DEFAULT_MS)
    }
  })

  it('给定不是权限询问的其他方法，当取超时时间时，则默认 2 分钟——即便 payload 里恰好带同名工具', () => {
    expect(getParentRequestTimeoutMs('some-other-method', { toolName: 'AskUserQuestion' })).toBe(DEFAULT_MS)
  })

  it('给定 payload 缺失或形状异常，当取超时时间时，则回落默认值而不是抛错', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, null)).toBe(DEFAULT_MS)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, undefined)).toBe(DEFAULT_MS)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, { toolName: 42 })).toBe(DEFAULT_MS)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, 'AskUserQuestion')).toBe(DEFAULT_MS)
  })
})
