import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@canopy/shared'
import { resolveAutomationWorkspace, summarizeAutomationWorkspace } from './automation-workspace'

function makeWorkspace(overrides: Partial<AgentWorkspace> & Pick<AgentWorkspace, 'id'>): AgentWorkspace {
  return {
    name: `工作区 ${overrides.id}`,
    slug: `ws-${overrides.id}`,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 记录每次查询的 id，用于断言「不静默回退」——回退会表现为查了当前工作区的 id。 */
function makeRegistry(...workspaces: AgentWorkspace[]) {
  const lookups: string[] = []
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const getWorkspace = (id: string): AgentWorkspace | undefined => {
    lookups.push(id)
    return byId.get(id)
  }
  return { lookups, getWorkspace }
}

describe('resolveAutomationWorkspace：定时任务目标工作区解析（上游 e297db8d 跨工作区创建）', () => {
  test('Given 省略 workspaceId 且当前会话有工作区 When 解析 Then 回退到当前工作区', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { lookups, getWorkspace } = makeRegistry(current)

    const resolved = resolveAutomationWorkspace(undefined, 'ws-current', getWorkspace)

    expect(resolved).toBe(current)
    expect(lookups).toEqual(['ws-current'])
  })

  test('Given 省略 workspaceId 且当前会话也没有工作区 When 解析 Then 返回 undefined 且不查询（兼容无工作区草稿）', () => {
    const { lookups, getWorkspace } = makeRegistry()

    expect(resolveAutomationWorkspace(undefined, undefined, getWorkspace)).toBeUndefined()
    expect(lookups).toEqual([])
  })

  test('Given 显式传空串 When 解析 Then 抛错提示先用 list_workspaces，且不回退当前工作区', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { lookups, getWorkspace } = makeRegistry(current)

    expect(() => resolveAutomationWorkspace('', 'ws-current', getWorkspace))
      .toThrow('workspaceId 必须是非空工作区 ID；请先使用 list_workspaces 查询')
    expect(lookups).toEqual([])
  })

  test('Given 显式传纯空白串 When 解析 Then 同样视为非法而不是省略', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { lookups, getWorkspace } = makeRegistry(current)

    expect(() => resolveAutomationWorkspace('   ', 'ws-current', getWorkspace)).toThrow('workspaceId 必须是非空工作区 ID')
    expect(lookups).toEqual([])
  })

  test('Given 显式传非字符串（数字 / null / 对象 / 数组） When 解析 Then 全部抛错且不查询', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { lookups, getWorkspace } = makeRegistry(current)

    for (const bad of [123, null, { id: 'ws-current' }, ['ws-current'], true]) {
      expect(() => resolveAutomationWorkspace(bad, 'ws-current', getWorkspace)).toThrow('workspaceId 必须是非空工作区 ID')
    }
    expect(lookups).toEqual([])
  })

  test('Given 显式传不存在的 id 且当前工作区存在 When 解析 Then 抛错并带上该 id，不静默回退到当前工作区', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { lookups, getWorkspace } = makeRegistry(current)

    expect(() => resolveAutomationWorkspace('ws-ghost', 'ws-current', getWorkspace))
      .toThrow('目标工作区不存在或已删除: ws-ghost；请重新使用 list_workspaces 查询')
    // 只查过目标 id，从未去拿当前工作区
    expect(lookups).toEqual(['ws-ghost'])
  })

  test('Given 显式传存在的目标 id（带首尾空白） When 解析 Then trim 后精确命中目标工作区而不是当前工作区', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const target = makeWorkspace({ id: 'ws-target', name: '项目 B', slug: 'project-b' })
    const { lookups, getWorkspace } = makeRegistry(current, target)

    const resolved = resolveAutomationWorkspace('  ws-target  ', 'ws-current', getWorkspace)

    expect(resolved).toBe(target)
    expect(lookups).toEqual(['ws-target'])
  })

  test('Given 显式传当前工作区自身的 id When 解析 Then 返回当前工作区（默认行为不变）', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const { getWorkspace } = makeRegistry(current)

    expect(resolveAutomationWorkspace('ws-current', 'ws-current', getWorkspace)).toBe(current)
  })

  test('Given 当前会话工作区 id 已被删除（索引里查不到） When 省略 workspaceId Then 抛错而不是返回 undefined', () => {
    const { lookups, getWorkspace } = makeRegistry()

    expect(() => resolveAutomationWorkspace(undefined, 'ws-deleted', getWorkspace))
      .toThrow('目标工作区不存在或已删除: ws-deleted')
    expect(lookups).toEqual(['ws-deleted'])
  })
})

