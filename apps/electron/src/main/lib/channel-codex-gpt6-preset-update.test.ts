/**
 * Codex 渠道一次性预设更新（上游 #1999 GPT-6 Astra）的 BDD 测试。
 *
 * 预设更新自本轮起改成逐条登记：每条独立 ID、只追加新增模型、已应用过的条目跳过。
 * 这里守住四件事：存量 Codex 渠道自动收到 gpt-6-astra（启用态，与登录拉取同语义）、
 * 已应用过的不重复追加（用户删掉就是删掉）、用户已有的同名条目不被覆盖、别的渠道不受影响。
 *
 * 0.18.83 起另守一件事：预设更新可以「原地改名」——DeepSeek 把 V4.1 Flash 的现行 ID 定为 deepseek-flash，
 * 0.18.77~0.18.82 追加进用户渠道的 deepseek-v4.1-flash 在 API 上无效，迁移要把它换成新 ID 而不是留着。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChannelManagerModule = typeof import('./channel-manager')

interface PersistedModel { id: string; name: string; enabled: boolean }
interface PersistedChannel {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  models: PersistedModel[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}
interface PersistedConfig {
  version: number
  channels: PersistedChannel[]
  appliedPresetModelUpdates?: string[]
}

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalAppDev = process.env.CANOPY_DEV

const ASTRA_UPDATE_ID = 'openai-codex-gpt-6-astra-v1'
const V3_UPDATE_ID = 'model-candidates-v3'
/**
 * 上游 0.19.52 (#2036) 新增的预设迁移，0.19.53 (#2042) 随模型 ID 一起改名为 deepseek-flash-v1；
 * 我方在改名之外还原地替换旧 ID。每收一条新迁移，下面的登记断言都要跟着补。
 */
