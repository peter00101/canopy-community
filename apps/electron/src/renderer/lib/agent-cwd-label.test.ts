import { describe, expect, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { describeAgentCwd, getPathBasename } from './agent-cwd-label'

const BS = String.fromCharCode(92)
const win = (...segments: string[]): string => segments.join(BS)

describe('describeAgentCwd —— 会话头显示 Agent 真实工作目录', () => {
  const sessionPath = win('C:', 'u', CANOPY_BRAND.configDirName, 'agent-workspaces', 'default', 'session-1')
  const projectFilesPath = win('C:', 'u', CANOPY_BRAND.configDirName, 'agent-workspaces', 'default', 'workspace-files')

  test('Given 新建会话（agentCwdMode=project） When 描述 Then cwd 是项目文件根而不是会话工作台', () => {
    const d = describeAgentCwd({ agentCwdMode: 'project', projectFilesPath, sessionPath })
    expect(d).toMatchObject({ kind: 'project', kindLabel: '项目文件根', name: 'workspace-files', path: projectFilesPath })
    expect(d?.tooltip).toContain(projectFilesPath)
  })

  test('Given 本地目录项目 When 描述 Then 显示用户选的目录名', () => {
    const local = '/Users/me/code/my-app'
    expect(describeAgentCwd({ agentCwdMode: 'project', projectFilesPath: local, sessionPath })).toMatchObject({ kind: 'project', name: 'my-app', path: local })
  })

  test('Given 存量会话缺失 agentCwdMode When 描述 Then 与主进程一致地回落到会话工作台', () => {
    expect(describeAgentCwd({ projectFilesPath, sessionPath })).toMatchObject({ kind: 'session', kindLabel: '会话工作台', name: 'session-1', path: sessionPath })
  })

  test('Given 激活了 worktree When 描述 Then worktree 优先于 cwd 模式并带分支名', () => {
    const wt = '/repo/.worktrees/feature-x'
    const d = describeAgentCwd({ agentCwdMode: 'project', projectFilesPath, sessionPath, activeWorktreePath: wt, activeWorktreeBranch: 'feature-x' })
    expect(d).toMatchObject({ kind: 'worktree', kindLabel: 'Git worktree · feature-x', name: 'feature-x', path: wt })
  })

  test('Given 所需路径尚未加载 When 描述 Then 返回 null（不渲染错误徽标）', () => {
    expect(describeAgentCwd({ agentCwdMode: 'project', sessionPath })).toBeNull()
    expect(describeAgentCwd({ agentCwdMode: 'session' })).toBeNull()
  })

  test('getPathBasename：兼容两种分隔符与末尾斜杠', () => {
    expect(getPathBasename('/a/b/c/')).toBe('c')
    expect(getPathBasename(win('C:', 'x', 'y'))).toBe('y')
    expect(getPathBasename('plain')).toBe('plain')
  })
})
