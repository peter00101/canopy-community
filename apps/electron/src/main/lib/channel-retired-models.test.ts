/**
 * 官方已下线模型（gpt-5.3-codex-spark）存量清理的 BDD 测试。
 *
 * 上游 #2061 只过滤了 Pi 的 Codex 模型目录；我方老版本「拉取模型」已把 spark 以 fetched + enabled 写进 channels.json，
 * 中转网关 / 官方 API 渠道里也可能手填或拉取过它。官方下线后所有渠道都不会再有它，channel-manager 读取时按
 * @canopy/shared 的 isRetiredModelId 幂等纠正，这里守住：存量条目被移除且其他模型原样、所有渠道类型一视同仁、
 * 纠正幂等（干净配置读取不回写）、新建 / 更新渠道时同样不落盘。
 *
 * 注意：配置不带 appliedPresetModelUpdates 时，读取总会因预设更新回写，测不到 readConfig 里
 * `retiredPruned.changed` 这一写回条件；专门有一例把全部预设更新登记齐，让 spark 清理成为唯一的回写原因。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChannelManagerModule = typeof import('./channel-manager')

interface PersistedModel { id: string; name: string; enabled: boolean; source?: 'manual' | 'fetched' }
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

const SPARK: PersistedModel = { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', enabled: true, source: 'fetched' }
/** 老版本 Codex 登录后「拉取模型」写进渠道的样子：spark 排第一、全部 fetched + enabled，外加一条用户手动停用的。 */
const LEGACY_CODEX_MODELS: PersistedModel[] = [
  SPARK,
  { id: 'gpt-5.4', name: 'GPT-5.4', enabled: true, source: 'fetched' },
  { id: 'gpt-5.5', name: 'GPT-5.5', enabled: false, source: 'fetched' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', enabled: true, source: 'fetched' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', enabled: true },
]
const CLEAN_CODEX_MODELS = LEGACY_CODEX_MODELS.slice(1)

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

/** 带上 DeepSeek 渠道，避免 listChannels 首次使用时自动建预设渠道而回写文件、干扰「是否回写」断言。 */
function deepseekChannel(): PersistedChannel {
  return channel({
    id: 'deepseek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-test',
    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true }],
  })
}

function channelsPath(): string {
  return join(tempHome, CANOPY_BRAND.configDirName, 'channels.json')
}

function writeConfig(config: PersistedConfig): void {
  mkdirSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true })
  writeFileSync(channelsPath(), JSON.stringify(config), 'utf-8')
}

function readConfig(): PersistedConfig {
  return JSON.parse(readFileSync(channelsPath(), 'utf-8')) as PersistedConfig
}

/** writeJsonFileAtomic 覆盖已有文件前会先备份出 .bak；没有 .bak 即本次读取没有回写。 */
function backupPath(): string {
  return `${channelsPath()}.bak`
}

/**
 * channel-manager 当前登记的全部一次性预设更新 ID（PRESET_MODEL_CANDIDATE_UPDATES 未导出）。
 * 让模块自己把它们登记进一份只有 DeepSeek 渠道的配置再读回来，不在测试里抄一份迟早过期的名单；
 * 以后新增迁移 ID 也自动跟上。读完清掉临时配置，不影响调用方后续写入。
 */
function probeAllPresetModelUpdateIds(): string[] {
  writeConfig({ version: 3, channels: [deepseekChannel()] })
  channelManager.listChannels()
  const ids = readConfig().appliedPresetModelUpdates ?? []
  rmSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true, force: true })
  return ids
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-retired-models-'))
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

