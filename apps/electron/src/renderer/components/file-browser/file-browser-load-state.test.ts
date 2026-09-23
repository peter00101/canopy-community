import { describe, expect, test } from 'bun:test'
import {
  getFileBrowserVisibleEntries,
  getFileTreeRowRefreshVersion,
  REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE,
  reconcileFileBrowserEntries,
  shouldKeepPreviousListingOnRefreshFailure,
  shouldShowFileBrowserEmptyState,
} from './file-browser-load-state'
import type { FileBrowserComparableEntry } from './file-browser-load-state'

const ROOTS_A = JSON.stringify([['project', 'C:/work/project-a']])
const ROOTS_B = JSON.stringify([['project', 'C:/work/project-b']])

function file(name: string, extra: Partial<FileBrowserComparableEntry> = {}): FileBrowserComparableEntry {
  return {
    name,
    path: `C:/work/project-a/${name}`,
    isDirectory: false,
    size: 10,
    scope: 'project',
    rootPath: 'C:/work/project-a',
    ...extra,
  }
}

function dir(name: string): FileBrowserComparableEntry {
  return file(name, { isDirectory: true, size: undefined })
}

describe('文件树后台刷新：刷新期间保留旧内容', () => {
  test('给定同一组根目录已加载出文件列表，当 watcher 触发后台刷新且结果尚未返回时，则仍展示旧列表且不显示「目录为空」占位', () => {
    const entries = [dir('docs'), file('a.md'), file('b.md')]
    // 刷新开始时 loadedRootsKey 保持不变，只是新的 IPC 在途
    const visible = getFileBrowserVisibleEntries(entries, ROOTS_A, ROOTS_A)

    expect(visible).toBe(entries)
    expect(shouldShowFileBrowserEmptyState({
      currentRootsKey: ROOTS_A,
      loadedRootsKey: ROOTS_A,
      entryCount: visible.length,
      hasError: false,
      hideEmpty: false,
    })).toBe(false)
  })

  test('给定已确认为空的目录，当后台刷新进行中时，则「目录为空」保持显示而不是先消失再出现', () => {
    const visible = getFileBrowserVisibleEntries([], ROOTS_A, ROOTS_A)
    expect(shouldShowFileBrowserEmptyState({
      currentRootsKey: ROOTS_A,
      loadedRootsKey: ROOTS_A,
      entryCount: visible.length,
      hasError: false,
      hideEmpty: false,
    })).toBe(true)
  })

  test('给定根目录已切换到另一个项目，当新项目尚未加载完成时，则不展示上一个项目的文件', () => {
    const entries = [file('a.md')]
    expect(getFileBrowserVisibleEntries(entries, ROOTS_A, ROOTS_B)).toEqual([])
  })
})