const DS_FLASH_UPDATE_ID = 'deepseek-flash-v1'
/** 上游 0.19.57（#2077）新增：存量智谱渠道补 GLM-5.3-FlashX，排在 v3 之后、astra 之前。 */
const V4_UPDATE_ID = 'model-candidates-v4'
/** 0.18.77~0.18.82 已经登记过的旧迁移 ID：新 ID 不能因它被跳过。 */
const LEGACY_DS41_UPDATE_ID = 'deepseek-v41-flash-v1'
const GPT56_MODELS: PersistedModel[] = [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', enabled: true }]

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function channel(overrides: Partial<PersistedChannel> & Pick<PersistedChannel, 'id' | 'provider' | 'models'>): PersistedChannel {
  return {
    name: overrides.id,
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function deepseekChannel(models: PersistedModel[], overrides: Partial<PersistedChannel> = {}): PersistedChannel {
  return channel({
    id: 'deepseek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-test',
    models,
    ...overrides,
  })
}

function writeConfig(config: PersistedConfig): void {
  const configDir = join(tempHome, CANOPY_BRAND.configDirName)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'channels.json'), JSON.stringify(config), 'utf-8')
}

function readConfig(): PersistedConfig {
  return JSON.parse(readFileSync(join(tempHome, CANOPY_BRAND.configDirName, 'channels.json'), 'utf-8')) as PersistedConfig
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-codex-gpt6-preset-'))
  process.env.HOME = tempHome
  process.env.CANOPY_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalAppDev === undefined) {
    delete process.env.CANOPY_DEV
  } else {
    process.env.CANOPY_DEV = originalAppDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Codex 渠道一次性预设更新 · GPT-6 Astra', () => {
  test('给定存量 Codex 渠道（v3 候选已应用过），当读取渠道时，则追加启用态的 gpt-6-astra 并登记更新 ID', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: GPT56_MODELS })],
      appliedPresetModelUpdates: [V3_UPDATE_ID],
    })

    const loaded = channelManager.listChannels()[0]

    expect(loaded?.models.map((model) => model.id)).toEqual(['gpt-5.6-terra', 'gpt-6-astra'])
    expect(loaded?.models.find((model) => model.id === 'gpt-6-astra')).toMatchObject({ name: 'GPT-6 Astra', enabled: true })
    const persisted = readConfig()
    // 遍历顺序是 ds-flash → v3 → v4 → astra：v3 已应用被跳过，其余三条按序追加到已有列表之后
    expect(persisted.appliedPresetModelUpdates).toEqual([V3_UPDATE_ID, DS_FLASH_UPDATE_ID, V4_UPDATE_ID, ASTRA_UPDATE_ID])
    expect(persisted.channels[0]?.models.map((model) => model.id)).toContain('gpt-6-astra')
  })

  test('给定该更新已应用过、用户随后删掉了 gpt-6-astra，当再次读取时，则不再塞回去（幂等）', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: GPT56_MODELS })],
      appliedPresetModelUpdates: [V3_UPDATE_ID, ASTRA_UPDATE_ID],
    })

    expect(channelManager.listChannels()[0]?.models.map((model) => model.id)).toEqual(['gpt-5.6-terra'])
    // 幂等针对的是已登记条目：这两条不重复应用，只有新来的 ds-flash 与 v4 被追加
    expect(readConfig().appliedPresetModelUpdates).toEqual([V3_UPDATE_ID, ASTRA_UPDATE_ID, DS_FLASH_UPDATE_ID, V4_UPDATE_ID])
  })

  test('给定用户已手动加过 gpt-6-astra（自定义名、禁用），当更新应用时，则保留用户条目、不覆盖不重复', () => {
    writeConfig({
      version: 3,
      channels: [channel({
        id: 'codex',
        provider: 'openai-codex',
        models: [...GPT56_MODELS, { id: 'gpt-6-astra', name: '我的 Astra', enabled: false }],
      })],
      appliedPresetModelUpdates: [V3_UPDATE_ID],
    })

    const models = channelManager.listChannels()[0]?.models ?? []

    expect(models.filter((model) => model.id === 'gpt-6-astra')).toEqual([
      { id: 'gpt-6-astra', name: '我的 Astra', enabled: false },
    ])
    expect(readConfig().appliedPresetModelUpdates).toContain(ASTRA_UPDATE_ID)
  })

  test('给定非 Codex 渠道（如走 Responses 协议的网关渠道），当更新应用时，则不注入 gpt-6-astra', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'gateway', provider: 'openai-responses', baseUrl: 'https://gateway.example.com/v1', models: GPT56_MODELS })],
      appliedPresetModelUpdates: [V3_UPDATE_ID],
    })

    expect(channelManager.listChannels()[0]?.models.map((model) => model.id)).toEqual(['gpt-5.6-terra'])
  })

  test('给定更老的配置连 v3 候选都没应用过，当读取时，则四条更新按序一次应用完、互不干扰', () => {
    writeConfig({
      version: 3,
      channels: [
        channel({ id: 'codex', provider: 'openai-codex', models: GPT56_MODELS }),
        deepseekChannel([{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true }]),
      ],
    })

    const channels = channelManager.listChannels()

    expect(channels.find((c) => c.provider === 'openai-codex')?.models.map((model) => model.id)).toEqual(['gpt-5.6-terra', 'gpt-6-astra'])
    expect(channels.find((c) => c.provider === 'deepseek')?.models.find((model) => model.id === 'deepseek-v4-flash-vision-exp'))
      .toMatchObject({ enabled: false })
    // 初始一条都没登记过，四条按 PRESET 列表顺序依次应用
    expect(readConfig().appliedPresetModelUpdates).toEqual([DS_FLASH_UPDATE_ID, V3_UPDATE_ID, V4_UPDATE_ID, ASTRA_UPDATE_ID])
  })
})

