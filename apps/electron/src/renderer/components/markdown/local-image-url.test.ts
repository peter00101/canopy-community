import { describe, expect, test } from 'bun:test'
import type { FileAccessOptions } from '@canopy/shared'
import { resolveLocalImageUrl, type ResolveFilePathFn } from './local-image-url'

const ACCESS: FileAccessOptions = { sessionId: 'session-1', candidateBasePaths: ['/ws'] }

/** 记录每次调用的假解析器：按路径查表返回 URL，未命中返回 null。 */
function fakeResolver(table: Record<string, string>): ResolveFilePathFn & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (filePath: string, _access: FileAccessOptions) => {
    calls.push(filePath)
    const url = table[filePath]
    return url ? { url, path: filePath } : null
  }) as ResolveFilePathFn & { calls: string[] }
  fn.calls = calls
  return fn
}

describe('resolveLocalImageUrl：把本地图片 src 换成 canopy-file:// URL', () => {
  test('Given 相对路径且主进程解析成功 When 解析 Then 返回 URL 并只问一次', async () => {
    const resolve = fakeResolver({ 'sub/red.png': 'canopy-file://token/red.png' })
    expect(await resolveLocalImageUrl('sub/red.png', ACCESS, resolve)).toBe('canopy-file://token/red.png')
    expect(resolve.calls).toEqual(['sub/red.png'])
  })

  test('Given 直接可加载的 src When 解析 Then 返回 null 且不发起任何 IPC', async () => {
    const resolve = fakeResolver({})
    expect(await resolveLocalImageUrl('https://example.com/a.png', ACCESS, resolve)).toBeNull()
    expect(await resolveLocalImageUrl('data:image/png;base64,AAAA', ACCESS, resolve)).toBeNull()
    expect(await resolveLocalImageUrl('canopy-file://token/a.png', ACCESS, resolve)).toBeNull()
    expect(resolve.calls).toEqual([])
  })

  test('Given 百分号编码的 src When 原样候选未命中 Then 回落解码候选并成功', async () => {
    const resolve = fakeResolver({ 'my img.png': 'canopy-file://token/space.png' })
    expect(await resolveLocalImageUrl('my%20img.png', ACCESS, resolve)).toBe('canopy-file://token/space.png')
    expect(resolve.calls).toEqual(['my%20img.png', 'my img.png'])
  })

  test('Given 原样候选先命中 When 解析 Then 不再尝试解码候选', async () => {
    const resolve = fakeResolver({ 'my%20img.png': 'canopy-file://token/raw.png' })
    expect(await resolveLocalImageUrl('my%20img.png', ACCESS, resolve)).toBe('canopy-file://token/raw.png')
    expect(resolve.calls).toEqual(['my%20img.png'])
  })

  test('Given 全部候选都被拒 When 解析 Then 返回 null', async () => {
    const resolve = fakeResolver({})
    expect(await resolveLocalImageUrl('missing%20a.png', ACCESS, resolve)).toBeNull()
    expect(resolve.calls).toEqual(['missing%20a.png', 'missing a.png'])
  })

  test('Given 首个候选抛异常 When 解析 Then 继续尝试后续候选而非整体失败', async () => {
    const calls: string[] = []
    const resolve: ResolveFilePathFn = async (filePath) => {
      calls.push(filePath)
      if (filePath.includes('%20')) throw new Error('越界被拒')
      return { url: 'canopy-file://token/ok.png', path: filePath }
    }
    expect(await resolveLocalImageUrl('a%20b.png', ACCESS, resolve)).toBe('canopy-file://token/ok.png')
    expect(calls).toEqual(['a%20b.png', 'a b.png'])
  })

  test('Given 主进程返回空 url 的结果 When 解析 Then 视为未命中', async () => {
    const resolve: ResolveFilePathFn = async (filePath) => ({ url: '', path: filePath })
    expect(await resolveLocalImageUrl('red.png', ACCESS, resolve)).toBeNull()
  })

  test('Given 授权上下文 When 解析 Then 原样传给主进程（授权边界不在渲染层判定）', async () => {
    const receivedAccess: FileAccessOptions[] = []
    const resolve: ResolveFilePathFn = async (filePath, access) => {
      receivedAccess.push(access)
      return { url: 'canopy-file://token/x.png', path: filePath }
    }
    await resolveLocalImageUrl('red.png', ACCESS, resolve)
    expect(receivedAccess).toEqual([ACCESS])
  })
})
