/**
 * 文件树行组件 memo 的接线守卫。
 *
 * 2026-09-17 维护者转述用户报障「项目文件一直抖动」：训练项目展开大目录（约 2000 行）后，后台一有写入，
 * 每次 watcher 刷新都把所有行连同菜单 / Tooltip 重渲染一遍，dev 实测每次冻结约 420ms、20 秒冻 31 次。
 * 修复靠三处接线让 React.memo 真正生效；它们散落在组件里，纯函数测试守不住，这里直接读源码钉住。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'FileBrowser.tsx'), 'utf8')

describe('FileBrowser 行 memo 接线', () => {
  test('给定根级与子级行，当传刷新版本号时，则都经 getFileTreeRowRefreshVersion（文件行恒为 0）', () => {
    expect(source).toContain('refreshVersion={getFileTreeRowRefreshVersion(entry, filesVersion)}')
    expect(source).toContain('refreshVersion={getFileTreeRowRefreshVersion(child, refreshVersion)}')
    expect(source).not.toMatch(/refreshVersion=\{(filesVersion|refreshVersion)\}/)
  })

  test('给定 SidePanel 每次渲染都传新回调，当下传给行时，则先换成引用恒定的包装', () => {
    expect(source).toContain('useStableOptionalCallback(onAddToChatProp)')
    expect(source).toContain('useStableOptionalCallback(onFilePreviewProp)')
    expect(source).toContain('useStableOptionalCallback(onOpenDirectoryTerminalProp)')
  })

  test('给定目录行下传给子行的删除后刷新回调，当定义时，则用 useCallback 保持引用稳定', () => {
    expect(source).toContain('const handleRefreshAfterDelete = React.useCallback(')
    expect(source).toContain('const FileTreeItem = React.memo(')
  })
})