describe('文件树后台刷新：内容没变就不触发重渲染', () => {
  test('给定刷新结果与当前列表逐项一致（新数组、新对象），当合并结果时，则返回原数组引用', () => {
    const previous = [dir('docs'), file('a.md'), file('b.md')]
    const next = [dir('docs'), file('a.md'), file('b.md')]

    expect(reconcileFileBrowserEntries(previous, next)).toBe(previous)
  })

  test('给定两次都是空目录，当合并结果时，则返回原数组引用', () => {
    const previous: FileBrowserComparableEntry[] = []
    expect(reconcileFileBrowserEntries(previous, [])).toBe(previous)
  })

  test('给定 Agent 新写入一个文件，当合并结果时，则返回新数组、按新结果排序，未变的条目复用旧对象', () => {
    const docs = dir('docs')
    const a = file('a.md')
    const b = file('b.md')
    const created = file('a2.md')

    const merged = reconcileFileBrowserEntries([docs, a, b], [dir('docs'), file('a.md'), created, file('b.md')])

    expect(merged.map((entry) => entry.name)).toEqual(['docs', 'a.md', 'a2.md', 'b.md'])
    expect(merged[0]).toBe(docs)
    expect(merged[1]).toBe(a)
    expect(merged[2]).toBe(created)
    expect(merged[3]).toBe(b)
  })

  test('给定某个文件被删除，当合并结果时，则返回不含该文件的新数组且其余条目复用旧对象', () => {
    const a = file('a.md')
    const b = file('b.md')
    const merged = reconcileFileBrowserEntries([a, b], [file('b.md')])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(b)
  })

  test('给定某个文件大小因写入而变化，当合并结果时，则只替换该条目对象', () => {
    const a = file('a.md')
    const b = file('b.md')
    const grown = file('b.md', { size: 2048 })
    const previous = [a, b]

    const merged = reconcileFileBrowserEntries(previous, [file('a.md'), grown])

    expect(merged).not.toBe(previous)
    expect(merged[0]).toBe(a)
    expect(merged[1]).toBe(grown)
  })

  test('给定同名条目从文件变成目录，当合并结果时，则视为变化并使用新条目', () => {
    const previous = [file('build')]
    const next = [file('build', { isDirectory: true, size: undefined })]

    const merged = reconcileFileBrowserEntries(previous, next)
    expect(merged).not.toBe(previous)
    expect(merged[0]?.isDirectory).toBe(true)
  })

  test('给定条目顺序发生变化，当合并结果时，则返回新数组以反映新顺序', () => {
    const a = file('a.md')
    const b = file('b.md')
    const merged = reconcileFileBrowserEntries([a, b], [file('b.md'), file('a.md')])

    expect(merged.map((entry) => entry.name)).toEqual(['b.md', 'a.md'])
    expect(merged[0]).toBe(b)
    expect(merged[1]).toBe(a)
  })

  test('给定同一路径但来源根不同（会话文件移入项目），当合并结果时，则视为变化', () => {
    const previous = [file('a.md', { scope: 'session', rootPath: 'C:/work/session' })]
    const next = [file('a.md', { scope: 'project', rootPath: 'C:/work/project-a' })]

    expect(reconcileFileBrowserEntries(previous, next)).not.toBe(previous)
  })
})

describe('文件树后台刷新：偶发失败不清空整棵树', () => {
  test('给定同一组根目录已成功加载过，当后台刷新失败时，则保留旧列表、不把整棵树换成错误行', () => {
    expect(shouldKeepPreviousListingOnRefreshFailure({ requestKey: ROOTS_A, loadedKey: ROOTS_A })).toBe(true)
  })

  test('给定从未成功加载过（首次打开），当加载失败时，则如实展示错误', () => {
    expect(shouldKeepPreviousListingOnRefreshFailure({ requestKey: ROOTS_A, loadedKey: null })).toBe(false)
  })

  test('给定根目录刚切换到另一个项目，当新项目加载失败时，则展示错误而不是沿用旧项目的列表', () => {
    expect(shouldKeepPreviousListingOnRefreshFailure({ requestKey: ROOTS_B, loadedKey: ROOTS_A })).toBe(false)
  })
})

describe('文件树刷新失败的提示：保留列表但不静默', () => {
  test('给定保留旧列表时展示的提示，当读文案时，则明确说明刷新失败且显示的是旧内容', () => {
    expect(REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE).toContain('刷新失败')
    expect(REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE).toContain('上次')
  })
})

describe('行组件刷新版本号：只有目录随 watcher 刷新', () => {
  test('给定目录行，当文件版本号变化时，则把版本号原样传给它以便重新列出子项', () => {
    expect(getFileTreeRowRefreshVersion(dir('run'), 7)).toBe(7)
    expect(getFileTreeRowRefreshVersion(dir('run'), 8)).toBe(8)
  })

  test('给定文件行，当文件版本号变化时，则恒为 0，行组件 memo 不会因一次后台刷新而失效', () => {
    expect(getFileTreeRowRefreshVersion(file('train.log'), 7)).toBe(0)
    expect(getFileTreeRowRefreshVersion(file('train.log'), 8)).toBe(0)
  })
})
