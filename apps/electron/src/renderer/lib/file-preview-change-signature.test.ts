import { describe, expect, test } from 'bun:test'
import type { FilePreviewReadResult } from '@canopy/shared'
import { buildFilePreviewChangeSignature, cyrb53 } from './file-preview-change-signature'

/** 造一个预览读取结果；Office 这类二进制文件的 content 恒为空串，与主进程实际行为一致。 */
function makeResult(overrides: {
  content?: string
  size?: number
  modifiedAt?: number
  name?: string
  extension?: string
}): FilePreviewReadResult {
  return {
    resolvedPath: `/tmp/${overrides.name ?? 'probe.xlsx'}`,
    content: overrides.content ?? '',
    isBinary: (overrides.content ?? '') === '',
    isTooLarge: false,
    metadata: {
      name: overrides.name ?? 'probe.xlsx',
      extension: overrides.extension ?? '.xlsx',
      size: overrides.size ?? 3916,
      modifiedAt: overrides.modifiedAt ?? 1_788_874_000_000,
    },
  }
}

describe('预览文件变化指纹（焦点回窗的外部修改检测）', () => {
  test('Given 同一个未改动的文件, When 两次求指纹, Then 相同（不会误报变化）', () => {
    expect(buildFilePreviewChangeSignature(makeResult({})))
      .toBe(buildFilePreviewChangeSignature(makeResult({})))
  })

  test('Given Office 文档内容恒为空串, When 大小变了, Then 指纹变化（修复前恒等）', () => {
    const before = buildFilePreviewChangeSignature(makeResult({ content: '', size: 3916 }))
    const after = buildFilePreviewChangeSignature(makeResult({ content: '', size: 4102 }))
    expect(before).not.toBe(after)
  })

  test('Given Office 文档大小碰巧不变, When 修改时间变了, Then 指纹仍变化', () => {
    const before = buildFilePreviewChangeSignature(makeResult({ content: '', modifiedAt: 1_788_874_000_000 }))
    const after = buildFilePreviewChangeSignature(makeResult({ content: '', modifiedAt: 1_788_874_009_000 }))
    expect(before).not.toBe(after)
  })

  test('Given 文本文件大小与修改时间都没变, When 内容变了, Then 指纹仍变化（保留内容 hash）', () => {
    const before = buildFilePreviewChangeSignature(makeResult({ content: 'AAAA', size: 4, extension: '.md' }))
    const after = buildFilePreviewChangeSignature(makeResult({ content: 'BBBB', size: 4, extension: '.md' }))
    expect(before).not.toBe(after)
  })

  test('Given 文件读不到, When 求指纹, Then 返回 missing 且与空文件可区分', () => {
    expect(buildFilePreviewChangeSignature(null)).toBe('missing')
    expect(buildFilePreviewChangeSignature(undefined)).toBe('missing')
    expect(buildFilePreviewChangeSignature(makeResult({ content: '', size: 0 }))).not.toBe('missing')
  })

  test('Given dev 下拿到缺 metadata 的老结构, When 求指纹, Then 不抛错并退化为内容 hash', () => {
    const legacy = { resolvedPath: '/tmp/a.md', content: 'hello', isBinary: false, isTooLarge: false } as unknown as FilePreviewReadResult
    expect(() => buildFilePreviewChangeSignature(legacy)).not.toThrow()
    expect(buildFilePreviewChangeSignature(legacy)).toBe(`-1:-1:${cyrb53('hello')}`)
  })
})

describe('cyrb53', () => {
  test('Given 不同字符串, When 求 hash, Then 结果不同', () => {
    expect(cyrb53('abc')).not.toBe(cyrb53('abd'))
  })

  test('Given 同一字符串, When 多次求 hash, Then 稳定', () => {
    expect(cyrb53('canopy')).toBe(cyrb53('canopy'))
  })
})
