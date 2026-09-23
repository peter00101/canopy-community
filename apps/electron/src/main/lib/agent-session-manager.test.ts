import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

/**
 * agent-session-manager.ts 现在是薄封装：索引/分页/CRUD 已下沉到 @canopy/kernel 的
 * agent-session-store.ts（覆盖测试见 packages/kernel/src/agent-session-store.test.ts），
 * fork/rewind 已下沉到 @canopy/runtime-pi 的 agent-session-fork.ts（覆盖测试见
 * packages/runtime-pi/src/agent-session-fork.test.ts）。
 *
 * 本文件只覆盖薄封装本身新增的两处业务组合：
 * - deleteAgentSession：deleteAgentSessionCore + Nano Banana 生图历史清理
 * - migrateChatToAgentSession：Chat 对话 → Agent 会话迁移
 * 以及仍然留在 electron 侧、依赖 agent-session-manager 的 agent-session-context-prompt.ts。
 */

type AgentSessionManager = typeof import('./agent-session-manager')
type AgentSessionContextPrompt = typeof import('./agent-session-context-prompt')
type ConversationManager = typeof import('./conversation-manager')
type NanoBananaMcp = typeof import('./chat-tools/nano-banana-mcp')

let manager: AgentSessionManager
let contextPrompt: AgentSessionContextPrompt
let conversationManager: ConversationManager
let nanoBanana: NanoBananaMcp
let tempHome: string
const originalHome = process.env.HOME
const originalAppDev = process.env.CANOPY_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, CANOPY_BRAND.configDirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 2, workspaces }), 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.CANOPY_DEV = '0'
  manager = await import('./agent-session-manager')
  contextPrompt = await import('./agent-session-context-prompt')
  conversationManager = await import('./conversation-manager')
  nanoBanana = await import('./chat-tools/nano-banana-mcp')
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

describe('deleteAgentSession（薄封装：核心 CRUD + Nano Banana 生图历史清理）', () => {
  test('Given 会话有生图历史 When 删除会话 Then 消息文件与生图历史都被清理', () => {
    const session = manager.createAgentSession('待删会话')
    const messagesPath = join(tempHome, CANOPY_BRAND.configDirName, 'agent-sessions', `${session.id}.jsonl`)
    mkdirSync(join(tempHome, CANOPY_BRAND.configDirName, 'agent-sessions'), { recursive: true })
    writeFileSync(messagesPath, '', 'utf-8')

    // clearNanoBananaAgentHistory 内部只是 Map.delete，这里验证幂等且不抛错，
    // 真正的「已清理」断言交给 nano-banana-mcp 自己的测试套件。
    expect(() => nanoBanana.clearNanoBananaAgentHistory(session.id)).not.toThrow()

    manager.deleteAgentSession(session.id)

    expect(existsSync(messagesPath)).toBe(false)
    expect(manager.getAgentSessionMeta(session.id)).toBeUndefined()
  })
})

describe('migrateChatToAgentSession（Chat 对话 → Agent 会话迁移）', () => {
  test('Given Chat 对话有 user/assistant 消息 When 迁移 Then 追加为 AgentMessage 且跳过空内容与其它角色', () => {
    const conversation = conversationManager.createConversation('待迁移对话')
    conversationManager.appendMessage(conversation.id, { id: 'm1', role: 'user', content: '你好', createdAt: 1 })
    conversationManager.appendMessage(conversation.id, { id: 'm2', role: 'assistant', content: '你好，有什么可以帮你', createdAt: 2, model: 'gpt' })
    conversationManager.appendMessage(conversation.id, { id: 'm3', role: 'user', content: '   ', createdAt: 3 })

    const session = manager.createAgentSession('迁移目标会话')
    manager.migrateChatToAgentSession(conversation.id, session.id)

    const messages = manager.getAgentSessionMessages(session.id)
    expect(messages.map((m) => m.content)).toEqual(['你好', '你好，有什么可以帮你'])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  test('Given Chat 对话无消息 When 迁移 Then 不追加任何消息且不抛错', () => {
    const conversation = conversationManager.createConversation('空对话')
    const session = manager.createAgentSession('空迁移目标')

    expect(() => manager.migrateChatToAgentSession(conversation.id, session.id)).not.toThrow()
    expect(manager.getAgentSessionMessages(session.id)).toEqual([])
  })
})

describe('Agent 会话引用 prompt', () => {
  test('Given 用户显式引用跨工作区会话 When 构建发送 prompt Then 保留该会话上下文', () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b', name: '工作区 B', slug: 'workspace-b', createdAt: 2, updatedAt: 2 },
    ])
    const current = manager.createAgentSession('当前工作区会话', undefined, 'workspace-a')
    const other = manager.createAgentSession('其他工作区会话', undefined, 'workspace-b')

    const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string }
    const originalResourcesPath = processWithResourcesPath.resourcesPath
    processWithResourcesPath.resourcesPath = tempHome
    try {
      const prompt = contextPrompt.buildReferencedSessionsPrompt(
        current.id,
        [other.id],
      )

      expect(prompt).toContain(`id="${other.id}"`)
      expect(prompt).toContain('title="其他工作区会话"')
      expect(prompt).not.toContain('同工作区')
    } finally {
      Object.defineProperty(processWithResourcesPath, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true,
        writable: true,
      })
    }
  })
})
