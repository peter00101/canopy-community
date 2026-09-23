import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

/**
 * `claimWorkspaceMemoryRefreshOpportunity` 是"认领即消费"语义（命中时落盘记录邀请
 * 时间），与 `memoryRefreshLifecycleHook` 的门槛/拼接逻辑此前均无测试覆盖。
 *
 * 用依赖注入（`ClaimWorkspaceMemoryRefreshOpportunityDeps`）驱动测试逻辑，不对
 * `./agent-session-manager`/`./agent-workspace-manager` 做 `mock.module`——
 * 这两个文件被大量其他模块与测试依赖，wholesale mock 在全量测试跑批时会造成
 * 模块级串扰（本文件初版即踩过这个坑：8 个新测试通过，但导致
 * `agent-session-manager.test.ts` 里 8 个既有用例失败）。
 *
 * 但 `agent-memory-refresh-service.ts` 顶层仍 import 这两个真实模块（用于生产
 * 默认依赖），其 import 链需要 `electron`；测试环境无真实 Electron，且不应触碰
 * 运行本测试者的真实 `~/.canopy`，故仍需最小 electron mock + 临时 HOME，与
 * `agent-session-manager.test.ts` 保持一致的安全模式。
 */

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

let claimWorkspaceMemoryRefreshOpportunity: typeof import('./agent-memory-refresh-service').claimWorkspaceMemoryRefreshOpportunity
let createMemoryRefreshLifecycleHook: typeof import('./agent-memory-refresh-service').createMemoryRefreshLifecycleHook
let WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS: typeof import('./agent-memory-refresh-service').WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS
type ClaimWorkspaceMemoryRefreshOpportunityDeps = import('./agent-memory-refresh-service').ClaimWorkspaceMemoryRefreshOpportunityDeps

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-memory-refresh-'))
  process.env.HOME = tempHome
  process.env.CANOPY_DEV = '0'
  ;({ claimWorkspaceMemoryRefreshOpportunity, createMemoryRefreshLifecycleHook, WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS } =
    await import('./agent-memory-refresh-service'))
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

interface MockSession {
  workspaceId?: string
  updatedAt: number
}

interface MockState {
  lastPromptAt: number | undefined
  memoryUpdatedAt: number | undefined
  sessions: MockSession[]
  recordedInvitations: Array<{ workspaceSlug: string; at: number }>
}

const state: MockState = {
  lastPromptAt: undefined,
  memoryUpdatedAt: undefined,
  sessions: [],
  recordedInvitations: [],
}

function makeDeps(): ClaimWorkspaceMemoryRefreshOpportunityDeps {
  return {
    getWorkspaceMemoryReviewLastPromptAt: () => state.lastPromptAt,
    getWorkspaceMemorySummary: () => ({ autoMemory: { updatedAt: state.memoryUpdatedAt } }),
    listAgentSessions: () => state.sessions,
    recordWorkspaceMemoryReviewInvitation: (workspaceSlug, at) => {
      state.recordedInvitations.push({ workspaceSlug, at })
    },
  }
}

