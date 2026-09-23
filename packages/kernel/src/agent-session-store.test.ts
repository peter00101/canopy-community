import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as safeFileModule from './safe-file'
import type { AgentWorkspace } from '@canopy/shared'
import type { AgentSessionThinkingSettings } from './agent-session-store'

type AgentSessionStore = typeof import('./agent-session-store')

let manager: AgentSessionStore
let dir: string

const workspaceRegistry = new Map<string, AgentWorkspace>()
let thinkingSettings: AgentSessionThinkingSettings = {}

// 包一层真实的 safe-file：只为数「索引文件被真正解析了几次」，验证读缓存命中，不改行为。
// 注意：mock.module 会就地更新已导入模块的绑定，所以必须在 mock 之前把真函数的**值**捕获住，
// 否则包装器会调到自己（无限递归，测试直接挂死——踩过）。
const realReadJsonFileSafe = safeFileModule.readJsonFileSafe
let indexParseCount = 0
mock.module('./safe-file', () => ({
  ...safeFileModule,
  readJsonFileSafe: <T,>(filePath: string): T | null => {
    if (filePath.endsWith('agent-sessions.json')) indexParseCount++
    return realReadJsonFileSafe<T>(filePath)
  },
}))

function registerWorkspace(ws: AgentWorkspace): void {
  workspaceRegistry.set(ws.id, ws)
}

function agentSessionsIndexPath(): string {
  return join(dir, 'agent-sessions.json')
}

function agentSessionMessagesPath(id: string): string {
  return join(dir, 'agent-sessions', `${id}.jsonl`)
}

function agentSessionSkillActivationsPath(id: string): string {
  return join(dir, 'agent-sessions', `${id}.skill-activations.json`)
}

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  mkdirSync(join(dir, 'agent-sessions'), { recursive: true })
  writeFileSync(agentSessionMessagesPath(sessionId), jsonl(rows), 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(agentSessionsIndexPath(), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function createIndexedSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    workspaceId: 'workspace-a',
    createdAt: index,
    updatedAt: index,
  }))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-agent-session-store-'))
  manager = await import('./agent-session-store')
  manager.configureAgentSessionStore({
    paths: {
      getAgentSessionsIndexPath: agentSessionsIndexPath,
      getAgentSessionsDir: () => {
        const d = join(dir, 'agent-sessions')
        mkdirSync(d, { recursive: true })
        return d
      },
      getAgentSessionMessagesPath: agentSessionMessagesPath,
      getAgentSessionSkillActivationsPath: agentSessionSkillActivationsPath,
      getAgentWorkspacePath: (slug) => {
        const d = join(dir, 'agent-workspaces', slug)
        mkdirSync(d, { recursive: true })
        return d
      },
      getAgentSessionWorkspacePath: (slug, sessionId) => {
        const d = join(dir, 'agent-workspaces', slug, sessionId)
        mkdirSync(d, { recursive: true })
        return d
      },
      getSdkConfigDir: () => join(dir, 'sdk-config'),
    },
    workspaces: {
      getAgentWorkspace: (id) => workspaceRegistry.get(id),
      getProjectFilesPath: (slug) => join(dir, 'agent-workspaces', slug, 'project-files'),
      listAgentWorkspaces: () => [...workspaceRegistry.values()],
    },
    getThinkingSettings: () => thinkingSettings,
  })
  registerWorkspace({ id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Agent 会话 JSONL 读取', () => {
  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given 会话 JSONL 存在损坏行 When 全量重写路径（删错误消息）读取 Then 抛错避免重写不完整历史', () => {
    // 这道 parseJsonlStrict 防线守着所有「读全文 → 改 → 全量重写」的路径：
    // removeSDKErrorMessage / updateSDKUserMessageSkillActivations / rewindPiAgentSession（后者在 runtime-pi）
    writeAgentSessionJsonl('session-rewrite-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', error: 'boom', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.removeSDKErrorMessage('session-rewrite-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
    // 抛错即放弃重写：原文件（含坏行）必须原封不动
    const raw = readFileSync(agentSessionMessagesPath('session-rewrite-bad-line'), 'utf-8')
    expect(raw).toContain('{ 这不是合法 JSON')
  })

  test('Given 会话正文被全量重写 When 检查磁盘 Then 旧正文留在 .jsonl.bak 可供人工找回', () => {
    writeAgentSessionJsonl('session-rewrite-bak', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '问' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-err', error: 'boom', message: { content: [] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-2', message: { content: [{ type: 'text', text: '答' }] } }),
    ])
    const filePath = agentSessionMessagesPath('session-rewrite-bak')
    const before = readFileSync(filePath, 'utf-8')

    expect(manager.removeSDKErrorMessage('session-rewrite-bak', 'assistant-err')).toBe(true)

    expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe(before)
    expect(manager.getAgentSessionSDKMessages('session-rewrite-bak').map((m) => (m as { uuid?: string }).uuid))
      .toEqual(['user-1', 'assistant-2'])
  })
})

