/**
 * Pi 模型能力解析的 BDD 测试（上游 #1774 / #1777 / #1755，0.17.34 合入时上游三条都没带测试）。
 *
 * 这三个纯函数都直接决定发给上游的请求形状（协议、是否带图、是否强制 adaptive thinking），
 * 错了会表现为「某渠道某模型莫名 400」，值得钉住。
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  derivePiCatalogModel,
  getDerivedCatalogSourceModelId,
  resolvePiApi,
  resolvePiImageInputCapability,
  shouldForcePiAdaptiveThinking,
  supportsPiNativeImageInput,
} from './pi-model-registry'

describe('OpenCode Go 按目录协议路由（#1774）', () => {
  it('给定 OpenCode 渠道且模型目录声明了协议，当解析时，则以目录声明为准', () => {
    expect(resolvePiApi('opencode-go-openai', 'anthropic-messages')).toBe('anthropic-messages')
    expect(resolvePiApi('opencode-go-openai', 'openai-responses')).toBe('openai-responses')
  })

  it('给定 OpenCode 渠道但目录里查不到该模型，当解析时，则回落历史默认 OpenAI Chat Completions', () => {
    expect(resolvePiApi('opencode-go-openai', undefined)).toBe('openai-completions')
  })

  it('给定不是 OpenCode 的渠道，当解析时，则忽略目录声明、按渠道自身协议走', () => {
    // 智谱走 OpenAI Chat Completions；即便目录里写的是 anthropic 也不能改协议。
    expect(resolvePiApi('zhipu', 'anthropic-messages')).toBe('openai-completions')
    expect(resolvePiApi('zhipu', undefined)).toBe('openai-completions')
  })
})

describe('DeepSeek 原生视觉白名单（#1777 误收已剔除）', () => {
  it('给定官方明示的视觉模型，当判定时，则为 true', () => {
    expect(supportsPiNativeImageInput('deepseek-v4-flash-vision-exp')).toBe(true)
  })

  it('给定大小写或空白不规范的模型 ID，当判定时，则归一化后仍能命中', () => {
    expect(supportsPiNativeImageInput('  DeepSeek-V4-Flash-Vision-Exp  ')).toBe(true)
  })

  /**
   * 回归锁：DeepSeek 官方文档（2026-09-21 复核 guides/vision）写明「仅 deepseek-flash 模型支持图片输入」。
   * 上游 #1777 曾把 deepseek-v4-flash 一起放进白名单——标成 supported 会让视觉助手不再兜底，
   * 用户发图从「转文字后能用」退化成「直接 400」。旧名虽已转由 V4.1 Flash 处理，官方未写它能收图，仍按不支持。
   */
  it('给定普通的 deepseek-v4-flash，当判定时，则为 false（官方只写明 deepseek-flash 支持图片）', () => {
    expect(supportsPiNativeImageInput('deepseek-v4-flash')).toBe(false)
  })

  it('给定 V4 Pro，当判定时，则为 false（它需要走视觉助手转发）', () => {
    expect(supportsPiNativeImageInput('deepseek-v4-pro')).toBe(false)
  })

  it('给定空值或无关模型，当判定时，则为 false', () => {
    expect(supportsPiNativeImageInput(undefined)).toBe(false)
    expect(supportsPiNativeImageInput('')).toBe(false)
    expect(supportsPiNativeImageInput('gpt-5.5')).toBe(false)
  })
})

describe('Claude 模型保留 adaptive thinking（#1755）', () => {
  const anthropicCatalog = { api: 'anthropic-messages' as const, compat: { forceAdaptiveThinking: true } }

  it('给定请求与目录两侧都是 anthropic 协议且目录标了 forceAdaptiveThinking，当判定时，则透传该标志', () => {
    expect(shouldForcePiAdaptiveThinking('anthropic-messages', anthropicCatalog)).toBe(true)
  })

  it('给定请求协议不是 anthropic，当判定时，则不透传（避免把 anthropic 的行为泄漏到别的协议）', () => {
    expect(shouldForcePiAdaptiveThinking('openai-completions', anthropicCatalog)).toBe(false)
    expect(shouldForcePiAdaptiveThinking('openai-responses', anthropicCatalog)).toBe(false)
  })

  it('给定目录条目本身不是 anthropic 协议，当判定时，则不透传', () => {
    expect(shouldForcePiAdaptiveThinking('anthropic-messages', {
      api: 'openai-completions',
      compat: { forceAdaptiveThinking: true },
    })).toBe(false)
  })

  it('给定目录里没有该标志或压根查不到条目，当判定时，则为 false', () => {
    expect(shouldForcePiAdaptiveThinking('anthropic-messages', { api: 'anthropic-messages' })).toBe(false)
    expect(shouldForcePiAdaptiveThinking('anthropic-messages', { api: 'anthropic-messages', compat: {} })).toBe(false)
    expect(shouldForcePiAdaptiveThinking('anthropic-messages', undefined)).toBe(false)
  })
})

