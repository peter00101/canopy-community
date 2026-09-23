import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureAgentSessionStore,
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  updateAgentSessionMeta,
  updateSDKUserMessageSkillActivations,
} from '@canopy/kernel'
import type { AgentWorkspace } from '@canopy/shared'

type AgentSessionFork = typeof import('./agent-session-fork')

let fork: AgentSessionFork
let dir: string
let tempHome: string

const workspaceRegistry = new Map<string, AgentWorkspace>()

// agent-session-fork 延迟加载 Pi，这里用聚焦的假实现隔离 entry-tree 语义，
// 不需要真实的 Pi session JSONL fixture。
mock.module('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    open: (sessionFile: string) => ({
      createBranchedSession: (entryId: string) => {
        const branchFile = join(tempHome, `.pi-branch-${entryId}.jsonl`)
        writeFileSync(branchFile, '', 'utf-8')
        return branchFile
      },
      getSessionFile: () => sessionFile,
      getSessionId: () => 'pi-test-session',
      getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
    }),
    forkFrom: (_branchFile: string) => {
      const forkFile = join(tempHome, '.pi-fork.jsonl')
      writeFileSync(forkFile, '', 'utf-8')
      return {
        getSessionFile: () => forkFile,
        getSessionId: () => 'pi-fork-session',
        getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
      }
    },
  },
}))

function registerWorkspace(ws: AgentWorkspace): void {
  workspaceRegistry.set(ws.id, ws)
}

function agentSessionMessagesPath(id: string): string {
  return join(dir, 'agent-sessions', `${id}.jsonl`)
}

function agentSessionSkillActivationsPath(id: string): string {
  return join(dir, 'agent-sessions', `${id}.skill-activations.json`)
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  mkdirSync(join(dir, 'agent-sessions'), { recursive: true })
  writeFileSync(agentSessionMessagesPath(sessionId), rows.join('\n') + '\n', 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-agent-session-fork-'))
  tempHome = dir
  fork = await import('./agent-session-fork')

  configureAgentSessionStore({
    paths: {
      getAgentSessionsIndexPath: () => join(dir, 'agent-sessions.json'),
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
    getThinkingSettings: () => ({}),
  })

  fork.configureAgentSessionFork({
    paths: {
      getAgentSessionMessagesPath: agentSessionMessagesPath,
      getAgentSessionSkillActivationsPath: agentSessionSkillActivationsPath,
      getSdkConfigDir: () => join(dir, 'sdk-config'),
    },
    workspaces: {
      getAgentWorkspace: (id) => workspaceRegistry.get(id),
    },
    assertEnabledModelForChannel: () => undefined,
  })

  registerWorkspace({ id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('历史 Claude 会话不可续接', () => {
  test('Given 历史 Claude 会话 When 尝试分叉或回退 Then 拒绝续接（不触碰 Pi SDK）', async () => {
    writeAgentSessionsIndex([{
      id: 'legacy-claude-session',
      title: '历史 Claude 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'claude',
      sdkSessionId: 'claude-artifact',
      piSessionFile: '/tmp/not-a-pi-session.jsonl',
      piEntryBindings: { 'assistant-1': 'entry-1' },
    }])

    const migrated = getAgentSessionMeta('legacy-claude-session')
    expect(migrated).toMatchObject({
      legacyTranscript: { sourceRuntime: 'claude', continuationRequired: true },
    })

    await expect(fork.forkAgentSession({ sessionId: 'legacy-claude-session', upToMessageUuid: 'assistant-1' }))
      .rejects.toThrow('历史 Claude transcript 为只读')
    await expect(fork.rewindPiAgentSession('legacy-claude-session', 'assistant-1'))
      .rejects.toThrow('历史 Claude transcript 为只读')
  })
})

describe('Pi entry binding recovery', () => {
  test('Given Pi branch excludes later entries When fork Then keeps only bindings in the fork artifact', async () => {
    const piSessionFile = join(tempHome, '.pi-source-fork.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'pi-fork-source', title: 'Pi source', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: {
        'assistant-keep': 'entry-keep',
        'assistant-stale': 'entry-stale',
        'assistant-missing': 'missing-entry',
      },
    }])
    writeAgentSessionJsonl('pi-fork-source', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '开始' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '保留' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-stale', message: { content: [{ type: 'text', text: '丢弃' }] } }),
    ])

    const forked = await fork.forkAgentSession({ sessionId: 'pi-fork-source', upToMessageUuid: 'assistant-keep' })

    expect(forked.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(getAgentSessionMeta(forked.id)?.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(forked.piSessionFile && existsSync(forked.piSessionFile)).toBe(true)
  })

  test('Given rewind excludes transcript and artifact entries When rewinding Then keeps only valid retained assistant bindings', async () => {
    const piSessionFile = join(tempHome, '.pi-source-rewind.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'pi-rewind-source', title: 'Pi rewind', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: {
        'assistant-keep': 'entry-keep',
        'assistant-stale': 'entry-stale',
        'assistant-alias': 'entry-keep',
        'assistant-broken': 'missing-entry',
      },
    }])
    writeAgentSessionJsonl('pi-rewind-source', [
      JSON.stringify({ type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: '开始' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '保留' }] } }),
      JSON.stringify({ type: 'user', uuid: 'user-after', message: { content: [{ type: 'text', text: '后续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-stale', message: { content: [{ type: 'text', text: '丢弃' }] } }),
    ])

    const messagesPath = agentSessionMessagesPath('pi-rewind-source')
    const beforeRewind = readFileSync(messagesPath, 'utf-8')

    const retainedCount = await fork.rewindPiAgentSession('pi-rewind-source', 'assistant-keep')

    expect(retainedCount).toBe(2)
    expect(getAgentSessionMeta('pi-rewind-source')?.piEntryBindings).toEqual({ 'assistant-keep': 'entry-keep' })
    expect(getAgentSessionSDKMessages('pi-rewind-source').map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['user-1', 'assistant-keep'])
    // 回退前的 4 条完整正文留在 .bak——写入后、元数据提交前若进程被杀，这是唯一的找回手段
    expect(readFileSync(`${messagesPath}.bak`, 'utf-8')).toBe(beforeRewind)
  })
})