describe('渠道里官方已下线模型的清理 · gpt-5.3-codex-spark', () => {
  test('给定存量 Codex 渠道里有拉取写入的启用态 spark，当读取渠道时，则移除它，其余模型的顺序、启用态、来源原样，并落盘', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: LEGACY_CODEX_MODELS }), deepseekChannel()],
    })

    const codex = channelManager.listChannels().find((c) => c.provider === 'openai-codex')

    expect(codex?.models).toEqual(CLEAN_CODEX_MODELS)
    expect(readConfig().channels.find((c) => c.provider === 'openai-codex')?.models).toEqual(CLEAN_CODEX_MODELS)
    expect(existsSync(backupPath())).toBe(true)
  })

  test('给定配置已登记全部预设更新（没有别的迁移要做）且 Codex 渠道含 spark，当读取时，则仅因清理 spark 回写一次，再读不再回写', () => {
    const appliedPresetModelUpdates = probeAllPresetModelUpdateIds()
    expect(appliedPresetModelUpdates.length).toBeGreaterThan(0)

    // 对照：同一份配置去掉 spark 读取不回写——证明下面那次回写只能来自 spark 清理，而不是顺带的预设更新
    writeConfig({
      version: 3,
      appliedPresetModelUpdates,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: CLEAN_CODEX_MODELS }), deepseekChannel()],
    })
    channelManager.listChannels()
    expect(existsSync(backupPath())).toBe(false)

    writeConfig({
      version: 3,
      appliedPresetModelUpdates,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: LEGACY_CODEX_MODELS }), deepseekChannel()],
    })

    const first = channelManager.listChannels()

    expect(first.find((c) => c.provider === 'openai-codex')?.models).toEqual(CLEAN_CODEX_MODELS)
    expect(existsSync(backupPath())).toBe(true)
    const persisted = readConfig()
    expect(persisted.channels.find((c) => c.provider === 'openai-codex')?.models.map((m) => m.id))
      .not.toContain('gpt-5.3-codex-spark')
    expect(persisted.channels.find((c) => c.provider === 'openai-codex')?.models).toEqual(CLEAN_CODEX_MODELS)
    expect([...(persisted.appliedPresetModelUpdates ?? [])].sort()).toEqual([...appliedPresetModelUpdates].sort())

    rmSync(backupPath(), { force: true })
    const second = channelManager.listChannels()

    expect(second).toEqual(first)
    expect(existsSync(backupPath())).toBe(false)
  })

  test('给定 spark 的 ID 带大小写差异或首尾空白（手填条目），当读取时，则同样移除', () => {
    writeConfig({
      version: 3,
      channels: [
        channel({
          id: 'codex',
          provider: 'openai-codex',
          models: [
            { id: ' GPT-5.3-Codex-Spark ', name: '我的 Spark', enabled: true, source: 'manual' },
            ...CLEAN_CODEX_MODELS,
          ],
        }),
        deepseekChannel(),
      ],
    })

    expect(channelManager.listChannels().find((c) => c.provider === 'openai-codex')?.models)
      .toEqual(CLEAN_CODEX_MODELS)
  })

  test('给定官方 OpenAI API、Azure（Responses）与中转网关渠道里也有 spark（含带前缀写法），当读取时，则所有渠道都清掉、其余模型原样', () => {
    const keep: PersistedModel = { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true }
    writeConfig({
      version: 3,
      channels: [
        channel({ id: 'codex', provider: 'openai-codex', models: LEGACY_CODEX_MODELS }),
        channel({ id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-openai', models: [SPARK, keep] }),
        channel({ id: 'azure', provider: 'openai-responses', baseUrl: 'https://demo.openai.azure.com/openai/v1', apiKey: 'az', models: [keep, SPARK] }),
        channel({
          id: 'gateway',
          provider: 'custom',
          baseUrl: 'https://gateway.example.com/v1/chat/completions',
          apiKey: 'sk-tree',
          models: [{ id: 'openai/gpt-5.3-codex-spark', name: 'Spark（网关）', enabled: true }, keep],
        }),
        deepseekChannel(),
      ],
    })

    const channels = channelManager.listChannels()

    expect(channels.find((c) => c.id === 'codex')?.models).toEqual(CLEAN_CODEX_MODELS)
    for (const id of ['openai', 'azure', 'gateway']) {
      expect(channels.find((c) => c.id === id)?.models).toEqual([keep])
    }
    expect(JSON.stringify(readConfig())).not.toContain('codex-spark')
  })

  test('给定 spark 是 Codex 渠道唯一启用的模型，当读取时，则只移除它，不替用户启用别的模型', () => {
    const disabledRest: PersistedModel[] = [
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', enabled: false, source: 'fetched' },
      // 带上 gpt-6-astra，免得 openai-codex-gpt-6-astra-v1 预设更新往里追加启用态条目、混淆本条断言
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', enabled: false, source: 'fetched' },
    ]
    writeConfig({
      version: 3,
      channels: [
        channel({ id: 'codex', provider: 'openai-codex', models: [SPARK, ...disabledRest] }),
        deepseekChannel(),
      ],
    })

    const models = channelManager.listChannels().find((c) => c.provider === 'openai-codex')?.models ?? []

    expect(models).toEqual(disabledRest)
    expect(models.some((model) => model.enabled)).toBe(false)
  })

  test('给定已清理过一次的配置，当再次读取时，则结果不变且不回写文件（幂等）', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: LEGACY_CODEX_MODELS }), deepseekChannel()],
    })
    // 第一次读取：清理 spark，并顺带应用尚未登记的预设更新（与本条无关）后落盘
    const first = channelManager.listChannels()
    rmSync(backupPath(), { force: true })

    const second = channelManager.listChannels()
    const third = channelManager.listChannels()

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(existsSync(backupPath())).toBe(false)
  })

  test('给定用户手动给 Codex 渠道加回 spark，当更新渠道时，则不落盘、返回值与之后的读取一致', () => {
    writeConfig({
      version: 3,
      channels: [channel({ id: 'codex', provider: 'openai-codex', models: CLEAN_CODEX_MODELS }), deepseekChannel()],
    })
    channelManager.listChannels()

    const updated = channelManager.updateChannel('codex', {
      models: [...CLEAN_CODEX_MODELS, { id: 'gpt-5.3-codex-spark', name: 'Spark', enabled: true, source: 'manual' }],
    })

    expect(updated.models).toEqual(CLEAN_CODEX_MODELS)
    expect(readConfig().channels.find((c) => c.id === 'codex')?.models).toEqual(CLEAN_CODEX_MODELS)
    expect(channelManager.getChannelById('codex')?.models).toEqual(CLEAN_CODEX_MODELS)
  })

  test('给定新建 Codex 渠道与官方 API 渠道时都带着 spark，当创建时，则两者都不落盘', () => {
    writeConfig({ version: 3, channels: [deepseekChannel()] })

    const codex = channelManager.createChannel({
      name: 'ChatGPT',
      provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      apiKey: '',
      models: LEGACY_CODEX_MODELS,
      enabled: true,
    })
    const openai = channelManager.createChannel({
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      models: [SPARK, { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true }],
      enabled: true,
    })

    expect(codex.models).toEqual(CLEAN_CODEX_MODELS)
    expect(openai.models.map((m) => m.id)).toEqual(['gpt-5.5'])
    const persisted = readConfig().channels
    expect(persisted.find((c) => c.id === codex.id)?.models).toEqual(CLEAN_CODEX_MODELS)
    expect(persisted.find((c) => c.id === openai.id)?.models.map((m) => m.id)).toEqual(['gpt-5.5'])
  })
})