beforeEach(() => {
  state.lastPromptAt = undefined
  state.memoryUpdatedAt = undefined
  state.sessions = []
  state.recordedInvitations = []
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

describe('claimWorkspaceMemoryRefreshOpportunity', () => {
  test('Given 无 workspaceSlug When 认领 Then 返回 undefined', () => {
    expect(claimWorkspaceMemoryRefreshOpportunity(undefined, NOW, makeDeps())).toBeUndefined()
  })

  test('Given 无更新会话 When 认领 Then 返回 undefined 且不落盘', () => {
    state.memoryUpdatedAt = NOW - 10 * DAY_MS
    state.sessions = [{ workspaceId: 'ws-1', updatedAt: NOW - 20 * DAY_MS }]

    const result = claimWorkspaceMemoryRefreshOpportunity('ws-1', NOW, makeDeps())

    expect(result).toBeUndefined()
    expect(state.recordedInvitations).toHaveLength(0)
  })

  test('Given 冷却窗口内已有更新会话 When 认领 Then 返回 undefined（不重复邀请）', () => {
    state.memoryUpdatedAt = NOW - 10 * DAY_MS
    state.sessions = [{ workspaceId: 'ws-1', updatedAt: NOW - 1 * DAY_MS }]
    state.lastPromptAt = NOW - 1 * DAY_MS // 距今不足 WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS

    const result = claimWorkspaceMemoryRefreshOpportunity('ws-1', NOW, makeDeps())

    expect(result).toBeUndefined()
    expect(state.recordedInvitations).toHaveLength(0)
  })

  test('Given 超过冷却窗口且有更新会话 When 认领 Then 命中并落盘记录邀请时间', () => {
    state.memoryUpdatedAt = NOW - (WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS + 1) * DAY_MS
    state.sessions = [
      { workspaceId: 'ws-1', updatedAt: NOW - 1 * DAY_MS },
      { workspaceId: 'ws-1', updatedAt: NOW - 2 * DAY_MS },
      { workspaceId: 'other-ws', updatedAt: NOW }, // 其他工作区不计入
    ]

    const result = claimWorkspaceMemoryRefreshOpportunity('ws-1', NOW, makeDeps())

    expect(result).toEqual({
      memoryUpdatedAt: state.memoryUpdatedAt,
      newestSessionAt: NOW - 1 * DAY_MS,
      newerSessionCount: 2,
    })
    expect(state.recordedInvitations).toEqual([{ workspaceSlug: 'ws-1', at: NOW }])
  })

  test('Given 从未有过记忆更新 When 认领 Then 以 0 为基准判断新会话', () => {
    state.memoryUpdatedAt = undefined
    state.sessions = [{ workspaceId: 'ws-1', updatedAt: NOW - (WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS + 1) * DAY_MS }]

    const result = claimWorkspaceMemoryRefreshOpportunity('ws-1', NOW, makeDeps())

    expect(result?.newerSessionCount).toBe(1)
  })
})

describe('createMemoryRefreshLifecycleHook(deps).onBeforeSystemPrompt', () => {
  test('Given needsCollaborationProfile=true When 调用 Then 跳过、不触碰 claim（不落盘）', () => {
    state.memoryUpdatedAt = NOW - (WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS + 1) * DAY_MS
    state.sessions = [{ workspaceId: 'ws-1', updatedAt: NOW - 1 * DAY_MS }]
    const hook = createMemoryRefreshLifecycleHook(makeDeps())

    const result = hook.onBeforeSystemPrompt({
      workspaceSlug: 'ws-1',
      needsCollaborationProfile: true,
      now: NOW,
    })

    expect(result).toBeUndefined()
    expect(state.recordedInvitations).toHaveLength(0)
  })

  test('Given claim 未命中（冷却窗口内）When 调用 Then 返回 undefined', () => {
    state.memoryUpdatedAt = NOW - 1 * DAY_MS
    state.sessions = [{ workspaceId: 'ws-1', updatedAt: NOW }]
    const hook = createMemoryRefreshLifecycleHook(makeDeps())

    const result = hook.onBeforeSystemPrompt({
      workspaceSlug: 'ws-1',
      needsCollaborationProfile: false,
      now: NOW,
    })

    expect(result).toBeUndefined()
  })

  test('Given claim 命中 When 调用 Then 返回文案且包含更新会话数', () => {
    state.memoryUpdatedAt = NOW - (WORKSPACE_MEMORY_REVIEW_INTERVAL_DAYS + 1) * DAY_MS
    state.sessions = [
      { workspaceId: 'ws-1', updatedAt: NOW - 1 * DAY_MS },
      { workspaceId: 'ws-1', updatedAt: NOW - 2 * DAY_MS },
      { workspaceId: 'ws-1', updatedAt: NOW - 3 * DAY_MS },
    ]
    const hook = createMemoryRefreshLifecycleHook(makeDeps())

    const result = hook.onBeforeSystemPrompt({
      workspaceSlug: 'ws-1',
      needsCollaborationProfile: false,
      now: NOW,
    })

    expect(result).toContain('## 项目记忆复查邀请')
    expect(result).toContain('产生了 3 个更新会话')
    expect(result).toContain('AskUserQuestion')
    expect(state.recordedInvitations).toEqual([{ workspaceSlug: 'ws-1', at: NOW }])
  })
})
