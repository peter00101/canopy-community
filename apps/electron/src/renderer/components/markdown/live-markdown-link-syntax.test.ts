/**
 * 行内链接阅读态契约（2026-09-05 维护者截图对比 Obsidian）：
 * `[text](dest)` 在非活动行只保留链接文字，目标段（URL + 标题）整段隐藏；
 * 图片、尖括号自动链接、引用式链接各有自己的处理路径，这里必须不碰。
 * 语法树用与 ink-mde 相同的 GFM 基座解析，不依赖 DOM。
 */

import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { findMarkdownInlineLinks, isOpenableMarkdownLinkHref } from './live-markdown-link-syntax'

function parse(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function text(state: EditorState, from: number, to: number): string {
  return state.doc.sliceString(from, to)
}

describe('findMarkdownInlineLinks · 行内链接范围', () => {
  test('给定带标题的普通外链，当扫描时，则链接文字与「URL + 空白 + 标题」整段分别定位', () => {
    const state = parse('甲 [普通外链](https://example.com/a "标题") 乙')
    const [link] = findMarkdownInlineLinks(state)

    expect(link).toBeDefined()
    expect(text(state, link!.textFrom, link!.textTo)).toBe('普通外链')
    expect(text(state, link!.destinationFrom, link!.destinationTo)).toBe('https://example.com/a "标题"')
    expect(link!.href).toBe('https://example.com/a')
    expect(link!.line).toBe(1)
  })

  test('给定尖括号包裹的带空格路径（Obsidian 常见写法），当扫描时，则整段含尖括号被定位、href 去掉尖括号', () => {
    const state = parse('丙 [尖括号路径](<../目录 名/2026-09-04 文件.md>) 丁')
    const [link] = findMarkdownInlineLinks(state)

    expect(text(state, link!.destinationFrom, link!.destinationTo)).toBe('<../目录 名/2026-09-04 文件.md>')
    expect(link!.href).toBe('../目录 名/2026-09-04 文件.md')
  })

  test('给定百分号编码的相对路径与裸相对路径，当扫描时，则同样命中', () => {
    const state = parse('- 戊 [编码](<../%E7%9B%AE/2026%20x.md>) 己\n- 庚 [裸路径](../目录/文件.md) 辛')
    const links = findMarkdownInlineLinks(state)

    expect(links.map((link) => link.href)).toEqual(['../%E7%9B%AE/2026%20x.md', '../目录/文件.md'])
    expect(links.map((link) => link.line)).toEqual([1, 2])
  })

  test('给定同一行多个链接，当扫描时，则按出现顺序各自独立定位', () => {
    const state = parse('[一](https://a.example) 与 [二](https://b.example)')
    const links = findMarkdownInlineLinks(state)

    expect(links).toHaveLength(2)
    expect(links.map((link) => text(state, link.textFrom, link.textTo))).toEqual(['一', '二'])
    expect(links[0]!.destinationTo).toBeLessThan(links[1]!.textFrom)
  })

  test('给定图片、尖括号自动链接与引用式链接，当扫描时，则一个都不命中（各走各的渲染路径）', () => {
    const state = parse('![图](a.png) 戊 <https://x.example> 己 [引用][ref]\n\n[ref]: https://r.example')

    expect(findMarkdownInlineLinks(state)).toEqual([])
  })

  test('给定链接文字为空的 [](url)，当扫描时，则文字范围为空但目标段仍可隐藏', () => {
    const state = parse('[](https://empty.example)')
    const [link] = findMarkdownInlineLinks(state)

    expect(link!.textFrom).toBe(link!.textTo)
    expect(text(state, link!.destinationFrom, link!.destinationTo)).toBe('https://empty.example')
  })
})

describe('isOpenableMarkdownLinkHref · Ctrl/Cmd+点击放行范围', () => {
  test('只放行 http / https；相对路径、file、javascript 与空值一律不放行', () => {
    expect(isOpenableMarkdownLinkHref('https://example.com')).toBe(true)
    expect(isOpenableMarkdownLinkHref('HTTP://example.com')).toBe(true)
    expect(isOpenableMarkdownLinkHref('../目录/文件.md')).toBe(false)
    expect(isOpenableMarkdownLinkHref('file:///C:/x.md')).toBe(false)
    expect(isOpenableMarkdownLinkHref('javascript:alert(1)')).toBe(false)
    expect(isOpenableMarkdownLinkHref(undefined)).toBe(false)
  })
})
