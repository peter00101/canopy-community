import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStableDingTalkBotId } from './dingtalk-bot-identity'
import { configureImBridgeBusiness } from './im-bridge-business-deps'

type DingTalkConfigModule = typeof import('./dingtalk-config')

let dingtalkConfig: DingTalkConfigModule
let dir: string

function dingTalkConfigPath(): string {
  return join(dir, 'dingtalk.json')
}

function dingTalkBotBindingsPath(botId: string): string {
  return join(dir, `dingtalk-bindings-${botId}.json`)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-dingtalk-config-'))
  dingtalkConfig = await import('./dingtalk-config')

  configureImBridgeBusiness({
    paths: {
      getFeishuConfigPath: () => join(dir, 'feishu.json'),
      getFeishuBotBindingsPath: (botId) => join(dir, `feishu-bindings-${botId}.json`),
      getFeishuBotMetadataPath: (botId) => join(dir, `feishu-metadata-${botId}.json`),
      getDingTalkConfigPath: dingTalkConfigPath,
      getDingTalkBotBindingsPath: dingTalkBotBindingsPath,
      getWeChatConfigPath: () => join(dir, 'wechat.json'),
      getWeChatBindingsPath: () => join(dir, 'wechat-bindings.json'),
      getWeChatSyncPath: () => join(dir, 'wechat-sync.json'),
      getAgentSessionWorkspacePath: (slug, sessionId) => join(dir, 'agent-workspaces', slug, sessionId),
      resolveAgentSessionWorkspacePath: (slug, sessionId) => join(dir, 'agent-workspaces', slug, sessionId),
    },
    getSettings: () => ({}),
    workspaces: {
      getAgentWorkspace: () => undefined,
      getProjectFilesPath: () => '',
      getWorkspaceCapabilities: () => ({ mcpServers: [], builtinMcpServers: [], skills: [], memory: { autoMemory: {} } }) as never,
      listAgentWorkspacesByUpdatedAt: () => [],
    },
    channels: {
      listChannels: () => [],
      getChannelById: () => undefined,
    },
    agentRunner: {
      runAgentHeadless: async () => {},
      stopAgent: () => false,
      isAgentSessionActive: () => false,
      onAgentEvent: () => () => {},
    },
    window: {
      sendToMainWindow: () => {},
      broadcastToAllWindows: () => {},
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString('utf-8'),
    },
    powerMonitor: {
      on: () => {},
      off: () => {},
    },
  })
})

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('钉钉 Bot 配置迁移', () => {
  test('Given 相同 Client ID When 生成 Bot ID Then 返回稳定值', () => {
    const first = createStableDingTalkBotId('ding-app-key')
    const second = createStableDingTalkBotId('  ding-app-key  ')

    expect(first).toBe(second)
    expect(first).toStartWith('dingtalk-bot-')
  })

  test('Given v2 配置仍使用旧随机 Bot ID When 读取配置 Then 稳定 Bot ID 并迁移绑定文件', () => {
    const legacyBotId = 'legacy-random-bot-id'
    const clientId = 'ding-app-key'
    const stableBotId = createStableDingTalkBotId(clientId)!
    const bindings = [
      {
        chatId: 'ding-conversation-1',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
    ]

    writeFileSync(dingTalkConfigPath(), JSON.stringify({
      version: 2,
      bots: [
        {
          id: legacyBotId,
          name: '钉钉助手',
          enabled: true,
          clientId,
          clientSecret: 'secret',
          defaultWorkspaceId: 'workspace-1',
        },
      ],
    }, null, 2), 'utf-8')
    writeFileSync(dingTalkBotBindingsPath(legacyBotId), JSON.stringify(bindings, null, 2), 'utf-8')

    const config = dingtalkConfig.getDingTalkMultiBotConfig()

    expect(config.bots[0]?.id).toBe(stableBotId)
    expect(existsSync(dingTalkBotBindingsPath(legacyBotId))).toBe(false)
    expect(JSON.parse(readFileSync(dingTalkBotBindingsPath(stableBotId), 'utf-8'))).toEqual(bindings)
  })

  test('Given 旧绑定文件与稳定路径绑定文件同时存在 When 迁移 Then 按 chatId 去重合并', () => {
    const legacyBotId = 'legacy-random-bot-id-2'
    const clientId = 'ding-app-key-2'
    const stableBotId = createStableDingTalkBotId(clientId)!

    const oldBindings = [
      { chatId: 'chat-shared', sessionId: 'old-session', workspaceId: 'ws-1', channelId: 'ch-1' },
      { chatId: 'chat-only-old', sessionId: 'session-old', workspaceId: 'ws-1', channelId: 'ch-2' },
    ]
    const existingBindings = [
      { chatId: 'chat-shared', sessionId: 'new-session', workspaceId: 'ws-1', channelId: 'ch-1' },
      { chatId: 'chat-only-new', sessionId: 'session-new', workspaceId: 'ws-1', channelId: 'ch-3' },
    ]

    writeFileSync(dingTalkConfigPath(), JSON.stringify({
      version: 2,
      bots: [
        {
          id: legacyBotId,
          name: '钉钉助手',
          enabled: true,
          clientId,
          clientSecret: 'secret',
          defaultWorkspaceId: 'ws-1',
        },
      ],
    }, null, 2), 'utf-8')
    writeFileSync(dingTalkBotBindingsPath(legacyBotId), JSON.stringify(oldBindings, null, 2), 'utf-8')
    writeFileSync(dingTalkBotBindingsPath(stableBotId), JSON.stringify(existingBindings, null, 2), 'utf-8')

    const config = dingtalkConfig.getDingTalkMultiBotConfig()

    expect(config.bots[0]?.id).toBe(stableBotId)
    expect(existsSync(dingTalkBotBindingsPath(legacyBotId))).toBe(false)

    const merged = JSON.parse(readFileSync(dingTalkBotBindingsPath(stableBotId), 'utf-8'))
    const chatIds = merged.map((b: { chatId: string }) => b.chatId).sort()
    expect(chatIds).toEqual(['chat-only-new', 'chat-only-old', 'chat-shared'])
    // target（稳定路径）的条目优先
    const shared = merged.find((b: { chatId: string }) => b.chatId === 'chat-shared')
    expect(shared.sessionId).toBe('new-session')
  })

  test('Given 已有 Bot 修改 Client ID When 保存配置 Then 立即返回新稳定 Bot ID 并迁移绑定文件', () => {
    const oldClientId = 'ding-old-app-key'
    const nextClientId = 'ding-next-app-key'
    const oldBotId = createStableDingTalkBotId(oldClientId)!
    const nextBotId = createStableDingTalkBotId(nextClientId)!
    const bindings = [
      { chatId: 'chat-existing', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1' },
    ]

    writeFileSync(dingTalkConfigPath(), JSON.stringify({
      version: 2,
      bots: [
        {
          id: oldBotId,
          name: '钉钉助手',
          enabled: true,
          clientId: oldClientId,
          clientSecret: 'secret',
          defaultWorkspaceId: 'ws-1',
        },
      ],
    }, null, 2), 'utf-8')
    writeFileSync(dingTalkBotBindingsPath(oldBotId), JSON.stringify(bindings, null, 2), 'utf-8')

    const saved = dingtalkConfig.saveDingTalkBotConfig({
      id: oldBotId,
      name: '钉钉助手',
      enabled: true,
      clientId: nextClientId,
      clientSecret: '',
      defaultWorkspaceId: 'ws-1',
    })

    expect(saved.id).toBe(nextBotId)
    expect(dingtalkConfig.getDingTalkBotById(nextBotId)?.clientId).toBe(nextClientId)
    expect(dingtalkConfig.getDingTalkBotById(oldBotId)).toBeUndefined()
    expect(existsSync(dingTalkBotBindingsPath(oldBotId))).toBe(false)
    expect(JSON.parse(readFileSync(dingTalkBotBindingsPath(nextBotId), 'utf-8'))).toEqual(bindings)
  })
})
