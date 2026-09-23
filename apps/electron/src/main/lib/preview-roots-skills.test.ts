import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 预览授权根里必须包含工作区 skills 目录的结构守卫（0.19.11，维护者报障「会话里 Skill 预览不了」）。
 *
 * `getExplicitPreviewDirectoryRoots` 住在 `ipc.ts`，依赖会话索引 / 工作区 / Electron 路径，单测里真跑不了；
 * 按仓库里调用点守卫的惯例钉源码结构，行为由 dev 真机 E2E 覆盖（`file:resolve-path` 对
 * `<workspace>/skills/<skill>/SKILL.md` 修前 null、修后返回路径）。
 */
const source = readFileSync(join(import.meta.dir, '..', 'ipc.ts'), 'utf-8')

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('预览授权根：工作区 skills 目录', () => {
  const rootsFn = sliceBetween(source, 'function getExplicitPreviewDirectoryRoots(', 'function getExplicitPreviewFilePaths(')

  test('Given 显式目录根收集函数 When 按可访问工作区遍历 Then 每个工作区的 skills 目录都被列为根', () => {
    // 源码可能是 CRLF，行尾用 \r?\n 兼容；只截到循环自己的右花括号（两格缩进）为止
    const loop = rootsFn.match(/for \(const slug of getWorkspaceSlugsForAccess\(options\)\) \{[\s\S]*?\r?\n {2}\}/)?.[0]
    expect(loop).toBeDefined()
    expect(loop).toContain('add(getWorkspaceSkillsDir(slug))')
  })

  test('Given 显式目录根收集函数 When 检查聚合根 Then 仍不把 agent-workspaces 总目录整体列为根', () => {
    expect(rootsFn).not.toContain('getAgentWorkspacesDir()')
  })
})
