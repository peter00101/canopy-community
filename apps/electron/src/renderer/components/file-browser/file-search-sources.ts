import type { FileIndexEntry } from '@canopy/shared'

/**
 * 两组路径是否逐项相同（顺序敏感）。
 *
 * SidePanel 每次渲染都会用 `?? []` 新建附加目录数组；搜索 effect 若按引用依赖它，
 * Agent 流式输出与 watcher 刷新期间会被不断重跑（重置防抖、取消在途搜索），
 * 搜索框里的加载图标就会一直转。按内容比较后，只有目录真正变化才重新搜索。
 */
export function areStringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

export function hasMixedFileSources(entries: readonly FileIndexEntry[]): boolean {
  let hasSession = false
  let hasWorkspace = false
  for (const entry of entries) {
    if (entry.source === 'session') hasSession = true
    if (entry.source === 'workspace') hasWorkspace = true
    if (hasSession && hasWorkspace) return true
  }
  return false
}
