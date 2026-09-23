import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ProviderType } from '@canopy/shared'
import { decideShouldAugmentModel, type VisionAugmentEligibilityDeps } from './vision-augment-eligibility'

/**
 * 视觉补齐模型判定测试。
 *
 * 视觉补齐的触发规则：用户勾选优先 → catalog unsupported 兜底 →
 * supported / unknown 不补齐（不误伤原生视觉模型，unknown 交给用户决定）。
 *
 * 0.19.0 前这份测试靠 `mock.module` 把 channel-manager / settings-service / attachment-service /
 * @canopy/runtime-pi 四个模块整体换成桩。bun 的 `mock.module` 是进程级全局的、`mock.restore()` 也不还原它，
 * 成套混跑时别的测试文件拿到的就是这些桩。现在判定逻辑抽成纯函数、依赖直接注入，
 * 本文件不再 mock 任何模块——末尾有一例守住这条。
 */

interface FakeState {
  augmentModelKeys?: string[]
  channelProvider: ProviderType | undefined
  capability: 'supported' | 'unsupported' | 'unknown'
}

const state: FakeState = {
  augmentModelKeys: undefined,
  channelProvider: 'deepseek',
  capability: 'unknown',
}

/** 只有 'chat-channel' 这一个渠道存在，其余一律视为渠道不存在。 */
const deps: VisionAugmentEligibilityDeps = {
  getAugmentModelKeys: () => state.augmentModelKeys,
  getChannelProvider: (channelId) => (channelId === 'chat-channel' ? state.channelProvider : undefined),
  resolveImageInputCapability: async () => state.capability,
}

const shouldAugmentModel = (channelId: string | undefined, modelId: string | undefined): Promise<boolean> =>
  decideShouldAugmentModel(channelId, modelId, deps)

beforeEach(() => {
  state.augmentModelKeys = undefined
  state.channelProvider = 'deepseek'
  state.capability = 'unknown'
})

describe('视觉补齐模型判定 shouldAugmentModel', () => {
  test('Given 用户勾选了该模型 When 判定 Then 补齐（覆盖 catalog 判定）', async () => {
    state.augmentModelKeys = ['chat-channel::my-text-model']
    state.capability = 'supported'

    expect(await shouldAugmentModel('chat-channel', 'my-text-model')).toBe(true)
  })

  test('Given 未勾选且 catalog 判定 unsupported When 判定 Then 自动补齐（DeepSeek V4 零配置）', async () => {
    state.capability = 'unsupported'

    expect(await shouldAugmentModel('chat-channel', 'deepseek-v4-pro')).toBe(true)
  })

  test('Given 未勾选且 catalog 判定 supported When 判定 Then 不补齐（原生视觉模型不误伤）', async () => {
    state.capability = 'supported'

    expect(await shouldAugmentModel('chat-channel', 'gpt-4o')).toBe(false)
  })

  test('Given 未勾选且 catalog 判定 unknown When 判定 Then 不补齐（自定义模型交给用户勾选）', async () => {
    state.capability = 'unknown'

    expect(await shouldAugmentModel('chat-channel', 'my-custom-model')).toBe(false)
  })

  test('Given 勾选键属于其他渠道的同名模型 When 判定 Then 不补齐（键含渠道 ID 防误伤）', async () => {
    state.augmentModelKeys = ['other-channel::my-text-model']
    state.capability = 'unknown'

    expect(await shouldAugmentModel('chat-channel', 'my-text-model')).toBe(false)
  })

  test('Given 渠道不存在 When 判定 Then 不补齐', async () => {
    state.capability = 'unsupported'

    expect(await shouldAugmentModel('missing-channel', 'deepseek-v4-pro')).toBe(false)
  })

  test('Given 缺少渠道或模型 ID When 判定 Then 不补齐', async () => {
    expect(await shouldAugmentModel(undefined, 'deepseek-v4-pro')).toBe(false)
    expect(await shouldAugmentModel('chat-channel', undefined)).toBe(false)
    expect(await shouldAugmentModel('chat-channel', '   ')).toBe(false)
  })

  test('Given 模型 ID 首尾带空白 When 判定 Then 按裁剪后的 ID 匹配勾选键并查询 catalog', async () => {
    state.augmentModelKeys = ['chat-channel::my-text-model']
    expect(await shouldAugmentModel('chat-channel', '  my-text-model  ')).toBe(true)

    state.augmentModelKeys = undefined
    const queried: string[] = []
    const recording: VisionAugmentEligibilityDeps = {
      ...deps,
      resolveImageInputCapability: async (_provider, modelId) => {
        queried.push(modelId)
        return 'unsupported'
      },
    }
    expect(await decideShouldAugmentModel('chat-channel', '  deepseek-v4-pro ', recording)).toBe(true)
    expect(queried).toEqual(['deepseek-v4-pro'])
  })

  test('Given 用户已勾选 When 判定 Then 不再查渠道与 catalog（勾选是最高优先级，渠道查不到也补齐）', async () => {
    state.augmentModelKeys = ['missing-channel::my-text-model']
    let touched = false
    const guarded: VisionAugmentEligibilityDeps = {
      getAugmentModelKeys: deps.getAugmentModelKeys,
      getChannelProvider: () => { touched = true; return undefined },
      resolveImageInputCapability: async () => { touched = true; return 'supported' },
    }
    expect(await decideShouldAugmentModel('missing-channel', 'my-text-model', guarded)).toBe(true)
    expect(touched).toBe(false)
  })
})

describe('测试隔离守卫', () => {
  test('Given 本测试文件 When 检查源码 Then 不出现任何模块级 mock（它曾是成套混跑 3 例串扰的源头）', () => {
    const source = readFileSync(import.meta.path, 'utf8')
    // 拼接写法：避免这条断言自己命中自己
    expect(source.includes('mock' + '.module(')).toBe(false)
  })
})
