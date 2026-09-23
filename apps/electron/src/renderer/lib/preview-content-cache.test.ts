import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  clearPreviewContentCacheForFile,
  clearPreviewContentCacheForSession,
  getPreviewContentCache,
  setPreviewContentCache,
} from './preview-content-cache'

const entry = (text: string) => ({ oldContent: '', newContent: text })
const previewKey = (session: string, file: string, version: number) => `${session}:preview:${file}@v${version}:{"dirPath":""}`

describe('预览内容缓存 — 按文件清理', () => {
  test('Given 同一文件的多个版本 When 按文件清理 Then 该文件所有版本失效，同会话其他文件与其他会话不受影响', () => {
    setPreviewContentCache(previewKey('s1', 'C:/a/note.md', 1), entry('A1'))
    setPreviewContentCache(previewKey('s1', 'C:/a/note.md', 2), entry('A2'))
    setPreviewContentCache(previewKey('s1', 'C:/a/note.md.bak', 1), entry('同前缀的另一个文件'))
    setPreviewContentCache(previewKey('s1', 'C:/a/other.md', 1), entry('B'))
    setPreviewContentCache(previewKey('s2', 'C:/a/note.md', 1), entry('另一个会话'))

    clearPreviewContentCacheForFile('s1', 'C:/a/note.md')

    expect(getPreviewContentCache(previewKey('s1', 'C:/a/note.md', 1))).toBeUndefined()
    expect(getPreviewContentCache(previewKey('s1', 'C:/a/note.md', 2))).toBeUndefined()
    expect(getPreviewContentCache(previewKey('s1', 'C:/a/note.md.bak', 1))?.newContent).toBe('同前缀的另一个文件')
    expect(getPreviewContentCache(previewKey('s1', 'C:/a/other.md', 1))?.newContent).toBe('B')
    expect(getPreviewContentCache(previewKey('s2', 'C:/a/note.md', 1))?.newContent).toBe('另一个会话')
    clearPreviewContentCacheForSession('s1')
    clearPreviewContentCacheForSession('s2')
  })

  test('Given 关闭后重开（版本号从头计数）When 先按文件清理再按同一 key 读 Then 读不到关闭前的旧内容', () => {
    const key = previewKey('s3', 'C:/a/plain.txt', 1)
    setPreviewContentCache(key, entry('关闭前的内容'))
    clearPreviewContentCacheForFile('s3', 'C:/a/plain.txt')
    expect(getPreviewContentCache(key)).toBeUndefined()
  })
})

describe('预览内容缓存 — 调用方约定', () => {
  // 0.18.52 合并上游 #1940 时只收了 SidePanel 与本模块，DiffTabContent 仍留着一份私有缓存：
  // 关闭标签清的是这份、预览读写的是那份，重开后命中旧条目显示关闭前的内容（0.18.97 修）。
  test('Given DiffTabContent 源码 When 检查 Then 读写都走本模块，不再自建私有内容缓存', () => {
    const source = readFileSync(new URL('../components/diff/DiffTabContent.tsx', import.meta.url), 'utf-8')
    expect(source).toContain("from '@/lib/preview-content-cache'")
    expect(source).toContain('getPreviewContentCache(')
    expect(source).toContain('setPreviewContentCache(')
    expect(source).not.toMatch(/\bconst contentCache\s*=\s*new Map/)
    expect(source).not.toMatch(/\bfunction cache(Get|Set)\(/)
  })

  test('Given 手动刷新 When 检查 DiffTabContent Then 刷新前先按文件清缓存', () => {
    const source = readFileSync(new URL('../components/diff/DiffTabContent.tsx', import.meta.url), 'utf-8')
    const refresh = source.slice(source.indexOf('const handleManualRefresh'), source.indexOf('const handleAddSelectionToAgent'))
    expect(refresh).toContain('clearPreviewContentCacheForFile(sessionId, filePath)')
  })
})