describe('fork/rewind 与 Skill 激活元信息 sidecar 的交互', () => {
  const skill = (slug: string) => ({ slug, name: slug, sources: ['read' as const] })

  test('Given Pi 会话回退截掉了后半段 When 回退完成 Then 被截掉的 user 消息的 sidecar 条目被修剪', async () => {
    const piSessionFile = join(tempHome, '.pi-source-rewind-skill.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'skill-sidecar-f', title: 'rewind', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: { 'assistant-keep': 'entry-keep' },
    }])
    writeAgentSessionJsonl('skill-sidecar-f', [
      JSON.stringify({ type: 'user', uuid: 'u-keep', message: { role: 'user', content: '留' } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '留' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u-cut', message: { role: 'user', content: '截' } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-cut', message: { content: [] } }),
    ])
    updateSDKUserMessageSkillActivations('skill-sidecar-f', 'u-keep', [skill('pdf')])
    updateSDKUserMessageSkillActivations('skill-sidecar-f', 'u-cut', [skill('xlsx')])

    await fork.rewindPiAgentSession('skill-sidecar-f', 'assistant-keep')

    const raw = JSON.parse(readFileSync(agentSessionSkillActivationsPath('skill-sidecar-f'), 'utf-8')) as { byUserMessageUuid: Record<string, unknown> }
    expect(Object.keys(raw.byUserMessageUuid)).toEqual(['u-keep'])
  })

  test('Given fork 只复制到某条消息 When fork 完成 Then 新会话只带被复制 user 消息的 sidecar 条目', async () => {
    const piSessionFile = join(tempHome, '.pi-source-fork-skill.jsonl')
    writeFileSync(piSessionFile, '', 'utf-8')
    writeAgentSessionsIndex([{
      id: 'skill-sidecar-g', title: 'fork src', workspaceId: 'workspace-a', createdAt: 1, updatedAt: 1,
      agentRuntime: 'pi', sdkSessionId: 'pi-source-session', piSessionFile,
      piEntryBindings: { 'assistant-keep': 'entry-keep' },
    }])
    writeAgentSessionJsonl('skill-sidecar-g', [
      JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '开始' } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-keep', message: { content: [{ type: 'text', text: '保留' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u-2', message: { role: 'user', content: '之后' } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-stale', message: { content: [] } }),
    ])
    updateSDKUserMessageSkillActivations('skill-sidecar-g', 'u-1', [skill('pdf')])
    updateSDKUserMessageSkillActivations('skill-sidecar-g', 'u-2', [skill('xlsx')])

    const forked = await fork.forkAgentSession({ sessionId: 'skill-sidecar-g', upToMessageUuid: 'assistant-keep' })

    const forkedMsgs = getAgentSessionSDKMessages(forked.id) as Array<{ uuid?: string; skill_activations?: { slug: string }[] }>
    expect(forkedMsgs.map((m) => m.uuid)).toEqual(['u-1', 'assistant-keep'])
    expect(forkedMsgs[0]!.skill_activations?.map((a) => a.slug)).toEqual(['pdf'])
    const forkedSidecar = JSON.parse(readFileSync(agentSessionSkillActivationsPath(forked.id), 'utf-8')) as { byUserMessageUuid: Record<string, unknown> }
    expect(Object.keys(forkedSidecar.byUserMessageUuid)).toEqual(['u-1'])
  })
})

describe('创建会话工具（复用 kernel 的 createAgentSession）', () => {
  test('Given kernel 已配置依赖 When 新建会话 Then fork 模块可直接复用', () => {
    const session = createAgentSession('冒烟会话')
    expect(session.id).toBeTruthy()
    expect(updateAgentSessionMeta(session.id, { reasoningLevel: 'high' }).reasoningLevel).toBe('high')
  })
})
