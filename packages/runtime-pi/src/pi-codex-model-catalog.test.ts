/**
 * Codex 模型目录合并与模型解析的 BDD 测试（上游 #1999 GPT-6 Astra 收编时补写，上游本身零测试）。
 *
 * Pi 0.84.4 与 0.85.0 的 openai-codex 目录都没有 gpt-6（两版逐字节相同），gpt-6-astra 和 5.6 三款一样
 * 靠 CODEX_MODEL_PATCHES 整条自建；数值按 OpenAI 模型页（2026-09-05）。同时钉住 #1999 带来的行为变化：
 * 显式指定的模型查不到时报错，不再静默回退到首个内置模型。
 *
 * Pi 0.85.1 起目录原生带 gpt-6-astra（272K 窗口、cacheWrite 12.5 + 分层价、三个 compat 能力位）：
 * 合并改走「已有条目按字段覆盖」路径，我方列出的字段（372K、无 off 档位、cacheWrite 0）仍要胜出，
 * 原生的 compat 能力位则保留——末尾单独一例钉住这个合流点。
 *
 * 上游 #2061 下架 gpt-5.3-codex-spark：pi-ai 0.85.1 的 openai-codex 目录仍带它且排第一，
 * 合并目录与运行时目录都要过滤；会话等处仍显式指向它时报「已下线，请换一个模型」，不静默换模型。
 */

import { describe, expect, test } from 'bun:test'
import type { CodexOAuthCredentials } from '@canopy/shared'
import { buildCodexModel, buildModel, getCodexCatalogModels, listCodexModels } from './pi-model-registry'

const RETIRED_SPARK_ID = 'gpt-5.3-codex-spark'

const credentials: CodexOAuthCredentials = { access: 'access', refresh: 'refresh', expires: Date.now() + 3_600_000 }

function createFakeSdk(runtimeModels: { id: string }[]) {
  return {
    ModelRuntime: {
      create: async () => ({
        getModels: (provider: string) => (provider === 'openai-codex' ? runtimeModels : []),
        getModel: () => undefined,
      }),
    },
  } as unknown as Parameters<typeof buildCodexModel>[0]
}

