import { describe, expect, test } from 'bun:test'
import {
  CODEX_GPT_56_CONTEXT_WINDOW,
  CODEX_GPT_6_ASTRA_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
  inferCodexAlignedGPT5ContextWindow,
  inferContextWindow,
  ONE_MILLION_CONTEXT_WINDOW,
} from './context-window'

/**
 * GPT-6 Astra 上下文窗口契约（维护者 2026-09-08 定：与 GPT-5.6 统一按 372K）。
 * 这个数直接决定进度环分母与自动压缩触发点：写成 200K 默认值会在 160K 附近就开始压缩，白丢八成窗口。
 */
describe('上下文窗口推断 · GPT-6 Astra', () => {
  test('给定 gpt-6-astra，当推断窗口时，则取与 5.6 一致的 372,000（Codex 对齐路径优先于 1M 泛化规则）', () => {
    expect(CODEX_GPT_6_ASTRA_CONTEXT_WINDOW).toBe(372_000)
    expect(inferCodexAlignedGPT5ContextWindow('gpt-6-astra')).toBe(CODEX_GPT_6_ASTRA_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-6-astra')).toBe(CODEX_GPT_6_ASTRA_CONTEXT_WINDOW)
  })

  test('给定大小写混排或带旧 [1m] 后缀的写法，当推断时，则同样命中', () => {
    expect(inferContextWindow('GPT-6-Astra')).toBe(CODEX_GPT_6_ASTRA_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-6-astra[1m]')).toBe(CODEX_GPT_6_ASTRA_CONTEXT_WINDOW)
  })

  test('给定未登记的 gpt-6 变体，当推断时，则不冒领 Astra 的窗口、回落默认 200K', () => {
    expect(inferCodexAlignedGPT5ContextWindow('gpt-6-mini')).toBeUndefined()
    expect(inferContextWindow('gpt-6-mini')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('给定 GPT-5.6 系列，当推断时，则窗口不受本次改动影响', () => {
    expect(inferContextWindow('gpt-5.6-terra')).toBe(CODEX_GPT_56_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-5.6-sol')).toBe(CODEX_GPT_56_CONTEXT_WINDOW)
  })
})

/**
 * DeepSeek Flash（上游 v0.19.53 #2045）：官方定价页标 1M 上下文，现行 ID 是 deepseek-flash、不带 v4 前缀，
 * 只靠既有的 `deepseek-v4` 前缀规则会回落 200K，进度环与自动压缩阈值都会按五分之一算。
 */
describe('上下文窗口推断 · DeepSeek Flash', () => {
  test('给定 deepseek-flash 及其快照写法，当推断窗口时，则按 1M 计算', () => {
    expect(inferContextWindow('deepseek-flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('DeepSeek-Flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('给定旧名 deepseek-v4-flash 与 deepseek-v4-pro，当推断时，则仍按 1M、不受改名影响', () => {
    expect(inferContextWindow('deepseek-v4-flash')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('deepseek-v4-pro')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })
})

describe('上下文窗口推断 · GLM-5.3 系列（上游 #2077）', () => {
  test('给定 glm-5.3 / Flash / FlashX 及大写写法，当推断窗口时，则都按 1M 计算', () => {
    for (const modelId of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'GLM-5.3-FlashX']) {
      expect(inferContextWindow(modelId)).toBe(ONE_MILLION_CONTEXT_WINDOW)
    }
  })
})