describe('DeepSeek 渠道预设更新 · V4.1 Flash 改名 deepseek-flash（deepseek-flash-v1）', () => {
  const LEGACY_FLASH_MODELS: PersistedModel[] = [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: false },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', enabled: false },
  ]
  const ALL_PREVIOUS_UPDATES = [LEGACY_DS41_UPDATE_ID, V3_UPDATE_ID, ASTRA_UPDATE_ID]

  test('给定 0.18.82 用户渠道里有旧迁移追加的禁用 deepseek-v4.1-flash，当读取时，则原地改成 deepseek-flash、位置与禁用态不变、不再重复追加', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel(LEGACY_FLASH_MODELS)],
      appliedPresetModelUpdates: ALL_PREVIOUS_UPDATES,
    })

    const models = channelManager.listChannels()[0]?.models ?? []

    expect(models.map((model) => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(models.find((model) => model.id === 'deepseek-flash')).toEqual({ id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: false })
    // 旧迁移 ID 已登记不影响新 ID 的应用；新 ID 追加登记（v4 对 DeepSeek 渠道无改动，照样登记）
    expect(readConfig().appliedPresetModelUpdates).toEqual([...ALL_PREVIOUS_UPDATES, DS_FLASH_UPDATE_ID, V4_UPDATE_ID])
  })

  test('给定用户已把 deepseek-v4.1-flash 启用并改了自定义名，当改名迁移时，则只换 ID、启用态与自定义名都保留', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel([
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: 'deepseek-v4.1-flash', name: '我的 Flash', enabled: true },
      ])],
      appliedPresetModelUpdates: ALL_PREVIOUS_UPDATES,
    })

    const models = channelManager.listChannels()[0]?.models ?? []

    expect(models).toEqual([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
      { id: 'deepseek-flash', name: '我的 Flash', enabled: true },
    ])
  })

  test('给定用户已手动加了 deepseek-flash 而旧的 deepseek-v4.1-flash 还在，当改名迁移时，则删掉旧条目、用户那条原样保留', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel([
        { id: 'deepseek-flash', name: '我的 Flash', enabled: true },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: false },
      ])],
      appliedPresetModelUpdates: ALL_PREVIOUS_UPDATES,
    })

    const models = channelManager.listChannels()[0]?.models ?? []

    expect(models).toEqual([{ id: 'deepseek-flash', name: '我的 Flash', enabled: true }])
  })

  test('给定火山 Coding Plan 渠道也带着旧 ID，当改名迁移时，则同样改名；别的供应商里手填的同名条目不动', () => {
    writeConfig({
      version: 3,
      channels: [
        channel({
          id: 'ark',
          provider: 'ark-coding-plan',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
          models: [
            { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
            { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: false },
          ],
        }),
        channel({
          id: 'gateway',
          provider: 'openai-responses',
          baseUrl: 'https://gateway.example.com/v1',
          models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true }],
        }),
      ],
      appliedPresetModelUpdates: ALL_PREVIOUS_UPDATES,
    })

    const channels = channelManager.listChannels()

    expect(channels.find((c) => c.provider === 'ark-coding-plan')?.models).toEqual([
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: false },
    ])
    expect(channels.find((c) => c.provider === 'openai-responses')?.models).toEqual([
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true },
    ])
  })

  test('给定渠道里从没有过 deepseek-v4.1-flash（旧迁移之前的用户），当读取时，则只追加禁用态的 deepseek-flash', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel([
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      ])],
      appliedPresetModelUpdates: [V3_UPDATE_ID, ASTRA_UPDATE_ID],
    })

    const models = channelManager.listChannels()[0]?.models ?? []

    expect(models.map((model) => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-flash'])
    expect(models.find((model) => model.id === 'deepseek-flash')).toMatchObject({ name: 'DeepSeek Flash', enabled: false })
    expect(readConfig().appliedPresetModelUpdates).toEqual([V3_UPDATE_ID, ASTRA_UPDATE_ID, DS_FLASH_UPDATE_ID, V4_UPDATE_ID])
  })

  test('给定改名迁移已登记，当用户之后删掉 deepseek-flash 再读取时，则不再塞回去（幂等）', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel([{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true }])],
      appliedPresetModelUpdates: [...ALL_PREVIOUS_UPDATES, DS_FLASH_UPDATE_ID],
    })

    expect(channelManager.listChannels()[0]?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro'])
  })

  test('给定用户渠道里的旧 ID 大小写 / 空白与预设不同，当改名迁移时，则同样认得出并改成新 ID', () => {
    writeConfig({
      version: 3,
      channels: [deepseekChannel([
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: ' DeepSeek-V4.1-Flash ', name: 'DeepSeek V4.1 Flash', enabled: true },
      ])],
      appliedPresetModelUpdates: ALL_PREVIOUS_UPDATES,
    })

    expect(channelManager.listChannels()[0]?.models).toEqual([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true },
    ])
  })
})

