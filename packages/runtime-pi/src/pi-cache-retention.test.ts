import { describe, expect, it } from 'bun:test'
import {
  applyPiCacheRetention,
  normalizeAgentPromptCacheRetention,
  resolvePiCacheRetention,
} from './pi-cache-retention'

describe('提示缓存保留时长：设置值归一', () => {
  it('Given 设置为 long，When 归一，Then 得到 long', () => {
    expect(normalizeAgentPromptCacheRetention('long')).toBe('long')
  })

  it('Given 未设置、short 或手改的非法值，When 归一，Then 一律回落到 short', () => {
    expect(normalizeAgentPromptCacheRetention(undefined)).toBe('short')
    expect(normalizeAgentPromptCacheRetention('short')).toBe('short')
    expect(normalizeAgentPromptCacheRetention('1h')).toBe('short')
    expect(normalizeAgentPromptCacheRetention(3600)).toBe('short')
  })
})

describe('提示缓存保留时长：按协议决定是否注入', () => {
  it('Given 用户选 1 小时且模型走 Anthropic Messages 协议，When 解析，Then 注入 long', () => {
    expect(resolvePiCacheRetention({ api: 'anthropic-messages', preference: 'long' })).toBe('long')
  })

  it('Given 用户选 1 小时但模型走 OpenAI 兼容 / Responses / 其他协议，When 解析，Then 不注入', () => {
    for (const api of ['openai-completions', 'openai-responses', 'google-generative-ai', 'bedrock-converse-stream', undefined]) {
      expect(resolvePiCacheRetention({ api, preference: 'long' })).toBeUndefined()
    }
  })

  it('Given 用户选 5 分钟或未设置，When 解析，Then 不注入（保持 Pi 默认）', () => {
    expect(resolvePiCacheRetention({ api: 'anthropic-messages', preference: 'short' })).toBeUndefined()
    expect(resolvePiCacheRetention({ api: 'anthropic-messages', preference: undefined })).toBeUndefined()
  })
})

describe('提示缓存保留时长：并入 stream 选项', () => {
  it('Given 需要注入 long，When 选项里没有 cacheRetention，Then 补上且不丢其他字段', () => {
    const merged = applyPiCacheRetention({ maxTokens: 100 } as { maxTokens: number; cacheRetention?: string }, 'long')
    expect(merged).toEqual({ maxTokens: 100, cacheRetention: 'long' })
  })

  it('Given 选项为 undefined，When 需要注入，Then 新建对象', () => {
    expect(applyPiCacheRetention(undefined as object | undefined, 'long')).toEqual({ cacheRetention: 'long' })
  })

  it('Given 调用方已显式传 cacheRetention（如压缩请求的 none），When 需要注入，Then 不覆盖', () => {
    const options = { cacheRetention: 'none' }
    expect(applyPiCacheRetention(options, 'long')).toBe(options)
  })

  it('Given 不需要注入，When 并入，Then 原样返回同一个对象', () => {
    const options = { maxTokens: 1 } as { maxTokens: number; cacheRetention?: string }
    expect(applyPiCacheRetention(options, undefined)).toBe(options)
  })
})
