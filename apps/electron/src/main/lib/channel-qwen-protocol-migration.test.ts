/**
 * 渠道配置 v2 → v3 迁移的 BDD 测试（上游 #1766）。
 *
 * 背景：DashScope 的 Anthropic 兼容端点拉不到模型列表，OpenAI 兼容端点才是阿里主推。
 * 迁移只动「仍在用默认 Anthropic 端点」的通义千问渠道，用户自定义端点保持原样，
 * 避免替用户改掉他明确配置过的请求协议。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { PROVIDER_DEFAULT_URLS } from '@canopy/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalAppDev = process.env.CANOPY_DEV

const QWEN_ANTHROPIC_URL = PROVIDER_DEFAULT_URLS['qwen-anthropic']
const QWEN_OPENAI_URL = PROVIDER_DEFAULT_URLS.qwen

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

function writeQwenChannel(provider: string, baseUrl: string, version = 2): void {
  const configDir = join(tempHome, CANOPY_BRAND.configDirName)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({
      version,
      channels: [
        {
          id: 'qwen-1',
          name: '通义千问',
          provider,
          baseUrl,
          apiKey: 'sk-test',
          models: [{ id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true }],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    'utf-8',
  )
}

function readPersistedChannel(): { provider: string; baseUrl: string } | undefined {
  const persisted = JSON.parse(
    readFileSync(join(tempHome, CANOPY_BRAND.configDirName, 'channels.json'), 'utf-8'),
  ) as { channels: Array<{ provider: string; baseUrl: string }> }
  return persisted.channels[0]
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-qwen-protocol-migration-'))
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

describe('通义千问渠道 v2 → v3 协议迁移', () => {
  test('给定存量渠道用默认 Anthropic 端点，当读取渠道时，则切成 OpenAI 兼容协议并回写', () => {
    writeQwenChannel('qwen-anthropic', QWEN_ANTHROPIC_URL)

    const channel = channelManager.listChannels()[0]

    expect(channel?.provider).toBe('qwen')
    expect(channel?.baseUrl).toBe(QWEN_OPENAI_URL)
    expect(readPersistedChannel()).toMatchObject({ provider: 'qwen', baseUrl: QWEN_OPENAI_URL })
  })

  test('给定默认端点带尾斜杠，当读取时，则同样识别并迁移', () => {
    writeQwenChannel('qwen-anthropic', `${QWEN_ANTHROPIC_URL}/`)

    expect(channelManager.listChannels()[0]?.provider).toBe('qwen')
  })

  test('给定用户自定义的 Anthropic 网关地址，当读取时，则协议与地址都保持不变', () => {
    writeQwenChannel('qwen-anthropic', 'https://my-gateway.example.com/anthropic')

    const channel = channelManager.listChannels()[0]

    expect(channel?.provider).toBe('qwen-anthropic')
    expect(channel?.baseUrl).toBe('https://my-gateway.example.com/anthropic')
  })

  test('给定配置已是 v3，当读取时，则不再重复迁移（幂等）', () => {
    writeQwenChannel('qwen-anthropic', QWEN_ANTHROPIC_URL, 3)

    const channel = channelManager.listChannels()[0]

    expect(channel?.provider).toBe('qwen-anthropic')
    expect(channel?.baseUrl).toBe(QWEN_ANTHROPIC_URL)
  })

  test('给定非通义千问渠道，当迁移发生时，则不受影响', () => {
    writeQwenChannel('deepseek', 'https://api.deepseek.com')

    const channel = channelManager.listChannels()[0]

    expect(channel?.provider).toBe('deepseek')
    expect(channel?.baseUrl).toBe('https://api.deepseek.com')
  })
})
