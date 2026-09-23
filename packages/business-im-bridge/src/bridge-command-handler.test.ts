import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendInput, AgentWorkspace } from '@canopy/shared'
import { configureAgentSessionStore, DEFAULT_AGENT_SESSION_TITLE, getAgentSessionMeta } from '@canopy/kernel'
import { configureImBridgeBusiness } from './im-bridge-business-deps'
import { BridgeCommandHandler } from './bridge-command-handler'

/**
 * 真内核会话存储 + 真 BridgeCommandHandler，依赖全部走注入（不 mock 任何模块）。
 * 自动命名的触发条件是「标题仍为内核默认标题」，所以这里钉的是：桥接侧新建会话
 * 不得再自带「钉钉会话 / 新会话」这类标题，否则会被当成用户已命名、永不自动命名。
 */

let dir: string
const workspace: AgentWorkspace = { id: 'ws-1', name: '默认项目', slug: 'default', createdAt: 1, updatedAt: 1 }
const sentTexts: string[] = []
const headlessRuns: AgentSendInput[] = []
const mainWindowEvents: Array<{ channel: string; payload: unknown }> = []

function createHandler(platformName = '钉钉-客服'): BridgeCommandHandler {
  return new BridgeCommandHandler({
    platformName,
    adapter: { sendText: async (_chatId, text) => { sentTexts.push(text) } },
  })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-bridge-command-handler-'))
  const ensureDir = (path: string): string => {
    mkdirSync(path, { recursive: true })
    return path
  }

  configureAgentSessionStore({
    paths: {
      getAgentSessionsIndexPath: () => join(dir, 'agent-sessions.json'),
      getAgentSessionsDir: () => ensureDir(join(dir, 'agent-sessions')),
      getAgentSessionMessagesPath: (id) => join(dir, 'agent-sessions', `${id}.jsonl`),
      getAgentSessionSkillActivationsPath: (id) => join(dir, 'agent-sessions', `${id}.skill-activations.json`),
      getAgentWorkspacePath: (slug) => ensureDir(join(dir, 'agent-workspaces', slug)),
      getAgentSessionWorkspacePath: (slug, sessionId) => ensureDir(join(dir, 'agent-workspaces', slug, sessionId)),
      getSdkConfigDir: () => join(dir, 'sdk-config'),
    },
    workspaces: {
      getAgentWorkspace: (id) => (id === workspace.id ? workspace : undefined),
      getProjectFilesPath: (slug) => join(dir, 'agent-workspaces', slug, 'project-files'),
      listAgentWorkspaces: () => [workspace],
    },
    getThinkingSettings: () => ({}),
  })

  configureImBridgeBusiness({
    paths: {
      getFeishuConfigPath: () => join(dir, 'feishu.json'),
      getFeishuBotBindingsPath: (botId) => join(dir, `feishu-bindings-${botId}.json`),
      getFeishuBotMetadataPath: (botId) => join(dir, `feishu-metadata-${botId}.json`),
      getDingTalkConfigPath: () => join(dir, 'dingtalk.json'),
      getDingTalkBotBindingsPath: (botId) => join(dir, `dingtalk-bindings-${botId}.json`),
      getWeChatConfigPath: () => join(dir, 'wechat.json'),
      getWeChatBindingsPath: () => join(dir, 'wechat-bindings.json'),
      getWeChatSyncPath: () => join(dir, 'wechat-sync.json'),
      getAgentSessionWorkspacePath: (slug, sessionId) => join(dir, 'agent-workspaces', slug, sessionId),
      resolveAgentSessionWorkspacePath: (slug, sessionId) => join(dir, 'agent-workspaces', slug, sessionId),
    },
    getSettings: () => ({ agentChannelId: 'channel-1', agentWorkspaceId: workspace.id }),
    workspaces: {
      getAgentWorkspace: (id) => (id === workspace.id ? workspace : undefined),
      getProjectFilesPath: (slug) => join(dir, 'agent-workspaces', slug, 'project-files'),
      getWorkspaceCapabilities: () => ({ mcpServers: [], builtinMcpServers: [], skills: [], memory: { autoMemory: {} } }) as never,
      listAgentWorkspacesByUpdatedAt: () => [workspace],
    },
    channels: {
      listChannels: () => [],
      getChannelById: () => undefined,
    },
    agentRunner: {
      runAgentHeadless: async (input) => { headlessRuns.push(input) },
      stopAgent: () => false,
      isAgentSessionActive: () => false,
      onAgentEvent: () => () => {},
    },
    window: {
      sendToMainWindow: (channel, payload) => { mainWindowEvents.push({ channel, payload }) },
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

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  sentTexts.length = 0
  headlessRuns.length = 0
  mainWindowEvents.length = 0
})

describe('IM 桥接新建会话的标题（上游 #2066：桥接会话永不自动命名）', () => {
  test('Given 聊天还没有绑定会话 When 首条消息触发自动建会话 Then 会话保持内核默认标题，留给首条消息自动命名', () => {
    const handler = createHandler('钉钉-客服')

    const binding = handler.ensureBinding('chat-first-message')

    expect(binding).not.toBeNull()
    const meta = getAgentSessionMeta(binding!.sessionId)
    expect(meta?.title).toBe(DEFAULT_AGENT_SESSION_TITLE)
    // 平台来源记在 binding 里，不进标题
    expect(meta?.title).not.toContain('钉钉')
    expect(binding!.channelId).toBe('channel-1')
    expect(binding!.workspaceId).toBe(workspace.id)
  })

  test('Given 自动建会话 When 通知渲染层刷新列表 Then 带的是默认标题而不是平台名', () => {
    const handler = createHandler('微信')

    const binding = handler.ensureBinding('chat-notify')

    expect(mainWindowEvents).toHaveLength(1)
    expect(mainWindowEvents[0]!.payload).toEqual({ sessionId: binding!.sessionId, title: DEFAULT_AGENT_SESSION_TITLE })
  })

  test('Given 用户在 IM 里发 /new 不带标题 When 创建会话 Then 同样保持默认标题（不再写死「新会话」）', async () => {
    const handler = createHandler('微信')

    await handler.handleIncomingMessage('chat-new-plain', '/new')

    const binding = handler.getBinding('chat-new-plain')
    expect(binding).toBeDefined()
    expect(getAgentSessionMeta(binding!.sessionId)?.title).toBe(DEFAULT_AGENT_SESSION_TITLE)
    expect(sentTexts.at(-1)).toContain('已创建 Agent 会话')
  })

  test('Given 用户发 /new 并给了标题 When 创建会话 Then 用用户给的标题，视为已命名', async () => {
    const handler = createHandler('微信')

    await handler.handleIncomingMessage('chat-new-titled', '/new 季度汇报')

    const binding = handler.getBinding('chat-new-titled')
    expect(getAgentSessionMeta(binding!.sessionId)?.title).toBe('季度汇报')
  })

  test('Given /n 简写且标题只有空白 When 创建会话 Then 按未给标题处理', async () => {
    const handler = createHandler('微信')

    await handler.handleIncomingMessage('chat-new-blank', '/n    ')

    const binding = handler.getBinding('chat-new-blank')
    expect(getAgentSessionMeta(binding!.sessionId)?.title).toBe(DEFAULT_AGENT_SESSION_TITLE)
  })

  test('Given 聊天已有绑定 When 再次 ensureBinding Then 复用原会话，不新建也不改标题', () => {
    const handler = createHandler('钉钉-客服')
    const first = handler.ensureBinding('chat-reuse')

    const second = handler.ensureBinding('chat-reuse')

    expect(second!.sessionId).toBe(first!.sessionId)
    const index = JSON.parse(readFileSync(join(dir, 'agent-sessions.json'), 'utf-8')) as { sessions: Array<{ id: string }> }
    expect(index.sessions.filter((session) => session.id === first!.sessionId)).toHaveLength(1)
  })
})

describe('IM 桥接把用户消息交给无头 Agent', () => {
  test('Given 首条普通消息 When 交给 Agent Then 会话仍是默认标题（自动命名由编排器负责）且原文原样送达', async () => {
    const handler = createHandler('钉钉-客服')

    await handler.handleIncomingMessage('chat-run', '帮我总结一下上周的销售数据')

    expect(headlessRuns).toHaveLength(1)
    const run = headlessRuns[0]!
    expect(run.userMessage).toBe('帮我总结一下上周的销售数据')
    expect(run.channelId).toBe('channel-1')
    expect(run.workspaceId).toBe(workspace.id)
    expect(getAgentSessionMeta(run.sessionId)?.title).toBe(DEFAULT_AGENT_SESSION_TITLE)
    // 即时确认里带的会话名也不再是平台名
    expect(sentTexts.some((text) => text.includes('钉钉-客服会话'))).toBe(false)
  })
})
