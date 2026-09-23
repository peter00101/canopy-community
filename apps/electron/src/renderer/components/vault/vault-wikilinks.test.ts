/**
 * Obsidian 正文双链（上游 #2019 移植）：
 * `resolveVaultWikiLink` 把 `[[目标]]` 解析成 Vault 内相对路径——根路径精确命中 > 当前目录 > 唯一后缀；
 * `canRenderVaultWikiLink` 用 Markdown 语法树决定哪些 `[[...]]` 该渲染成可点击链接。
 * 语法树用与 ink-mde 相同的 GFM 基座解析，不依赖 DOM。
 */

import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { canRenderVaultWikiLink, parseVaultWikiLink, resolveVaultWikiLink } from './vault-wikilinks'

function parse(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function canRender(doc: string): boolean {
  const from = doc.indexOf('[[')
  if (from < 0) throw new Error(`测试文档里没有 [[：${doc}`)
  return canRenderVaultWikiLink(parse(doc), from)
}

describe('resolveVaultWikiLink · 双链目标解析', () => {
  const files = ['会议记录.md', '项目/会议记录.md', '项目/日程.md', '项目/子任务/日程.md', '归档/2025/总结.md', '甲/重名.md', '乙/重名.md', '附件/图.png']

  test('给定根目录与当前目录各有一篇同名笔记，当从当前目录解析裸名称时，则根路径精确命中优先', () => {
    expect(resolveVaultWikiLink('会议记录', '项目/日程.md', files)).toBe('会议记录.md')
  })

  test('给定目标只存在于当前目录，当解析裸名称时，则按当前目录相对路径命中', () => {
    expect(resolveVaultWikiLink('日程', '项目/会议记录.md', files)).toBe('项目/日程.md')
  })

  test('给定目标在更深的目录且全库唯一，当解析裸名称时，则按唯一后缀命中', () => {
    expect(resolveVaultWikiLink('总结', '会议记录.md', files)).toBe('归档/2025/总结.md')
  })

  test('给定带子目录的部分路径，当全库只有一处以此结尾时，则同样按后缀命中', () => {
    expect(resolveVaultWikiLink('2025/总结', '项目/日程.md', files)).toBe('归档/2025/总结.md')
  })

  test('给定多篇同名笔记且都不在根目录与当前目录，当解析裸名称时，则歧义返回 null 而不是随便挑一篇', () => {
    expect(resolveVaultWikiLink('重名', '会议记录.md', files)).toBeNull()
  })

  test('给定显式 ./ 或 ../ 前缀，当解析时，则只按相对路径找、跳过根路径精确命中', () => {
    expect(resolveVaultWikiLink('./会议记录', '项目/日程.md', files)).toBe('项目/会议记录.md')
    expect(resolveVaultWikiLink('../会议记录', '项目/子任务/日程.md', files)).toBe('项目/会议记录.md')
    expect(resolveVaultWikiLink('../日程', '项目/日程.md', files)).toBeNull()
  })

  test('给定 .. 越过 Vault 根目录，当解析时，则返回 null（绝不指向 Vault 之外）', () => {
    expect(resolveVaultWikiLink('../会议记录', '会议记录.md', files)).toBeNull()
    expect(resolveVaultWikiLink('../../总结', '项目/日程.md', files)).toBeNull()
  })

  test('给定目标含 # 标题锚点、^ 块引用或 : 冒号，当解析时，则返回 null（暂不支持定位到笔记内部）', () => {
    expect(resolveVaultWikiLink('会议记录#议题', '项目/日程.md', files)).toBeNull()
    expect(resolveVaultWikiLink('会议记录^abc123', '项目/日程.md', files)).toBeNull()
    expect(resolveVaultWikiLink('C:/外部', '项目/日程.md', files)).toBeNull()
  })

  test('给定目标带 .md 后缀或首尾空白，当解析时，则去后缀、去空白后照常命中', () => {
    expect(resolveVaultWikiLink('会议记录.md', '项目/日程.md', files)).toBe('会议记录.md')
    expect(resolveVaultWikiLink('  日程.MD ', '项目/会议记录.md', files)).toBe('项目/日程.md')
  })

  test('给定空目标或只匹配非 .md 文件，当解析时，则返回 null', () => {
    expect(resolveVaultWikiLink('', '会议记录.md', files)).toBeNull()
    expect(resolveVaultWikiLink('   ', '会议记录.md', files)).toBeNull()
    expect(resolveVaultWikiLink('图', '会议记录.md', files)).toBeNull()
  })

  test('给定当前笔记在根目录，当解析根目录下的笔记时，则精确命中', () => {
    expect(resolveVaultWikiLink('会议记录', '总览.md', files)).toBe('会议记录.md')
  })
})

describe('parseVaultWikiLink · 目标与显示名拆分', () => {
  test('给定 [[笔记|显示名]]，当拆分时，则目标取竖线前、显示名取竖线后', () => {
    expect(parseVaultWikiLink('[[项目/会议记录|上周会议]]')).toEqual({ target: '项目/会议记录', label: '上周会议' })
  })

  test('给定不带显示名的 [[笔记]]，当拆分时，则显示名回落为目标本身', () => {
    expect(parseVaultWikiLink('[[会议记录]]')).toEqual({ target: '会议记录', label: '会议记录' })
  })

  test('给定目标或显示名带空白，当拆分时，则两侧空白被裁掉；显示名裁空后回落为目标', () => {
    expect(parseVaultWikiLink('[[ 会议记录 | 显示 ]]')).toEqual({ target: '会议记录', label: '显示' })
    expect(parseVaultWikiLink('[[会议记录|  ]]')).toEqual({ target: '会议记录', label: '会议记录' })
  })

  test('给定空目标或不是完整双链的文本，当拆分时，则返回 null', () => {
    expect(parseVaultWikiLink('[[  ]]')).toBeNull()
    expect(parseVaultWikiLink('[[a]] 尾巴')).toBeNull()
    expect(parseVaultWikiLink('[单括号]')).toBeNull()
  })
})

describe('canRenderVaultWikiLink · 哪些 [[...]] 渲染成链接', () => {
  test('给定普通段落与列表项里的双链，当判定时，则可渲染', () => {
    expect(canRender('今天讨论了 [[会议记录]] 的安排')).toBe(true)
    expect(canRender('- 待办：[[项目/日程|日程]]')).toBe(true)
  })

  test('给定行内代码、围栏代码块里的双链，当判定时，则不渲染（保持源码）', () => {
    expect(canRender('写法示例 `[[会议记录]]` 不要跳')).toBe(false)
    expect(canRender('```md\n[[会议记录]]\n```')).toBe(false)
  })

  test('给定 ![[嵌入]] 与反斜杠转义 \\[[x]]，当判定时，则不渲染；双反斜杠只转义了反斜杠本身，仍渲染', () => {
    expect(canRender('嵌入 ![[图.png]]')).toBe(false)
    expect(canRender('转义 \\[[会议记录]]')).toBe(false)
    expect(canRender('反斜杠本身 \\\\[[会议记录]]')).toBe(true)
  })

  test('给定双链出现在普通链接的 URL 或 HTML 标签内，当判定时，则不渲染', () => {
    // 注：`[看 [[x]]](url)` 这种把双链嵌进链接文字的写法，lezer 只把最内层 `[x]` 认作引用式链接，
    // 外层不成 Link，上游同样会渲染成双链；属解析器口径，这里不额外断言。
    expect(canRender('[文字](https://example.com/[[会议记录]])')).toBe(false)
    expect(canRender('<span title="[[会议记录]]">x</span>')).toBe(false)
  })

  test('给定封闭的 YAML Properties 区间，当双链在区间内时不渲染、区间后照常渲染', () => {
    expect(canRender('---\nrelated: [[会议记录]]\n---\n正文')).toBe(false)
    expect(canRender('---\ntitle: x\n---\n正文 [[会议记录]]')).toBe(true)
  })

  test('给定首行 --- 但没有闭合，当判定时，则按普通 Markdown 处理、双链可渲染', () => {
    expect(canRender('---\n正文 [[会议记录]]')).toBe(true)
  })
})
