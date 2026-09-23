import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@canopy/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { setAppVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key') {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'qwen-token-plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'
      : provider === 'zhipu-coding-team'
      ? 'https://open.bigmodel.cn/api/anthropic'
      : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: 'mimo-v2.5-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with Canopy User-Agent', () => {
    setAppVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Canopy/9.9.9')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan uses the complete Anthropic endpoint with bearer authentication and Canopy User-Agent', () => {
    setAppVersion('9.9.9')

    const request = buildRequest('qwen-token-plan')

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Canopy/9.9.9')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setAppVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('Canopy/9.9.9')
    expect(request.headers['api-key']).toBeUndefined()
  })
})

/**
 * GLM-5.3 在智谱 Anthropic 协议端点（Coding Plan / 团队版）上始终思考：
 * 端点实测（2026-08-17）`thinking:{type:'disabled'}` 与不带思考参数的请求都被 1210 拒绝，
 * 所以 Chat 模式「关闭思考」与标题生成都必须改成 adaptive + 最低强度，而不是 disabled / 省略。
 */
describe('AnthropicAdapter · GLM-5.3 always-on thinking', () => {
  const adapter = new AnthropicAdapter('zhipu-coding')
  const baseUrl = 'https://open.bigmodel.cn/api/anthropic'

  function streamBody(modelId: string, thinkingEnabled: boolean): Record<string, any> {
    const request = adapter.buildStreamRequest({
      baseUrl,
      apiKey: 'test-key',
      modelId,
      history: [],
      userMessage: 'ping',
      readImageAttachments: () => [],
      thinkingEnabled,
    })
    return JSON.parse(request.body)
  }

  test('given glm-5.3 with thinking on, sends adaptive + output_config.effort=high (default level)', () => {
    const body = streamBody('glm-5.3', true)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(32000)
  })

  test('given glm-5.3 with thinking OFF, still sends adaptive + effort=low instead of disabled/omitting', () => {
    const body = streamBody('glm-5.3', false)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'low' })
    // 思考仍在跑，输出上限不能按「关闭思考」的 8192 收窄
    expect(body.max_tokens).toBe(32000)
  })

  test('given glm-5.3 title request, sends adaptive + effort=low with a 512 budget, never disabled', () => {
    const request = adapter.buildTitleRequest({ baseUrl, apiKey: 'test-key', modelId: 'glm-5.3', prompt: 'title?' })
    const body = JSON.parse(request.body)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.max_tokens).toBe(512)
  })

  test('control: glm-5.2 keeps the old behaviour — thinking off omits the field, title sends disabled', () => {
    const off = streamBody('glm-5.2', false)
    expect(off.thinking).toBeUndefined()
    expect(off.output_config).toBeUndefined()
    expect(off.max_tokens).toBe(8192)

    const title = JSON.parse(adapter.buildTitleRequest({ baseUrl, apiKey: 'test-key', modelId: 'glm-5.2', prompt: 'title?' }).body)
    expect(title.thinking).toEqual({ type: 'disabled' })
    expect(title.max_tokens).toBe(50)
  })
})
