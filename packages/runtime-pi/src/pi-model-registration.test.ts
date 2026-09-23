/**
 * Pi 目录缺失时的模型注册口径。
 *
 * - GLM-5.3 系列（收上游 #2077 GLM-5.3-FlashX）：智谱直连目录（zai.json）只有 glm-5.3 / glm-5.3-flash，没有 FlashX；
 *   目录查不到时要按 GLM-5.3 系列的官方 128K 输出上限注册，而不是落到 64K 默认值。
 * - DeepSeek 旧名（Pi 0.86.1 删掉了 deepseek-v4-flash / vision-exp）：从 deepseek-flash 派生，
 *   保住 384K 输出，deepseek-v4-flash 仍按纯文本（不能因目录缺失退成默认的「能看图」）。
 */

import { describe, expect, test } from 'bun:test'
import { buildModel } from './pi-model-registry'

type BuildModelSdk = Parameters<typeof buildModel>[0]
type BuildModelInput = Parameters<typeof buildModel>[1]

interface RegisteredModel {
  id: string
  maxTokens: number
  contextWindow: number
  input: string[]
  thinkingLevelMap?: Record<string, unknown>
}

/** 记录 registerProvider 收到的模型定义，getModel 原样返回它。 */
function createRecordingSdk(): { sdk: BuildModelSdk; registered: RegisteredModel[] } {
  const registered: RegisteredModel[] = []
  const sdk = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: (_name: string, config: { models: RegisteredModel[] }) => {
          registered.push(...config.models)
        },
        getModel: (_provider: string, modelId: string) => registered.find((model) => model.id === modelId),
      }),
    },
  } as unknown as BuildModelSdk
  return { sdk, registered }
}

function zhipuInput(model: string): BuildModelInput {
  return {
    provider: 'zhipu',
    model,
    apiKey: 'sk-test',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    sessionId: 'glm-family-test',
    channelName: '智谱',
  } as unknown as BuildModelInput
}

describe('GLM-5.3 系列注册口径（目录缺失兜底）', () => {
  test('给定智谱渠道的 glm-5.3-flashx（Pi 直连目录没有），当注册模型时，则按 128K 输出、1M 窗口', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, zhipuInput('glm-5.3-flashx'))
    expect(registered[0]).toMatchObject({ id: 'glm-5.3-flashx', maxTokens: 131_072, contextWindow: 1_000_000 })
  })

  test('给定大小写写法 GLM-5.3-FlashX，当注册时，则同样认作 5.3 系列', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, zhipuInput('GLM-5.3-FlashX'))
    expect(registered[0]?.maxTokens).toBe(131_072)
  })

  test('给定同样查不到目录、但不属于 5.3 系列的变体 ID，当注册时，则仍落 64K 默认输出（兜底不外溢）', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, zhipuInput('glm-5.3-air'))
    expect(registered[0]?.maxTokens).toBe(64_000)
  })
})

function deepseekInput(model: string): BuildModelInput {
  return {
    provider: 'deepseek',
    model,
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com/anthropic',
    sessionId: 'deepseek-registration-test',
    channelName: 'DeepSeek',
  } as unknown as BuildModelInput
}

describe('DeepSeek 注册口径（Pi 0.86.1 删掉旧名之后）', () => {
  test('给定仍在用 deepseek-v4-flash 的老渠道，当注册时，则 384K 输出、纯文本（发图走视觉助手，不会直接 400）', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, deepseekInput('deepseek-v4-flash'))
    expect(registered[0]).toMatchObject({ id: 'deepseek-v4-flash', maxTokens: 384_000, contextWindow: 1_000_000, input: ['text'] })
  })

  test('给定现行 ID deepseek-flash，当注册时，则 384K 输出且原生收图（官方 2026-09 起支持）', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, deepseekInput('deepseek-flash'))
    expect(registered[0]).toMatchObject({ id: 'deepseek-flash', maxTokens: 384_000, input: ['text', 'image'] })
  })

  test('给定 vision-exp 旧名，当注册时，则 384K 输出且收图（官方：转由 V4.1 Flash 处理）', async () => {
    const { sdk, registered } = createRecordingSdk()
    await buildModel(sdk, deepseekInput('deepseek-v4-flash-vision-exp'))
    expect(registered[0]).toMatchObject({ id: 'deepseek-v4-flash-vision-exp', maxTokens: 384_000, input: ['text', 'image'] })
  })
})
