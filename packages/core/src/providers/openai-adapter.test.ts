import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'

function buildTitleBody(provider: 'openai' | 'opencode-go-openai'): Record<string, unknown> {
  const request = new OpenAIAdapter(provider).buildTitleRequest({
    baseUrl: provider === 'opencode-go-openai'
      ? 'https://opencode.ai/zen/go/v1'
      : 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelId: 'glm-5.2',
    prompt: '生成标题',
  })

  return JSON.parse(request.body) as Record<string, unknown>
}

describe('OpenAIAdapter 标题生成请求', () => {
  test('Given OpenCode Go 的推理模型 When 生成标题 Then 预留足够的输出预算', () => {
    expect(buildTitleBody('opencode-go-openai').max_tokens).toBe(512)
  })

  // 原断言是「标准渠道保持 50 的小预算」，随上游 af28c536 改为一律 512：
  // 推理型模型会先把预算花在思考上，50 tokens 常常还没轮到正文就到顶，
  // 自动重命名于是收到空标题。max_tokens 是上限而非消耗，标题实际只有十几个
  // token，抬高上限不会真的多花钱，只是给思考期留余量。
  test('Given 任意 OpenAI 兼容渠道 When 生成标题 Then 都预留足够输出预算以容纳推理期', () => {
    expect(buildTitleBody('openai').max_tokens).toBe(512)
    expect(buildTitleBody('opencode-go-openai').max_tokens).toBe(512)
  })
})
