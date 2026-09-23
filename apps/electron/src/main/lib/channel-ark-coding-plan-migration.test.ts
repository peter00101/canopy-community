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

const ARK_CURRENT_URL = PROVIDER_DEFAULT_URLS['ark-coding-plan']
const ARK_LEGACY_URL = 'https://ark.cn-beijing.volces.com/api/plan'

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

function writeArkChannel(baseUrl: string): void {
  const configDir = join(tempHome, CANOPY_BRAND.configDirName)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({
      version: 2,
      channels: [
        {
          id: 'ark-1',
          name: '火山方舟 Coding Plan',
          provider: 'ark-coding-plan',
          baseUrl,
          apiKey: 'sk-test',
          models: [],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    'utf-8',
  )
}

function readPersistedArkBaseUrl(): string | undefined {
  const persisted = JSON.parse(
    readFileSync(join(tempHome, CANOPY_BRAND.configDirName, 'channels.json'), 'utf-8'),
  ) as { channels: Array<{ provider: string; baseUrl: string }> }
  return persisted.channels.find((c) => c.provider === 'ark-coding-plan')?.baseUrl
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-ark-url-migration-'))
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

describe('火山方舟 Coding Plan 旧地址迁移', () => {
  test('存量旧地址 /api/plan 读取时迁移为 /api/coding 并回写', () => {
    writeArkChannel(ARK_LEGACY_URL)

    const channels = channelManager.listChannels()
    const ark = channels.find((c) => c.provider === 'ark-coding-plan')

    expect(ark?.baseUrl).toBe(ARK_CURRENT_URL)
    expect(readPersistedArkBaseUrl()).toBe(ARK_CURRENT_URL)
  })

  test('旧地址带尾斜杠同样识别并迁移', () => {
    writeArkChannel(`${ARK_LEGACY_URL}/`)

    const channels = channelManager.listChannels()
    const ark = channels.find((c) => c.provider === 'ark-coding-plan')

    expect(ark?.baseUrl).toBe(ARK_CURRENT_URL)
  })

  test('用户自定义的非旧地址不受影响', () => {
    writeArkChannel('https://my-gateway.example.com/ark')

    const channels = channelManager.listChannels()
    const ark = channels.find((c) => c.provider === 'ark-coding-plan')

    expect(ark?.baseUrl).toBe('https://my-gateway.example.com/ark')
  })

  test('现行地址不被重复迁移（幂等）', () => {
    writeArkChannel(ARK_CURRENT_URL)

    const channels = channelManager.listChannels()
    const ark = channels.find((c) => c.provider === 'ark-coding-plan')

    expect(ark?.baseUrl).toBe(ARK_CURRENT_URL)
  })
})