describe('Codex 模型目录 · GPT-6 Astra', () => {
  test('给定 Pi 内置目录没有 gpt-6，当合并 Codex 目录时，则自建一条 gpt-6-astra，数值按官方模型页', async () => {
    const models = await getCodexCatalogModels()
    const astra = models.find((model) => model.id === 'gpt-6-astra')

    expect(astra).toMatchObject({
      name: 'GPT-6 Astra',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      reasoning: true,
      contextWindow: 372_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
    })
    // 档位表来自 astra profile：off / minimal 落 low，xhigh / max 显式保留，没有 none。
    expect(astra?.thinkingLevelMap).toMatchObject({ off: 'low', minimal: 'low', xhigh: 'xhigh', max: 'max' })
    expect(Object.values(astra?.thinkingLevelMap ?? {})).not.toContain('none')
  })

  test('给定渲染层拉取 Codex 模型列表，当列出时，则包含 gpt-6-astra 且 5.6 三款仍在', async () => {
    const ids = (await listCodexModels()).map((model) => model.id)

    expect(ids).toContain('gpt-6-astra')
    expect(ids).toEqual(expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']))
  })

  test('给定 Pi 0.85.1 内置目录已原生带 gpt-6-astra，当合并时，则只有一条、我方窗口与档位覆盖原生、原生 compat 能力位保留', async () => {
    const models = await getCodexCatalogModels()
    const astra = models.filter((model) => model.id === 'gpt-6-astra')

    expect(astra).toHaveLength(1)
    // 我方 patch 列出的字段胜出：372K（维护者定）、cacheWrite 0、off 落 low（原生是 off: null）
    expect(astra[0]).toMatchObject({ contextWindow: 372_000, cost: { cacheWrite: 0 } })
    expect(astra[0]?.thinkingLevelMap).toMatchObject({ off: 'low' })
    // 原生条目带的三个能力位不在我方 patch 里，合并后应原样保留
    expect(astra[0]?.compat).toMatchObject({ supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true })
  })
})

describe('buildCodexModel · 模型解析（#1999 起显式模型缺失即报错）', () => {
  test('给定显式指定了目录里没有的模型，当构建时，则报错点名该模型，不再静默回退到首个内置模型', async () => {
    const sdk = createFakeSdk([{ id: 'gpt-5.6-terra' }])

    await expect(buildCodexModel(sdk, { model: 'gpt-7-nope', codexOAuthCredentials: credentials }))
      .rejects.toThrow('未找到指定的 ChatGPT (Codex) 模型: gpt-7-nope')
  })

  test('给定运行时目录里没有 gpt-6-astra 但合并目录里有，当构建时，则从合并目录命中并带正确窗口', async () => {
    const sdk = createFakeSdk([{ id: 'gpt-5.6-terra' }])

    const { model } = await buildCodexModel(sdk, { model: 'gpt-6-astra', codexOAuthCredentials: credentials })

    expect(model.id).toBe('gpt-6-astra')
    expect(model.contextWindow).toBe(372_000)
  })

  test('给定未指定模型，当构建时，则仍取运行时目录的首个内置模型', async () => {
    const sdk = createFakeSdk([{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.5' }])

    const { model } = await buildCodexModel(sdk, { codexOAuthCredentials: credentials })

    expect(model.id).toBe('gpt-5.6-terra')
  })

  test('给定既未指定模型、运行时目录也为空，当构建时，则报「未找到可用模型」', async () => {
    await expect(buildCodexModel(createFakeSdk([]), { codexOAuthCredentials: credentials }))
      .rejects.toThrow('未找到可用的 ChatGPT (Codex) 模型')
  })

  test('给定没有 OAuth 凭据，当构建时，则先于模型解析报凭据缺失', async () => {
    await expect(buildCodexModel(createFakeSdk([]), { model: 'gpt-6-astra' }))
      .rejects.toThrow('ChatGPT (Codex) OAuth 凭据缺失')
  })
})

describe('官方已下线模型 · gpt-5.3-codex-spark（上游 #2061，我方扩到所有渠道）', () => {
  test('给定 pi-ai 原始 openai-codex 目录（前提对照），当直接读取时，则它仍带着 spark——过滤才有意义', async () => {
    // 升级 pi-ai 后若原始目录已不带 spark，本条会失败：届时确认后可删本条，过滤逻辑保留无害。
    const { getModels } = await import('@earendil-works/pi-ai/compat')

    expect(getModels('openai-codex').map((model) => model.id)).toContain(RETIRED_SPARK_ID)
  })

  test('给定原始目录带 spark，当合并 Codex 目录与渲染层拉取列表时，则都不含它、其余模型照旧', async () => {
    const catalogIds = (await getCodexCatalogModels()).map((model) => model.id)
    const listedIds = (await listCodexModels()).map((model) => model.id)

    expect(catalogIds).not.toContain(RETIRED_SPARK_ID)
    expect(listedIds).not.toContain(RETIRED_SPARK_ID)
    expect(listedIds).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.6-terra', 'gpt-6-astra']))
    // Pi 0.86 按 OpenAI 撤掉 Codex 的 GPT-5.4 / 5.4 mini（Pi changelog #9394）：我方补丁表里那两条只是字段覆盖，
    // 原生条目缺失时不会自建出残缺条目
    expect(listedIds).not.toContain('gpt-5.4')
    expect(listedIds).not.toContain('gpt-5.4-mini')
  })

  test('给定会话仍显式指定 spark，当构建时，则报已下线（官方停止提供），不回退到别的模型', async () => {
    const sdk = createFakeSdk([{ id: RETIRED_SPARK_ID }, { id: 'gpt-5.6-terra' }])

    await expect(buildCodexModel(sdk, { model: RETIRED_SPARK_ID, codexOAuthCredentials: credentials }))
      .rejects.toThrow(`模型 ${RETIRED_SPARK_ID} 已下线（官方停止提供），请换一个模型`)
  })

  test('给定指定的 spark 带大小写差异与 [1m] 后缀，当构建时，则同样判为下线而不是「未找到」', async () => {
    const sdk = createFakeSdk([{ id: RETIRED_SPARK_ID }, { id: 'gpt-5.6-terra' }])

    await expect(buildCodexModel(sdk, { model: 'GPT-5.3-Codex-Spark[1m]', codexOAuthCredentials: credentials }))
      .rejects.toThrow('已下线（官方停止提供），请换一个模型')
  })

  test('给定运行时目录首个就是 spark（与 pi-ai 0.85.1 顺序一致），当未指定模型构建时，则跳过它取下一个', async () => {
    const sdk = createFakeSdk([{ id: RETIRED_SPARK_ID }, { id: 'gpt-5.6-terra' }])

    const { model } = await buildCodexModel(sdk, { codexOAuthCredentials: credentials })

    expect(model.id).toBe('gpt-5.6-terra')
  })

  test('给定运行时目录只剩 spark，当未指定模型构建时，则报「未找到可用模型」而不是把下线模型交出去', async () => {
    await expect(buildCodexModel(createFakeSdk([{ id: RETIRED_SPARK_ID }]), { codexOAuthCredentials: credentials }))
      .rejects.toThrow('未找到可用的 ChatGPT (Codex) 模型')
  })

  test('给定网关 / 官方 API 等非 Codex 渠道的会话仍指定 spark，当构建模型时，则在发请求前同样报已下线，不注册 provider', async () => {
    let created = false
    const sdk = {
      ModelRuntime: { create: async () => { created = true; return {} } },
    } as unknown as Parameters<typeof buildModel>[0]

    for (const provider of ['openai-responses', 'openai', 'custom'] as const) {
      await expect(buildModel(sdk, {
        provider,
        model: 'openai/GPT-5.3-Codex-Spark',
        apiKey: 'sk-test',
        baseUrl: 'https://gateway.example.com',
        sessionId: 's1',
      } as unknown as Parameters<typeof buildModel>[1])).rejects.toThrow('已下线（官方停止提供），请换一个模型')
    }
    expect(created).toBe(false)
  })
})
