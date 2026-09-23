import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideRevealTarget } from './reveal-target'

describe('「打开文件所在位置」的落点（2026-09-17 项目记忆里点了没反应）', () => {
  let root: string
  let workspace: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'reveal-target-')))
    workspace = join(root, 'agent-workspaces', 'default')
    mkdirSync(join(workspace, 'memory'), { recursive: true })
    writeFileSync(join(workspace, 'memory', 'MEMORY.md'), '# memory\n')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('Given 文件存在 When 打开所在位置 Then 在文件管理器里选中它', () => {
    const file = join(workspace, 'memory', 'MEMORY.md')
    expect(decideRevealTarget(file, { fallbackToParentFolder: true })).toEqual({ kind: 'item', path: file })
    expect(decideRevealTarget(file, { fallbackToParentFolder: false })).toEqual({ kind: 'item', path: file })
  })

  test('Given 目标本身是文件夹 When 打开所在位置 Then 同样按选中处理', () => {
    expect(decideRevealTarget(workspace, { fallbackToParentFolder: true })).toEqual({ kind: 'item', path: workspace })
  })

  test('Given AGENTS.md 还没创建、工作区目录在 When 打开所在位置 Then 改为打开它所在的文件夹', () => {
    expect(decideRevealTarget(join(workspace, 'AGENTS.md'), { fallbackToParentFolder: true }))
      .toEqual({ kind: 'folder', path: workspace })
  })

  test('Given 调用方没要求回退（如消息里的文件 chip） When 文件不存在 Then 仍判缺失，由调用方提示「未找到文件」', () => {
    expect(decideRevealTarget(join(workspace, 'AGENTS.md'), { fallbackToParentFolder: false })).toEqual({ kind: 'missing' })
    expect(decideRevealTarget(join(workspace, 'AGENTS.md'))).toEqual({ kind: 'missing' })
  })

  test('Given 文件与所在文件夹都不存在 When 打开所在位置 Then 判缺失，不往更上层乱跳', () => {
    expect(decideRevealTarget(join(workspace, 'gone', 'note.md'), { fallbackToParentFolder: true })).toEqual({ kind: 'missing' })
  })

  test('Given 所在位置其实是个文件 When 打开所在位置 Then 判缺失', () => {
    expect(decideRevealTarget(join(workspace, 'memory', 'MEMORY.md', 'child.md'), { fallbackToParentFolder: true }))
      .toEqual({ kind: 'missing' })
  })

  test('Given 路径为空（候选根都没命中） When 打开所在位置 Then 判缺失，不落到进程当前目录', () => {
    expect(decideRevealTarget('', { fallbackToParentFolder: true })).toEqual({ kind: 'missing' })
  })
})
