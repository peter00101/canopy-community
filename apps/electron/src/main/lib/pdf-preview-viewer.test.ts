import { describe, expect, test } from 'bun:test'
import { buildPreviewFindMatcher, findPreviewMatches } from '../../renderer/lib/preview-find-matcher'
import {
  buildPdfFindMatcher,
  buildPdfPageTextIndex,
  buildPdfPreviewHtml,
  findPdfMatches,
  locatePdfMatch,
  type PdfPreviewFindOptions,
} from './pdf-preview-viewer'

const PLAIN: PdfPreviewFindOptions = { caseSensitive: false, wholeWord: false, regex: false }

describe('PDF 查找索引', () => {
  test('Given 带 markedContent 与行尾的条目 When 建索引 Then 只收带 str 的条目（与 TextLayer 节点一一对应），行尾补空格', () => {
    const index = buildPdfPageTextIndex([
      { str: '预览' },
      { type: 'beginMarkedContent' } as never,
      { str: '补全', hasEOL: true },
      { str: 'next' },
    ])
    expect(index.text).toBe('预览补全 next')
    expect(index.starts).toEqual([0, 2, 5])
    expect(index.lengths).toEqual([2, 2, 4])
  })

  test('Given 被折到两行的词组 When 搜「补全 next」 Then 能跨行命中', () => {
    const index = buildPdfPageTextIndex([{ str: '补全', hasEOL: true }, { str: 'next' }])
    expect(findPdfMatches(index.text, buildPdfFindMatcher('补全 next', PLAIN)!, 10)).toEqual([{ start: 0, end: 7 }])
  })
})

describe('PDF 命中位置映射回文字节点', () => {
  const index = buildPdfPageTextIndex([{ str: 'The quick' }, { str: ' brown', hasEOL: true }, { str: 'fox' }])

  test('Given 命中落在单个条目内 When 映射 Then 起止都在该条目', () => {
    const start = index.text.indexOf('quick')
    expect(locatePdfMatch(index, start, start + 5)).toEqual({ startItem: 0, startOffset: 4, endItem: 0, endOffset: 9 })
  })

  test('Given 命中跨两个条目 When 映射 Then 起点在前一条目、终点在后一条目', () => {
    const start = index.text.indexOf('quick brown')
    expect(locatePdfMatch(index, start, start + 'quick brown'.length)).toEqual({ startItem: 0, startOffset: 4, endItem: 1, endOffset: 6 })
  })

  test('Given 命中结尾落在补的行尾空格上 When 映射 Then 终点收到条目末尾，不越界', () => {
    const start = index.text.indexOf('brown ')
    expect(locatePdfMatch(index, start, start + 'brown '.length)).toEqual({ startItem: 1, startOffset: 1, endItem: 1, endOffset: 6 })
  })

  test('Given 空索引或空区间 When 映射 Then 返回 null', () => {
    expect(locatePdfMatch({ text: '', starts: [], lengths: [] }, 0, 1)).toBeNull()
    expect(locatePdfMatch(index, 3, 3)).toBeNull()
  })
})

describe('PDF 查找与应用内查找栏同语义', () => {
  const text = 'Cat cat CATALOG concat 猫 a.b axb'
  const cases: Array<[string, PdfPreviewFindOptions]> = [
    ['cat', PLAIN],
    ['cat', { caseSensitive: true, wholeWord: false, regex: false }],
    ['cat', { caseSensitive: false, wholeWord: true, regex: false }],
    ['a.b', PLAIN],
    ['a.b', { caseSensitive: false, wholeWord: false, regex: true }],
    ['猫', PLAIN],
    ['(', { caseSensitive: false, wholeWord: false, regex: true }],
    ['x*', { caseSensitive: false, wholeWord: false, regex: true }],
  ]
  for (const [query, options] of cases) {
    test(`Given「${query}」${JSON.stringify(options)} When 两边各自搜 Then 结果一致`, () => {
      const pdfMatcher = buildPdfFindMatcher(query, options)
      const appMatcher = buildPreviewFindMatcher(query, options)
      expect(pdfMatcher === null).toBe(appMatcher === null)
      if (!pdfMatcher || !appMatcher) return
      expect(findPdfMatches(text, pdfMatcher, 100)).toEqual(findPreviewMatches(text, appMatcher, 100))
    })
  }

  test('Given 命中很多 When 带上限搜 Then 截在上限', () => {
    expect(findPdfMatches('a'.repeat(50), buildPdfFindMatcher('a', PLAIN)!, 7)).toHaveLength(7)
  })
})

describe('PDF 查看器 HTML', () => {
  const config = {
    fileUrl: 'canopy-file://x/a.pdf',
    pdfScriptUrl: 'canopy-file://x/pdf.min.mjs',
    pdfWorkerUrl: 'canopy-file://x/pdf.worker.min.mjs',
    standardFontDataUrl: 'canopy-file://x/standard_fonts/',
    cMapUrl: 'canopy-file://x/cmaps/',
  }
  const html = buildPdfPreviewHtml(config)

  test('Given 生成的页面 When 检查 Then 带 charset、文字层样式、查找高亮样式与 CMap 配置', () => {
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('.textLayer')
    expect(html).toContain('::highlight(canopy-find)')
    expect(html).toContain('canopy-file://x/cmaps/')
  })

  test('Given 注入的脚本 When 检查 Then 中间不出现能截断脚本的 </script，只有末尾一个', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })

  test('Given 注入的纯函数 When 脱离模块单独执行 Then 自包含可用（不依赖任何 import）', () => {
    const scriptBody = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.indexOf('const viewerMain ='))
    const run = new Function(`${scriptBody}; const index = buildPdfPageTextIndex([{ str: 'ab' }, { str: 'cd', hasEOL: true }]);
      return { index, location: locatePdfMatch(index, 1, 3), hits: findPdfMatches(index.text, buildPdfFindMatcher('BC', { caseSensitive: false, wholeWord: false, regex: false }), 5) }`)
    expect(run()).toEqual({
      index: { text: 'abcd ', starts: [0, 2], lengths: [2, 2] },
      location: { startItem: 0, startOffset: 1, endItem: 1, endOffset: 1 },
      hits: [{ start: 1, end: 3 }],
    })
  })
})