describe('智谱渠道预设更新 · GLM-5.3-FlashX（model-candidates-v4，收上游 #2077）', () => {
  const ZHIPU_V3_MODELS: PersistedModel[] = [
    { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true },
  ]
  const APPLIED_BEFORE_V4 = [DS_FLASH_UPDATE_ID, V3_UPDATE_ID, ASTRA_UPDATE_ID]

  function zhipuChannel(provider: string, models: PersistedModel[]): PersistedChannel {
    return channel({ id: provider, provider, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-test', models })
  }

  test('给定已应用过 v3 的三类智谱渠道，当读取时，则各追加一条禁用态 glm-5.3-flashx 并登记 v4', () => {
    writeConfig({
      version: 3,
      channels: [
        zhipuChannel('zhipu', ZHIPU_V3_MODELS),
        zhipuChannel('zhipu-coding', ZHIPU_V3_MODELS),
        zhipuChannel('zhipu-coding-team', ZHIPU_V3_MODELS),
      ],
      appliedPresetModelUpdates: APPLIED_BEFORE_V4,
    })

    // 配置里没有 DeepSeek 渠道时应用会自动补建一个预设渠道，只看三类智谱渠道
    const zhipuChannels = channelManager.listChannels().filter((c) => c.provider.startsWith('zhipu'))
    expect(zhipuChannels).toHaveLength(3)
    for (const loaded of zhipuChannels) {
      expect(loaded.models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'])
      expect(loaded.models.at(-1)).toEqual({ id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', enabled: false })
    }
    expect(readConfig().appliedPresetModelUpdates).toEqual([...APPLIED_BEFORE_V4, V4_UPDATE_ID])
  })

  test('给定用户已手填过大小写或空白不同的 FlashX，当 v4 应用时，则认作已存在、不重复追加', () => {
    writeConfig({
      version: 3,
      channels: [zhipuChannel('zhipu', [...ZHIPU_V3_MODELS, { id: ' GLM-5.3-FlashX ', name: '我的 FlashX', enabled: true }])],
      appliedPresetModelUpdates: APPLIED_BEFORE_V4,
    })

    expect(channelManager.listChannels().find((c) => c.provider === 'zhipu')?.models).toEqual([
      ...ZHIPU_V3_MODELS,
      { id: ' GLM-5.3-FlashX ', name: '我的 FlashX', enabled: true },
    ])
  })

  test('给定非智谱渠道（火山 / 网关）带着 glm-5.3，当 v4 应用时，则不注入 FlashX', () => {
    writeConfig({
      version: 3,
      channels: [
        channel({ id: 'ark', provider: 'ark-coding-plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', models: [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }] }),
        channel({ id: 'gateway', provider: 'openai-responses', baseUrl: 'https://gateway.example.com/v1', models: [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }] }),
      ],
      appliedPresetModelUpdates: APPLIED_BEFORE_V4,
    })

    const targets = channelManager.listChannels().filter((c) => c.provider === 'ark-coding-plan' || c.provider === 'openai-responses')
    expect(targets).toHaveLength(2)
    for (const loaded of targets) {
      expect(loaded.models.map((model) => model.id)).toEqual(['glm-5.3'])
    }
  })

  test('给定 v4 已登记、用户随后删掉了 FlashX，当再次读取时，则不再塞回去（幂等）', () => {
    writeConfig({
      version: 3,
      channels: [zhipuChannel('zhipu', ZHIPU_V3_MODELS)],
      appliedPresetModelUpdates: [...APPLIED_BEFORE_V4, V4_UPDATE_ID],
    })

    expect(channelManager.listChannels().find((c) => c.provider === 'zhipu')?.models).toEqual(ZHIPU_V3_MODELS)
  })
})

describe('预设改名的边界（applyPresetModelRename）', () => {
  const rename = { fromId: 'deepseek-v4.1-flash', fromName: 'DeepSeek V4.1 Flash', toId: 'deepseek-flash', toName: 'DeepSeek Flash' }

  test('给定新 ID 已以大小写变体存在，当改名时，则删掉全部旧条目、保留用户那条', () => {
    const models = [
      { id: 'DeepSeek-Flash', name: '我的 Flash', enabled: true },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: false },
      { id: 'DEEPSEEK-V4.1-FLASH', name: 'DeepSeek V4.1 Flash', enabled: false },
    ]
    expect(channelManager.applyPresetModelRename(models, rename)).toEqual([{ id: 'DeepSeek-Flash', name: '我的 Flash', enabled: true }])
  })

  test('给定渠道里没有旧 ID，当改名时，则无事发生', () => {
    expect(channelManager.applyPresetModelRename([{ id: 'deepseek-v4-pro', name: 'V4 Pro', enabled: true }], rename)).toBeUndefined()
  })

  test('给定一条只改大小写的改名（归一化后新旧同名），当应用时，则不动用户条目、更不能把它删掉', () => {
    const caseOnly = { fromId: 'glm-5.3', fromName: 'GLM-5.3', toId: 'GLM-5.3', toName: 'GLM-5.3' }
    expect(channelManager.applyPresetModelRename([{ id: 'glm-5.3', name: 'GLM-5.3', enabled: true }], caseOnly)).toBeUndefined()
  })
})
