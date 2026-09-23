import { describe, expect, it } from 'bun:test'
import { buildPreviewNotFoundReason, buildUnsupportedPreviewHeading, classifyTextPreviewResult } from './preview-load-state'

const okResult = (content: string) => ({
  resolvedPath: 'C:/tmp/a.md',
  content,
  isBinary: false,
  isTooLarge: false,
})

describe('classifyTextPreviewResult — 文本预览加载结果分类', () => {
  it('Given 主进程解析不到文件返回 null，When 分类，Then 给出含被请求路径与恢复提示的 unavailable（而非静默空白）', () => {
    const state = classifyTextPreviewResult(null, 'C:/ws/2026.08.17-2026.08.23_周报.md')
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') {
      expect(state.reason).toContain('未找到文件')
      expect(state.reason).toContain('2026.08.17-2026.08.23_周报.md')
      expect(state.reason).toContain('刷新')
    }
  })

  it('Given 旧构建 IPC 可能返回 undefined，When 分类，Then 同样归为 unavailable', () => {
    const state = classifyTextPreviewResult(undefined, 'a.md')
    expect(state.kind).toBe('unavailable')
  })

  it('Given 文件超过 5MB（isTooLarge），When 分类，Then 沿用既有超限文案', () => {
    const state = classifyTextPreviewResult({ ...okResult(''), isTooLarge: true }, 'big.md')
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') expect(state.reason).toContain('5 MB')
  })

  it('Given 二进制内容（isBinary），When 分类，Then 沿用既有二进制文案', () => {
    const state = classifyTextPreviewResult({ ...okResult(''), isBinary: true }, 'bin.md')
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') expect(state.reason).toContain('二进制')
  })

  it('Given 正常读取到内容，When 分类，Then 返回 ok 且内容原样透传', () => {
    const state = classifyTextPreviewResult(okResult('# 周报\n正文'), 'a.md')
    expect(state).toEqual({ kind: 'ok', content: '# 周报\n正文' })
  })

  it('Given 文件存在但内容为空串，When 分类，Then 仍是 ok（空文件占位由渲染层负责，不算不可用）', () => {
    const state = classifyTextPreviewResult(okResult(''), 'empty.md')
    expect(state).toEqual({ kind: 'ok', content: '' })
  })

  it('Given 同优先级冲突（既超限又标二进制），When 分类，Then 超限优先（与主进程先判大小的顺序一致）', () => {
    const state = classifyTextPreviewResult({ ...okResult(''), isBinary: true, isTooLarge: true }, 'x.md')
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') expect(state.reason).toContain('5 MB')
  })

  it('buildPreviewNotFoundReason：文案包含完整路径，供用户核对文件去向', () => {
    const reason = buildPreviewNotFoundReason('C:\\Users\\me\\报告.md')
    expect(reason).toContain('C:\\Users\\me\\报告.md')
  })
})

describe('buildUnsupportedPreviewHeading —— 降级卡片标题必须与实际原因一致（0.18.16）', () => {
  it('Given 未找到文件的 reason When 取标题 Then 说「未找到文件」而不是「无法安全内联预览」', () => {
    const reason = buildPreviewNotFoundReason('01_周报/2026.08.17-2026.08.23_周报.md')
    expect(buildUnsupportedPreviewHeading(reason)).toBe('未找到文件')
  })

  it('Given 超 5MB 的 reason When 取标题 Then 仍是「无法安全内联预览」', () => {
    const state = classifyTextPreviewResult(
      { resolvedPath: 'a.txt', content: '', isBinary: false, isTooLarge: true },
      'a.txt',
    )
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') {
      expect(buildUnsupportedPreviewHeading(state.reason)).toBe('无法安全内联预览')
    }
  })

  it('Given 二进制/编码异常的 reason When 取标题 Then 仍是「无法安全内联预览」', () => {
    const state = classifyTextPreviewResult(
      { resolvedPath: 'a.bin', content: '', isBinary: true, isTooLarge: false },
      'a.bin',
    )
    expect(state.kind).toBe('unavailable')
    if (state.kind === 'unavailable') {
      expect(buildUnsupportedPreviewHeading(state.reason)).toBe('无法安全内联预览')
    }
  })

  it('Given 空 reason（不该出现的兜底） When 取标题 Then 回落到通用标题', () => {
    expect(buildUnsupportedPreviewHeading('')).toBe('无法安全内联预览')
  })
})