describe('getSessionContextUsageRatio（原 agent-session-usage.ts，下沉进 kernel）', () => {
  test('Given 最后一条 result 消息带 usage 和 modelUsage Then 按 SDK 实测 contextWindow 计算占用率', () => {
    // modelUsage 里未知模型名会同时触发"取最大值"逻辑（真实 SDK 实测值 vs 按模型家族推断的 fallback），
    // 这里把两个 entry 的 contextWindow 设得比推断 fallback（DEFAULT_CONTEXT_WINDOW=200000）更大，
    // 确保断言的是 SDK 实测值本身生效，而不是被 fallback 覆盖。
    writeAgentSessionJsonl('usage-ratio-result', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '问' }] } }),
      JSON.stringify({
        type: 'result',
        usage: { input_tokens: 200, cache_read_input_tokens: 50 },
        modelUsage: { 'model-a': { contextWindow: 1_000_000 }, 'model-b': { contextWindow: 500_000 } },
      }),
    ])

    expect(manager.getSessionContextUsageRatio('usage-ratio-result')).toBe(250 / 1_000_000)
  })

  test('Given 只有 assistant 消息带 usage（无 result） Then 仍能反向找到并计算', () => {
    writeAgentSessionJsonl('usage-ratio-assistant', [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '答' }], usage: { input_tokens: 100 }, model: 'gpt-5' },
      }),
    ])

    const ratio = manager.getSessionContextUsageRatio('usage-ratio-assistant')
    // gpt-5 的 contextWindow 由 @canopy/shared 的模型注册表推断，这里只断言"能算出一个合理占用率"，
    // 不断言具体分母（避免与模型注册表数据耦合）。
    expect(ratio).toBeGreaterThan(0)
    expect(ratio).toBeLessThan(1)
  })

  test('Given 会话没有任何带 usage 的消息 Then 返回 undefined', () => {
    writeAgentSessionJsonl('usage-ratio-no-usage', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '问' }] } }),
    ])

    expect(manager.getSessionContextUsageRatio('usage-ratio-no-usage')).toBeUndefined()
  })

  test('Given 会话文件不存在 Then 返回 undefined 而不抛错', () => {
    expect(manager.getSessionContextUsageRatio('usage-ratio-missing-file')).toBeUndefined()
  })
})

describe('Agent 会话 runtime 元数据', () => {
  test('Given 已保存 OpenAI medium 默认值 When 新建会话 Then 始终创建并持久化 Pi 会话', () => {
    thinkingSettings = { agentThinking: { type: 'adaptive' }, agentEffort: 'max', defaultOpenAIThinkingLevel: 'medium' }

    try {
      const session = manager.createAgentSession('默认内核会话')

      expect(session.reasoningLevel).toBe('medium')
      expect(manager.getAgentSessionMeta(session.id)?.reasoningLevel).toBe('medium')
    } finally {
      thinkingSettings = {}
    }
  })

  test('Given Pi session moved to another workspace When metadata is persisted Then clears the cwd-bound artifact and bindings', () => {
    registerWorkspace({ id: 'workspace-b', name: '工作区 B', slug: 'workspace-b', createdAt: 1, updatedAt: 1 })
    writeAgentSessionsIndex([{
      id: 'pi-session-to-move',
      title: 'Pi 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: '/tmp/pi-session.jsonl',
      piEntryBindings: { 'assistant-1': 'entry-1' },
    }])
    mkdirSync(join(dir, 'agent-workspaces', 'workspace-a', 'pi-session-to-move'), { recursive: true })

    const moved = manager.moveSessionToWorkspace('pi-session-to-move', 'workspace-b')

    expect(moved.workspaceId).toBe('workspace-b')
    expect(moved.sdkSessionId).toBeUndefined()
    expect(moved.piSessionFile).toBeUndefined()
    expect(moved.piEntryBindings).toBeUndefined()
    expect(existsSync(join(dir, 'agent-workspaces', 'workspace-b', 'pi-session-to-move'))).toBe(true)
  })

  test('Given 新安装用户保存关闭思考 When 连续新建会话 Then 不被旧版迁移改回 high', () => {
    const indexPath = agentSessionsIndexPath()
    const indexBackupPath = `${indexPath}.bak`
    rmSync(indexPath, { force: true })
    rmSync(indexBackupPath, { force: true })
    thinkingSettings = { agentThinking: { type: 'adaptive' }, agentEffort: 'medium', defaultOpenAIThinkingLevel: 'off' }

    try {
      const firstSession = manager.createAgentSession('关闭思考会话一')
      const secondSession = manager.createAgentSession('关闭思考会话二')

      expect(manager.getAgentSessionMeta(firstSession.id)?.reasoningLevel).toBe('off')
      expect(manager.getAgentSessionMeta(secondSession.id)?.reasoningLevel).toBe('off')
    } finally {
      thinkingSettings = {}
      rmSync(indexPath, { force: true })
      rmSync(indexBackupPath, { force: true })
    }
  })

  test('Given session settings When updating Then persists reasoning depth per session', () => {
    const session = manager.createAgentSession('Codex 会话')

    const updated = manager.updateAgentSessionMeta(session.id, { reasoningLevel: 'xhigh' })

    expect(updated.reasoningLevel).toBe('xhigh')
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ reasoningLevel: 'xhigh' })
  })

  test('Given a session When star state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('星标会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { starred: true })

    expect(updated).toMatchObject({ starred: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ starred: true, archived: true })
  })
})