describe('summarizeAutomationWorkspace：list_workspaces 返回的最小元数据', () => {
  test('Given 托管项目（无 projectRootPath） When 汇总 Then projectRootStatus 固定为 managed', () => {
    const workspace = makeWorkspace({ id: 'ws-managed' })

    expect(summarizeAutomationWorkspace(workspace).projectRootStatus).toBe('managed')
  })

  test('Given 无 projectRootPath 但索引残留了 projectRootStatus When 汇总 Then 仍按 managed 处理', () => {
    const workspace = makeWorkspace({ id: 'ws-managed', projectRootStatus: 'missing' })

    expect(summarizeAutomationWorkspace(workspace).projectRootStatus).toBe('managed')
  })

  test('Given 有 projectRootPath 且运行时状态为 available When 汇总 Then 原样透传 available', () => {
    const workspace = makeWorkspace({ id: 'ws-local', projectRootPath: 'D:/repo', projectRootStatus: 'available' })

    expect(summarizeAutomationWorkspace(workspace).projectRootStatus).toBe('available')
  })

  test('Given 有 projectRootPath 但未附加运行时状态（同步索引读出） When 汇总 Then 兜底为 unavailable', () => {
    const workspace = makeWorkspace({ id: 'ws-local', projectRootPath: 'D:/repo' })

    expect(summarizeAutomationWorkspace(workspace).projectRootStatus).toBe('unavailable')
  })

  test('Given 有 projectRootPath 且状态为 missing / not_directory / unavailable When 汇总 Then 逐一原样透传', () => {
    for (const status of ['missing', 'not_directory', 'unavailable'] as const) {
      const workspace = makeWorkspace({ id: `ws-${status}`, projectRootPath: 'D:/repo', projectRootStatus: status })
      expect(summarizeAutomationWorkspace(workspace).projectRootStatus).toBe(status)
    }
  })

  test('Given 传入当前工作区 id When 汇总 Then 只有同 id 的工作区 isCurrent 为 true，未传当前 id 时一律 false', () => {
    const current = makeWorkspace({ id: 'ws-current' })
    const other = makeWorkspace({ id: 'ws-other' })

    expect(summarizeAutomationWorkspace(current, 'ws-current').isCurrent).toBe(true)
    expect(summarizeAutomationWorkspace(other, 'ws-current').isCurrent).toBe(false)
    expect(summarizeAutomationWorkspace(current).isCurrent).toBe(false)
  })

  test('Given 工作区带有路径 / 时间戳等其他字段 When 汇总 Then 只暴露 id、name、slug、isCurrent、projectRootStatus 五个字段', () => {
    const workspace = makeWorkspace({
      id: 'ws-local',
      name: '项目 B',
      slug: 'project-b',
      projectRootPath: 'D:/secret/repo',
      projectRootStatus: 'available',
      createdAt: 111,
      updatedAt: 222,
    })

    const summary = summarizeAutomationWorkspace(workspace, 'ws-local')

    expect(summary).toEqual({
      id: 'ws-local',
      name: '项目 B',
      slug: 'project-b',
      isCurrent: true,
      projectRootStatus: 'available',
    })
    expect(Object.keys(summary).sort()).toEqual(['id', 'isCurrent', 'name', 'projectRootStatus', 'slug'])
  })
})