describe('DeepSeek 旧名的 catalog 派生（0.17.35 起；Pi 0.86.1 删掉旧名后改从 deepseek-flash 派生）', () => {
  /**
   * 直接读 Pi 自带的 catalog 源数据，避免用手写假数据自证——派生的全部意义就是
   * 「继承来源条目的真实字段」，用真数据才测得出继承是否完整。
   */
  // pi-ai 可能装在 apps/electron 嵌套层或仓库根（bun 去重后仅根有副本），用解析定位不写死层级
  const catalogPath = join(
    require.resolve('@earendil-works/pi-ai/package.json'),
    '../dist/providers/data/deepseek.json',
  )
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
    'openai-completions': Record<string, Record<string, unknown>>
  }
  const flashRecord = catalog['openai-completions']['deepseek-flash'] as unknown as {
    cost: Record<string, number>
    compat: Record<string, unknown>
    input: string[]
  }
  const flash = catalog['openai-completions']['deepseek-flash'] as never

  it('给定 Pi 0.86.1 的 DeepSeek 目录（前提对照），当读取时，则旧名已删、只剩 deepseek-flash 与 v4-pro', () => {
    // 升级 Pi 后若目录又带回旧名，本条会失败：届时确认派生仍只在目录缺失时生效即可
    expect(Object.keys(catalog['openai-completions']).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(flashRecord.input).toEqual(['text', 'image'])
  })

  it('给定两个旧名，当查来源时，则都指向 deepseek-flash（大小写/空白不敏感）；现行 ID 自身不参与派生', () => {
    expect(getDerivedCatalogSourceModelId('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash')
    expect(getDerivedCatalogSourceModelId('  DeepSeek-V4-Flash ')).toBe('deepseek-flash')
    expect(getDerivedCatalogSourceModelId('deepseek-flash')).toBeUndefined()
    expect(getDerivedCatalogSourceModelId('gpt-5.5')).toBeUndefined()
  })

  it('给定真实的 deepseek-flash 条目，当派生 vision-exp 时，则只改 id/name/input，其余原样继承', () => {
    const derived = derivePiCatalogModel('deepseek-v4-flash-vision-exp', flash)

    expect(derived?.id).toBe('deepseek-v4-flash-vision-exp')
    expect(derived?.name).toBe('DeepSeek V4 Flash Vision Exp')
    expect(derived?.input).toEqual(['text', 'image'])
    // 官方定价页：旧名由 V4.1 Flash 提供服务并按 Flash 计费——1M 上下文 / 384K 最大输出 / 同价
    expect(derived?.contextWindow).toBe(1_000_000)
    expect(derived?.maxTokens).toBe(384_000)
    expect(derived?.cost).toEqual(flashRecord.cost as never)
    // DeepSeek 专属 compat 必须继承，否则请求字段名/思考格式都是错的
    expect(derived?.compat).toEqual(flashRecord.compat as never)
    expect(derived?.compat).toMatchObject({ maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' } as never)
    expect(derived?.api).toBe('openai-completions')
  })

  it('给定真实的 deepseek-flash 条目，当派生 deepseek-v4-flash 时，则按纯文本（官方只写明 deepseek-flash 收图）', () => {
    const derived = derivePiCatalogModel('deepseek-v4-flash', flash)

    expect(derived).toMatchObject({ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 384_000, contextWindow: 1_000_000 })
    expect(derived?.input).toEqual(['text'])
    expect(derived?.compat).toMatchObject({ thinkingFormat: 'deepseek' } as never)
  })

  it('给定派生不改动来源对象，当派生后修改 input 时，则来源条目不受影响', () => {
    const derived = derivePiCatalogModel('deepseek-v4-flash-vision-exp', flash)
    derived?.input.push('audio' as never)

    expect(flashRecord.input).toEqual(['text', 'image'])
  })

  it('给定来源条目查不到，当派生时，则返回 undefined 而不是造一个残缺条目', () => {
    expect(derivePiCatalogModel('deepseek-v4-flash-vision-exp', undefined)).toBeUndefined()
  })

  it('给定不在派生表里的模型，当派生时，则返回 undefined', () => {
    expect(derivePiCatalogModel('deepseek-v4-pro', flash)).toBeUndefined()
  })
})

describe('DeepSeek 渠道的能否看图判定（走完整目录查找链，Pi 0.86.1）', () => {
  it('给定 deepseek-flash，当判定时，则原生支持（官方与 Pi 目录一致），不再绕视觉助手', async () => {
    expect(await resolvePiImageInputCapability('deepseek', 'deepseek-flash')).toBe('supported')
  })

  it('给定 vision-exp 旧名，当判定时，则仍支持（官方：转由 V4.1 Flash 处理）', async () => {
    expect(await resolvePiImageInputCapability('deepseek', 'deepseek-v4-flash-vision-exp')).toBe('supported')
  })

  it('给定 deepseek-v4-flash 与 v4-pro，当判定时，则不支持、交视觉助手兜底（不能因目录删了旧名就退成「能看图」）', async () => {
    expect(await resolvePiImageInputCapability('deepseek', 'deepseek-v4-flash')).toBe('unsupported')
    expect(await resolvePiImageInputCapability('deepseek', 'deepseek-v4-pro')).toBe('unsupported')
  })
})