describe('Agent 会话正文搜索', () => {
  test('Given 用户/助手正文和内部块 When 搜索 Then 只返回最多两个不同正文消息命中', async () => {
    writeAgentSessionsIndex([{
      id: 'search-content-session',
      title: '正文搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('search-content-session', [
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-internal',
        message: {
          content: [
            { type: 'thinking', thinking: '命中词隐藏思考' },
            { type: 'tool_use', name: 'Read', input: { query: '命中词工具参数' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '用户正文命中词' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: '助手正文命中词' }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-user',
        message: { content: [{ type: 'tool_result', content: '命中词工具结果' }] },
      }),
    ])

    const results = await manager.searchAgentSessionMessages('命中词')

    expect(results).toHaveLength(2)
    expect(results.map((result) => result.messageId)).toEqual(['user-1', 'assistant-1'])
    expect(results.every((result) => result.role === 'user' || result.role === 'assistant')).toBe(true)
  })

  test('Given 单会话中有多个不同质量的命中 When 搜索 Then 只保留两条最佳结果并让 user 同分优先', async () => {
    writeAgentSessionsIndex([{
      id: 'ranked-search-session',
      title: '排序搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('ranked-search-session', [
      JSON.stringify({ type: 'assistant', uuid: 'fuzzy', message: { content: [{ type: 'text', text: '搜索优方案' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'fragment', message: { content: [{ type: 'text', text: '搜索优化内容' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
    ])

    const results = await manager.searchAgentSessionMessages('搜索优化方案')

    expect(results.map((result) => result.messageId)).toEqual(['user-exact', 'assistant-exact'])
    expect(results.map((result) => result.role)).toEqual(['user', 'assistant'])
  })

  test('Given 重复的 Agent SDK snapshot When 搜索 Then 每个 messageId 只返回最佳命中一次', async () => {
    writeAgentSessionsIndex([{
      id: 'deduplicated-search-session',
      title: '去重搜索测试',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
    }])
    writeAgentSessionJsonl('deduplicated-search-session', [
      JSON.stringify({ type: 'assistant', uuid: 'duplicate', message: { content: [{ type: 'text', text: '搜索优方案' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'duplicate', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-exact', message: { content: [{ type: 'text', text: '搜索优化方案' }] } }),
    ])

    const results = await manager.searchAgentSessionMessages('搜索优化方案')

    expect(results.map((result) => result.messageId)).toEqual(['user-exact', 'duplicate'])
    expect(results).toHaveLength(2)
  })

  test('Given 超过 100 个命中会话 When 搜索 Then 最多返回 100 个会话且每个最多两个命中', async () => {
    const sessions = createIndexedSessions(101)
    writeAgentSessionsIndex(sessions)
    for (const session of sessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', uuid: `${session.id}-1`, message: { content: [{ type: 'text', text: '命中词一' }] } }),
        JSON.stringify({ type: 'assistant', uuid: `${session.id}-2`, message: { content: [{ type: 'text', text: '命中词二' }] } }),
        JSON.stringify({ type: 'user', uuid: `${session.id}-3`, message: { content: [{ type: 'text', text: '命中词三' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionMessages('命中词')
    const sessionIds = new Set(results.map((result) => result.sessionId))

    expect(sessionIds).toHaveLength(100)
    expect(results).toHaveLength(200)
    expect([...sessionIds][0]).toBe('session-100')
    expect(results.filter((result) => result.sessionId === 'session-100')).toHaveLength(2)
  })
})

describe('Agent 会话引用搜索', () => {
  test('Given 工作区有超过 20 个会话 When 请求最近 200 条 Then 按更新时间返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 200,
    })

    expect(results).toHaveLength(200)
    expect(results[0]?.sessionId).toBe('session-219')
    expect(results.at(-1)?.sessionId).toBe('session-20')
    expect(results.every((result) => result.matchSource === 'recent')).toBe(true)
  })

  test('Given 请求数量超过性能上限 When 搜索可引用会话 Then 最多返回 200 条', async () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = await manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 500,
    })

    expect(results).toHaveLength(200)
  })

  test('Given 未指定工作区 When 搜索可引用会话 Then 返回全部工作区的最近会话并标示来源', async () => {
    registerWorkspace({ id: 'workspace-a', name: '产品研发', slug: 'product-dev', createdAt: 1, updatedAt: 1 })
    registerWorkspace({ id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 2, updatedAt: 2 })
    registerWorkspace({ id: 'workspace-c', name: '当前项目', slug: 'current-project', createdAt: 3, updatedAt: 3 })
    writeAgentSessionsIndex([
      { id: 'workspace-a-session', title: '同名会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'workspace-b-session', title: '同名会话', workspaceId: 'workspace-b', createdAt: 2, updatedAt: 2 },
      { id: 'current-session', title: '当前会话', workspaceId: 'workspace-c', createdAt: 3, updatedAt: 3 },
    ])

    const results = await manager.searchAgentSessionReferences({
      excludeSessionId: 'current-session',
      limit: 200,
    })

    expect(results).toMatchObject([
      { sessionId: 'workspace-b-session', workspaceName: '客户支持', workspaceSlug: 'customer-support' },
      { sessionId: 'workspace-a-session', workspaceName: '产品研发', workspaceSlug: 'product-dev' },
    ])

    // 恢复默认工作区命名，避免影响后续测试对 workspace-a 的假设
    registerWorkspace({ id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 })
  })

  test('Given 消息内容命中 When 搜索可引用会话 Then 异步返回匹配片段和工作区来源', async () => {
    registerWorkspace({ id: 'workspace-b', name: '客户支持', slug: 'customer-support', createdAt: 1, updatedAt: 1 })
    writeAgentSessionsIndex([
      { id: 'message-session', title: '项目讨论', workspaceId: 'workspace-b', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('message-session', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '需要核对跨工作区的会话引用。' }] } }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '跨工作区' })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      sessionId: 'message-session',
      workspaceName: '客户支持',
      workspaceSlug: 'customer-support',
      matchSource: 'message',
      snippet: expect.stringContaining('跨工作区'),
    })
  })

  test('Given 正文扫描预算耗尽 When 较旧会话标题命中 Then 仍返回标题命中结果', async () => {
    const scannedSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `body-scan-${index}`,
      title: `普通会话 ${index}`,
      workspaceId: 'workspace-a',
      createdAt: 100 - index,
      updatedAt: 100 - index,
    }))
    writeAgentSessionsIndex([
      ...scannedSessions,
      { id: 'older-title-match', title: '目标会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    for (const session of scannedSessions) {
      writeAgentSessionJsonl(session.id, [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '没有匹配内容' }] } }),
      ])
    }

    const results = await manager.searchAgentSessionReferences({ query: '目标' })

    expect(results).toMatchObject([{ sessionId: 'older-title-match', matchSource: 'title' }])
  })

  test('Given 正文命中在单文件扫描上限之后 When 搜索引用 Then 不读取超出输入补全预算的历史', async () => {
    writeAgentSessionsIndex([
      { id: 'oversized-session', title: '大历史', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionJsonl('oversized-session', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: `${'x'.repeat(300 * 1024)}隐藏关键词` }] },
      }),
    ])

    const results = await manager.searchAgentSessionReferences({ query: '隐藏关键词' })

    expect(results).toEqual([])
  })
})

describe('Agent 会话历史分页读取', () => {
  /** 从 SDKMessage 里取首个文本块，用于断言分页顺序 */
  function readMessageTexts(messages: unknown[]): string[] {
    return messages.map((message) => {
      const content = (message as { message?: { content?: Array<{ text?: string }> } }).message?.content
      return content?.[0]?.text ?? ''
    })
  }

  function userLine(text: string): string {
    return JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  }

  test('Given 历史十条 When 只取最后三条 Then 返回尾部三条并给出下一页字节上界', () => {
    writeAgentSessionJsonl(
      'session-page-tail',
      Array.from({ length: 10 }, (_, index) => userLine(`消息 ${index}`)),
    )

    const page = manager.getAgentSessionSDKMessagesPage('session-page-tail', { limit: 3 })

    expect(readMessageTexts(page.messages)).toEqual(['消息 7', '消息 8', '消息 9'])
    expect(page.nextBefore).toBeGreaterThan(0)
  })

  test('Given 首页给出上界 When 依次向前翻页 Then 拼回的历史无重复无遗漏', () => {
    writeAgentSessionJsonl(
      'session-page-walk',
      Array.from({ length: 10 }, (_, index) => userLine(`消息 ${index}`)),
    )

    const collected: string[] = []
    let before: number | undefined
    for (let round = 0; round < 10; round++) {
      const page = manager.getAgentSessionSDKMessagesPage('session-page-walk', { limit: 3, before })
      collected.unshift(...readMessageTexts(page.messages))
      if (page.nextBefore === undefined) break
      before = page.nextBefore
    }

    expect(collected).toEqual(Array.from({ length: 10 }, (_, index) => `消息 ${index}`))
  })

  test('Given 历史不足一页 When 分页读取 Then 全量返回且没有下一页', () => {
    writeAgentSessionJsonl('session-page-short', [userLine('唯一一条')])

    const page = manager.getAgentSessionSDKMessagesPage('session-page-short', { limit: 400 })

    expect(readMessageTexts(page.messages)).toEqual(['唯一一条'])
    expect(page.nextBefore).toBeUndefined()
  })

  test('Given 单条消息长于 64KB 读取块 When 分页读取 Then 跨块的行不被截断', () => {
    const longText = '长'.repeat(70_000)
    writeAgentSessionJsonl('session-page-long-line', [userLine('开头'), userLine(longText), userLine('结尾')])

    const page = manager.getAgentSessionSDKMessagesPage('session-page-long-line', { limit: 400 })

    expect(readMessageTexts(page.messages)).toEqual(['开头', longText, '结尾'])
    expect(page.nextBefore).toBeUndefined()
  })

  test('Given 历史混入损坏行 When 分页读取 Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-page-bad-line', [userLine('前一条'), '{ 这不是合法 JSON', userLine('后一条')])

    const page = manager.getAgentSessionSDKMessagesPage('session-page-bad-line', { limit: 400 })

    expect(readMessageTexts(page.messages)).toEqual(['前一条', '后一条'])
  })

  test('Given limit 传 0 When 分页读取 Then 夹取为至少一条', () => {
    writeAgentSessionJsonl('session-page-clamp', [userLine('第一条'), userLine('第二条')])

    const page = manager.getAgentSessionSDKMessagesPage('session-page-clamp', { limit: 0 })

    expect(readMessageTexts(page.messages)).toEqual(['第二条'])
    expect(page.nextBefore).toBeGreaterThan(0)
  })

  test('Given 会话文件不存在 When 分页读取 Then 返回空页而不抛错', () => {
    const page = manager.getAgentSessionSDKMessagesPage('session-page-missing')

    expect(page.messages).toEqual([])
    expect(page.nextBefore).toBeUndefined()
  })
})

describe('Agent 会话列表范围过滤', () => {
  function writeMixedIndex(): void {
    writeAgentSessionsIndex([
      { id: 'active-old', title: '活跃旧', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'archived-one', title: '归档一', workspaceId: 'workspace-a', createdAt: 2, updatedAt: 2, archived: true },
      { id: 'active-new', title: '活跃新', workspaceId: 'workspace-a', createdAt: 3, updatedAt: 3 },
    ])
  }

  test('Given 索引混有归档会话 When 按 active 取列表 Then 只返回未归档且按更新时间倒序', () => {
    writeMixedIndex()

    expect(manager.listAgentSessions('active').map((session) => session.id)).toEqual(['active-new', 'active-old'])
  })

  test('Given 索引混有归档会话 When 按 archived 与 all 取列表 Then 分别返回归档与全部', () => {
    writeMixedIndex()

    expect(manager.listAgentSessions('archived').map((session) => session.id)).toEqual(['archived-one'])
    expect(manager.listAgentSessions('all').map((session) => session.id)).toEqual(['active-new', 'archived-one', 'active-old'])
    expect(manager.listAgentSessions().map((session) => session.id)).toEqual(['active-new', 'archived-one', 'active-old'])
  })

  test('Given 索引混有归档会话 When 统计数量 Then 活跃与归档分别计数', () => {
    writeMixedIndex()

    expect(manager.getAgentSessionCounts()).toEqual({ active: 2, archived: 1 })
  })
})

describe('Agent 会话索引读缓存（审查 P-1 / P-3）', () => {
  test('Given 索引已被加载 When 同一份文件反复 getAgentSessionMeta / listAgentSessions Then 只解析一次文件', () => {
    writeAgentSessionsIndex([
      { id: 'cache-a', title: 'A', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 },
      { id: 'cache-b', title: 'B', workspaceId: 'workspace-a', createdAt: 2, updatedAt: 2 },
    ])
    manager.getAgentSessionMeta('cache-a') // 首次：外部刚写过文件 → 必然重新解析（可能触发迁移落盘）
    const baseline = indexParseCount

    manager.getAgentSessionMeta('cache-a')
    manager.getAgentSessionMeta('cache-b')
    manager.listAgentSessions('active')
    manager.getAgentSessionCounts()
    manager.getAgentSessionMeta('cache-a')

    expect(indexParseCount).toBe(baseline)
    expect(manager.__getAgentSessionIndexCacheStateForTest().loaded).toBe(true)
  })

  test('Given 通过 API 更新元数据 When 再读 Then 走缓存（写透 + 刷新签名）而不重新解析文件', () => {
    writeAgentSessionsIndex([{ id: 'cache-c', title: '旧标题', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    manager.getAgentSessionMeta('cache-c')
    const baseline = indexParseCount

    manager.updateAgentSessionMeta('cache-c', { title: '新标题' })
    expect(manager.getAgentSessionMeta('cache-c')?.title).toBe('新标题')
    // 磁盘上也已经是新内容（同步写透）
    const onDisk = JSON.parse(readFileSync(agentSessionsIndexPath(), 'utf-8')) as { sessions: { title: string }[] }
    expect(onDisk.sessions[0]!.title).toBe('新标题')
    expect(indexParseCount).toBe(baseline)
  })

  test('Given 外部直接改写了索引文件 When 再读 Then 签名失效、拿到新内容', () => {
    writeAgentSessionsIndex([{ id: 'cache-d', title: '版本一', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    expect(manager.getAgentSessionMeta('cache-d')?.title).toBe('版本一')
    const baseline = indexParseCount

    // 模拟人工编辑 / 另一进程写入：不经过 manager
    writeAgentSessionsIndex([{ id: 'cache-d', title: '版本二（外部改写）', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])

    expect(manager.getAgentSessionMeta('cache-d')?.title).toBe('版本二（外部改写）')
    expect(indexParseCount).toBeGreaterThan(baseline)
  })

  test('Given 调用方篡改了 getAgentSessionMeta / listAgentSessions 返回的对象 When 再读 Then 缓存与磁盘都不受影响（返回的是副本）', () => {
    writeAgentSessionsIndex([{ id: 'cache-e', title: '原标题', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1, agentRuntime: 'pi', piEntryBindings: { 'u-1': 'e-1' } }])
    const meta = manager.getAgentSessionMeta('cache-e')!
    meta.title = '被篡改'
    delete meta.piEntryBindings
    const list = manager.listAgentSessions('all')
    list[0]!.title = '列表里也被篡改'

    const fresh = manager.getAgentSessionMeta('cache-e')!
    expect(fresh.title).toBe('原标题')
    expect(fresh.piEntryBindings).toEqual({ 'u-1': 'e-1' })
    // 触发一次写透后磁盘上仍是原值（篡改没有被顺带持久化）
    manager.updateAgentSessionMeta('cache-e', { starred: true })
    const onDisk = JSON.parse(readFileSync(agentSessionsIndexPath(), 'utf-8')) as { sessions: { title: string; piEntryBindings?: Record<string, string> }[] }
    expect(onDisk.sessions[0]!.title).toBe('原标题')
    expect(onDisk.sessions[0]!.piEntryBindings).toEqual({ 'u-1': 'e-1' })
  })

  test('Given 索引文件被外部删除 When 再读 Then 得到空索引而不是崩溃或吐旧缓存', () => {
    writeAgentSessionsIndex([{ id: 'cache-f', title: 'F', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    expect(manager.getAgentSessionMeta('cache-f')).toBeDefined()

    rmSync(agentSessionsIndexPath(), { force: true })
    rmSync(`${agentSessionsIndexPath()}.bak`, { force: true })

    expect(manager.getAgentSessionMeta('cache-f')).toBeUndefined()
    expect(manager.listAgentSessions('all')).toEqual([])
  })
})

describe('Skill 激活元信息 sidecar（审查 N-1）', () => {
  const skill = (slug: string) => ({ slug, name: slug, sources: ['read' as const] })
  const sidecarPath = agentSessionSkillActivationsPath
  const jsonlPath = agentSessionMessagesPath

  test('Given 会话正文已落盘 When 记录 Skill 激活 Then 只写 sidecar，JSONL 一个字节都不动、也不产生 .bak', () => {
    writeAgentSessionJsonl('skill-sidecar-a', [
      JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '用 pdf skill' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: '好' }] } }),
    ])
    const before = readFileSync(jsonlPath('skill-sidecar-a'), 'utf-8')
    const mtimeBefore = statSync(jsonlPath('skill-sidecar-a')).mtimeMs

    expect(manager.updateSDKUserMessageSkillActivations('skill-sidecar-a', 'u-1', [skill('pdf')])).toBe(true)

    expect(readFileSync(jsonlPath('skill-sidecar-a'), 'utf-8')).toBe(before)
    expect(statSync(jsonlPath('skill-sidecar-a')).mtimeMs).toBe(mtimeBefore)
    expect(existsSync(jsonlPath('skill-sidecar-a') + '.bak')).toBe(false)
    expect(existsSync(sidecarPath('skill-sidecar-a'))).toBe(true)
  })

  test('Given sidecar 已写 When 全量读取 / 分页读取 Then 对应 user 消息都带回 skill_activations', () => {
    writeAgentSessionJsonl('skill-sidecar-b', [
      JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '一' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a-1', message: { content: [] } }),
      JSON.stringify({ type: 'user', uuid: 'u-2', message: { role: 'user', content: '二' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a-2', message: { content: [] } }),
    ])
    manager.updateSDKUserMessageSkillActivations('skill-sidecar-b', 'u-2', [skill('xlsx')])

    const full = manager.getAgentSessionSDKMessages('skill-sidecar-b') as Array<{ uuid?: string; skill_activations?: { slug: string }[] }>
    expect(full.find((m) => m.uuid === 'u-2')?.skill_activations?.map((a) => a.slug)).toEqual(['xlsx'])
    expect(full.find((m) => m.uuid === 'u-1')?.skill_activations).toBeUndefined()

    const page = manager.getAgentSessionSDKMessagesPage('skill-sidecar-b', { limit: 2 }).messages as Array<{ uuid?: string; skill_activations?: { slug: string }[] }>
    expect(page.map((m) => m.uuid)).toEqual(['u-2', 'a-2'])
    expect(page[0]!.skill_activations?.map((a) => a.slug)).toEqual(['xlsx'])
  })

  test('Given 旧版会话在 JSONL 里内联了 skill_activations When 读取 Then 内联与 sidecar 合并去重（向后兼容）', () => {
    writeAgentSessionJsonl('skill-sidecar-c', [
      JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '旧' }, skill_activations: [skill('pdf')] }),
    ])
    manager.updateSDKUserMessageSkillActivations('skill-sidecar-c', 'u-1', [skill('pdf'), skill('docx')])
    const [msg] = manager.getAgentSessionSDKMessages('skill-sidecar-c') as Array<{ skill_activations?: { slug: string }[] }>
    expect(msg!.skill_activations!.map((a) => a.slug).sort()).toEqual(['docx', 'pdf'])
  })

  test('Given user 消息尚未落盘（Pi 队列） When 先记录激活 Then 不再返回 false 等待补写；消息落盘后读取即合并', () => {
    // 夹具补全（0.19.4 收上游 #2074 时）：本例会调 appendSDKMessages，而该函数新增了
    // 「会话元数据不存在就不写」的守卫（避免已删除会话被迟到输出重建 transcript）。
    // 原夹具只写 JSONL 不写索引，是本例偷懒——生产路径上 append 的会话必然先经
    // createAgentSession 落过索引，故补写索引而不是放宽守卫。
    writeAgentSessionsIndex([{ id: 'skill-sidecar-d', title: 'sidecar-d', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl('skill-sidecar-d', [
      JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '首条' } }),
    ])
    expect(manager.updateSDKUserMessageSkillActivations('skill-sidecar-d', 'u-queued', [skill('pdf')])).toBe(true)
    manager.appendSDKMessages('skill-sidecar-d', [
      { type: 'user', uuid: 'u-queued', message: { role: 'user', content: '排队的' } } as never,
    ])
    const msgs = manager.getAgentSessionSDKMessages('skill-sidecar-d') as Array<{ uuid?: string; skill_activations?: { slug: string }[] }>
    expect(msgs.find((m) => m.uuid === 'u-queued')?.skill_activations?.map((a) => a.slug)).toEqual(['pdf'])
  })

  test('Given 会话有 sidecar When 删除会话 Then sidecar 与其 .bak 一并清除', () => {
    writeAgentSessionsIndex([{ id: 'skill-sidecar-e', title: '待删', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl('skill-sidecar-e', [JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'x' } })])
    manager.updateSDKUserMessageSkillActivations('skill-sidecar-e', 'u-1', [skill('pdf')])
    manager.updateSDKUserMessageSkillActivations('skill-sidecar-e', 'u-1', [skill('xlsx')])
    expect(existsSync(sidecarPath('skill-sidecar-e') + '.bak')).toBe(true)

    manager.deleteAgentSessionCore('skill-sidecar-e')

    expect(existsSync(sidecarPath('skill-sidecar-e'))).toBe(false)
    expect(existsSync(sidecarPath('skill-sidecar-e') + '.bak')).toBe(false)
  })
})

describe('会话删除', () => {
  test('Given 会话曾被重写而留有 .bak When 删除会话 Then .jsonl / .bak / .tmp 一并清除不留备份', () => {
    writeAgentSessionsIndex([{
      id: 'session-delete-companions', title: '待删', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
    }])
    writeAgentSessionJsonl('session-delete-companions', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '问' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-err', error: 'boom', message: { content: [] } }),
    ])
    const messagesPath = agentSessionMessagesPath('session-delete-companions')
    manager.removeSDKErrorMessage('session-delete-companions', 'assistant-err') // 产生 .bak
    writeFileSync(`${messagesPath}.tmp`, '半截', 'utf-8')
    expect(existsSync(`${messagesPath}.bak`)).toBe(true)

    manager.deleteAgentSessionCore('session-delete-companions')

    expect(existsSync(messagesPath)).toBe(false)
    expect(existsSync(`${messagesPath}.bak`)).toBe(false)
    expect(existsSync(`${messagesPath}.tmp`)).toBe(false)
  })
})

describe('会话标题消毒（防止非字符串标题炸掉侧栏 React 树）', () => {
  test('Given 各种非法标题 When 归一化 Then 得到兜底或 text 字段', () => {
    expect(manager.normalizeSessionTitle(undefined)).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle('')).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle('   ')).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle({ foo: 'bar' })).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle(['a'])).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle(42)).toBe('新 Agent 会话')
    expect(manager.normalizeSessionTitle({ text: '  内容块标题 ' })).toBe('内容块标题')
  })

  test('Given 多行 / 超长标题 When 归一化 Then 压成单行并截断到 100 字', () => {
    expect(manager.normalizeSessionTitle('第一行\n\n  第二行\t结尾  ')).toBe('第一行 第二行 结尾')
    expect(manager.normalizeSessionTitle('x'.repeat(300))).toHaveLength(100)
  })

  test('Given 创建会话时传入对象标题 When 创建 Then 落盘的是兜底字符串', () => {
    const meta = manager.createAgentSession({ bad: true } as unknown as string)
    expect(meta.title).toBe('新 Agent 会话')
    expect(typeof manager.getAgentSessionMeta(meta.id)?.title).toBe('string')
  })

  test('Given 更新标题传入非法值 When 更新 Then 保留原标题而不是写入 undefined', () => {
    const meta = manager.createAgentSession('原标题')
    const updated = manager.updateAgentSessionMeta(meta.id, { title: undefined as unknown as string })
    expect(updated.title).toBe('原标题')
    expect(manager.updateAgentSessionMeta(meta.id, { title: '  新标题\n第二行 ' }).title).toBe('新标题 第二行')
  })
})

describe('Agent 会话删除墓碑（收上游 #2074）', () => {
  test('Given 已删除会话的晚到 SDK 输出 When 追加 Then 不重新创建 transcript', () => {
    const id = 'deleted-session-late-sdk-output'
    writeAgentSessionsIndex([{ id, title: '待删除会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl(id, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '原始消息' }] } })])

    manager.markAgentSessionDeleting(id)
    manager.deleteAgentSessionCore(id)
    manager.appendSDKMessages(id, [{ type: 'result', subtype: 'success' } as never])

    expect(manager.getAgentSessionMeta(id)).toBeUndefined()
    expect(existsSync(agentSessionMessagesPath(id))).toBe(false)
  })

  test('Given 已删除会话的晚到普通消息 When 追加 Then 同样不重建文件', () => {
    const id = 'deleted-session-late-plain-output'
    writeAgentSessionsIndex([{ id, title: '待删除会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl(id, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '原始消息' }] } })])

    manager.markAgentSessionDeleting(id)
    manager.deleteAgentSessionCore(id)
    manager.appendAgentMessage(id, { type: 'assistant', message: { content: [{ type: 'text', text: '晚到' }] } } as never)

    expect(existsSync(agentSessionMessagesPath(id))).toBe(false)
  })

  test('Given 会话已被删除但没打过墓碑 When 晚到输出追加 Then 靠元数据缺失同样挡住', () => {
    const id = 'deleted-session-without-tombstone'
    writeAgentSessionsIndex([{ id, title: '待删除会话', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1 }])
    writeAgentSessionJsonl(id, [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '原始消息' }] } })])

    manager.deleteAgentSessionCore(id)
    expect(manager.isAgentSessionDeleting(id)).toBe(false)
    manager.appendSDKMessages(id, [{ type: 'result', subtype: 'success' } as never])

    expect(existsSync(agentSessionMessagesPath(id))).toBe(false)
  })

  test('Given 正常存活的会话 When 追加输出 Then 照常写入，墓碑不误伤', () => {
    const meta = manager.createAgentSession('存活会话')
    expect(manager.isAgentSessionDeleting(meta.id)).toBe(false)

    manager.appendSDKMessages(meta.id, [{ type: 'result', subtype: 'success' } as never])

    expect(existsSync(agentSessionMessagesPath(meta.id))).toBe(true)
    expect(readFileSync(agentSessionMessagesPath(meta.id), 'utf-8')).toContain('"subtype":"success"')
  })

  test('Given 墓碑已写入但文件尚未删除 When 晚到输出追加 Then 不再追加新行', () => {
    const meta = manager.createAgentSession('删除中的会话')
    manager.appendSDKMessages(meta.id, [{ type: 'result', subtype: 'success' } as never])
    const before = readFileSync(agentSessionMessagesPath(meta.id), 'utf-8')

    manager.markAgentSessionDeleting(meta.id)
    manager.appendSDKMessages(meta.id, [{ type: 'result', subtype: 'error' } as never])

    expect(readFileSync(agentSessionMessagesPath(meta.id), 'utf-8')).toBe(before)
  })
})
