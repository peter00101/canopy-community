import { describe, expect, test } from 'bun:test'
import type { FileIndexEntry } from '@canopy/shared'
import { areStringListsEqual, hasMixedFileSources } from './file-search-sources'

function result(source: FileIndexEntry['source']): FileIndexEntry {
  return { name: 'report.md', path: 'report.md', type: 'file', source }
}

describe('文件搜索来源 badge', () => {
  test('会话与项目结果同时存在时显示来源区分', () => {
    expect(hasMixedFileSources([result('session'), result('workspace')])).toBe(true)
  })

  test('结果只有单一来源时不显示冗余 badge', () => {
    expect(hasMixedFileSources([result('session'), result('session')])).toBe(false)
    expect(hasMixedFileSources([result('workspace')])).toBe(false)
    expect(hasMixedFileSources([])).toBe(false)
  })
})

describe('文件搜索：父组件重渲染不应重跑搜索', () => {
  test('给定父组件每次渲染都新建内容相同的附加目录数组，当比较时，则视为同一组目录（不重置防抖、不闪加载图标）', () => {
    const first = ['C:/work/refs', 'C:/work/assets']
    const rerendered = ['C:/work/refs', 'C:/work/assets']
    expect(areStringListsEqual(first, rerendered)).toBe(true)
    expect(areStringListsEqual([], [])).toBe(true)
  })

  test('给定附加目录真的新增、删除或换序，当比较时，则视为变化（需要按新范围重新搜索）', () => {
    expect(areStringListsEqual(['C:/work/refs'], ['C:/work/refs', 'C:/work/assets'])).toBe(false)
    expect(areStringListsEqual(['C:/work/refs', 'C:/work/assets'], ['C:/work/refs'])).toBe(false)
    expect(areStringListsEqual(['C:/work/refs', 'C:/work/assets'], ['C:/work/assets', 'C:/work/refs'])).toBe(false)
  })
})
