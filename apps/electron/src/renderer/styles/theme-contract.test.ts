/**
 * 主题契约与对比度测试。
 *
 * 治的是一类反复出现的真实缺陷：新增主题时漏定义某个 token，CSS 静默回落到基准值，
 * 编译和单测都不报错，只能靠肉眼在特定界面上撞见。0.18.23 就漏过 latte/lavender/ink
 * 三个主题的 shell-bg，拿铁的外框因此回落成近纯白。
 *
 * 两条规矩：
 * 1. 每个注册在 THEME_STYLES 里的主题都要有 CSS 块、完整 token、shell-bg；
 * 2. 正文 / 次要文字 / 主色对内容区的对比度达到 WCAG AA。
 *
 * 既有主题的历史缺口以 KNOWN_GAPS 显式登记（带实测值），新主题一律不许进这张表——
 * 这样债务只减不增，也不会为了让测试变绿去改维护者已经熟悉的主题观感。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_STYLES } from '../../types'

const CSS_PATH = join(import.meta.dir, 'globals.css')
const css = readFileSync(CSS_PATH, 'utf8')

/** 主题声明块：缩进两格的 `.theme-xxx { ... }`，排除 `.theme-x .child` 这类逐规则覆写 */
function parseThemeBlocks(source: string): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>()
  // 同一主题可以有多个 `  .theme-x {` 块（主块 + 配色体系块，0.18.82 起），token 合并、后写的覆盖
  for (const [, name, body] of source.matchAll(/^ {2}\.theme-([a-z-]+)\s*\{([^}]*)\}/gm)) {
    if (!name) continue
    const tokens: Record<string, string> = result.get(name) ?? {}
    for (const [, key, value] of (body ?? '').matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)) {
      if (key && value) tokens[key] = value.replace(/\/\*.*?\*\//g, '').trim()
    }
    result.set(name, tokens)
  }
  return result
}

const themes = parseThemeBlocks(css)

/** 注册在白名单里的真实主题（'default' 是「不使用特殊风格」的语义值，没有 CSS 块） */
const registeredThemes = THEME_STYLES.filter((style) => style !== 'default')

/**
 * 每个主题都必须定义的 token。
 * `radius` 不在其中——它只有 terminal-dark 用来做 CRT 直角，属主题专属而非公共契约。
 */
const REQUIRED_TOKENS = [
  'background', 'foreground', 'content-area',
  'muted', 'muted-foreground', 'border',
  'primary', 'primary-foreground',
  'secondary', 'secondary-foreground',
  'accent', 'accent-foreground',
  'ring', 'card', 'card-foreground',
  'input', 'popover', 'popover-foreground',
  'dialog', 'dialog-foreground',
  'sidebar-surface', 'tabbar-surface', 'tab-indicator',
  'sidebar-control-surface', 'sidebar-control-surface-hover', 'sidebar-control-stroke',
  // 上游 0.19.52 起侧栏主文字改走这个 token；只定义在 :root/.dark 的话，
  // 12 套主题的侧栏文字会被统一洗成中性灰，各自的色相全丢。
  'sidebar-primary-foreground',
  'input-surface', 'tab-surface',
  'destructive', 'destructive-foreground', 'stop-hover-bg',
  'tooltip', 'tooltip-foreground', 'tooltip-muted',
  'code-bg', 'dashed-border', 'dashed-border-hover',
  // 配色体系（2026-09-10 维护者定，12 套全部配齐）：色族六色 / 第二色相 / 四状态色 / 文字与线三档 / 两层顶栏 / 会话色块调性
  'palette-1', 'palette-2', 'palette-3', 'palette-4', 'palette-5', 'palette-6',
  'accent-2', 'accent-2-foreground', 'accent-2-soft', 'accent-2-soft-foreground',
  'success', 'success-foreground', 'success-soft',
  'warning', 'warning-foreground', 'warning-soft',
  'danger', 'danger-foreground', 'danger-soft',
  'info', 'info-foreground', 'info-soft',
  'fg-2', 'fg-3', 'line-1', 'line-2', 'line-3', 'band-1', 'band-2',
  'rail-glyph-bg-sat', 'rail-glyph-bg-light', 'rail-glyph-fg-sat', 'rail-glyph-fg-light', 'rail-glyph-active-sat', 'rail-glyph-active-light',
] as const

/**
 * 历史缺口登记表。**新增主题不得写进这里**——要么达标，要么别合。
 * 每条都带实测值，将来要还债时按图索骥。
 */
const KNOWN_GAPS = {
  /** 这几个暗色主题没定义 tab-surface，回落到 .dark 的中性 `0 0% 7%`。
   *  与各自带色相的内容区不完全衔接，但差异极小、维护者已看惯，不擅自改。 */
  missingTokens: {
    'ocean-dark': ['tab-surface'],
    'forest-dark': ['tab-surface'],
    'slate-dark': ['tab-surface'],
    'terminal-dark': ['tab-surface'],
    'ink-dark': ['tab-surface'],
  } as Record<string, string[]>,
  /** 对比度不达标的既有主题（2026-09-09 实测值）。 */
  contrast: {
    // 云絮柔灰：次要文字 4.05（差 0.45）、主色 2.07（陶土色在浅底上，差 0.93）
    'slate-light': ['muted-foreground', 'primary'],
    // 荧屏余晖：次要文字 3.45——CRT 拟真主题，压暗是刻意的视觉设定
    'terminal-dark': ['muted-foreground'],
  } as Record<string, string[]>,
}

// ===== 对比度计算（WCAG 2.1 相对亮度）=====

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100
  const lum = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(lum, 1 - lum)
  const f = (n: number) => lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const lumA = relativeLuminance(a)
  const lumB = relativeLuminance(b)
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 解析 `165 14% 92%` 形态的 token 值；带 alpha 或函数写法的返回 null（不参与对比度断言） */
function parseHslToken(value: string | undefined): [number, number, number] | null {
  if (!value) return null
  const matched = value.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/)
  if (!matched) return null
  return hslToRgb(parseFloat(matched[1]!), parseFloat(matched[2]!), parseFloat(matched[3]!))
}

describe('主题契约：注册表与 CSS 定义一一对应', () => {
  test('Given THEME_STYLES 白名单 When 查 CSS Then 每个主题都有声明块', () => {
    const missing = registeredThemes.filter((style) => !themes.has(style))
    expect(missing).toEqual([])
  })

  test('Given CSS 里的主题块 When 对照白名单 Then 没有未注册的孤儿主题', () => {
    const orphans = [...themes.keys()].filter((name) => !registeredThemes.includes(name as never))
    expect(orphans).toEqual([])
  })

  test('Given 每个主题 When 检查外框背景 Then 都定义了 shell-bg（0.18.23 漏过这一处）', () => {
    const missing = [...themes.keys()].filter(
      (name) => !new RegExp(`\\.theme-${name}\\s+\\.shell-bg`).test(css),
    )
    expect(missing).toEqual([])
  })

  test('Given 每个主题 When 检查 Tailwind safelist Then 都在名单里（不在就会被整块裁掉）', () => {
    // 主题 class 是运行时 `theme-${style}` 拼出来的，Tailwind 扫不到源码里的字面量，
    // 不 safelist 就会把 @layer base 里对应的变量块当死代码摇掉——CSS 文件里写了、
    // 构建产物里没有，且只在切到该主题时才看得出来。0.18.69 新增云杉双主题时踩过一次。
    const config = readFileSync(join(import.meta.dir, '../../../tailwind.config.js'), 'utf8')
    const missing = [...themes.keys()].filter((name) => !config.includes(`'theme-${name}'`))
    expect(missing).toEqual([])
  })
})

describe('主题契约：token 完整性', () => {
  for (const [name, tokens] of themes) {
    const exempt = KNOWN_GAPS.missingTokens[name] ?? []
    test(`Given 主题 ${name} When 检查必需 token Then 除已登记缺口外一个不少`, () => {
      const missing = REQUIRED_TOKENS.filter((key) => !(key in tokens) && !exempt.includes(key))
      expect(missing).toEqual([])
    })
  }

  test('Given 历史缺口登记表 When 核对 Then 登记的缺口确实还在（修好了就该从表里删掉）', () => {
    for (const [name, keys] of Object.entries(KNOWN_GAPS.missingTokens)) {
      const tokens = themes.get(name)
      expect(tokens, `主题 ${name} 已不存在，请同步清理 KNOWN_GAPS`).toBeDefined()
      for (const key of keys) {
        expect(tokens![key], `${name} 的 ${key} 已补上，请从 KNOWN_GAPS 移除`).toBeUndefined()
      }
    }
  })
})

describe('主题对比度：正文与主色在内容区上的可读性（WCAG AA）', () => {
  for (const [name, tokens] of themes) {
    const area = parseHslToken(tokens['content-area'])
    const exempt = KNOWN_GAPS.contrast[name] ?? []

    test(`Given 主题 ${name} When 量正文对内容区 Then 不低于 4.5:1`, () => {
      const fg = parseHslToken(tokens['foreground'])
      expect(area).not.toBeNull()
      expect(fg).not.toBeNull()
      expect(contrastRatio(fg!, area!)).toBeGreaterThanOrEqual(4.5)
    })

    test(`Given 主题 ${name} When 量次要文字对内容区 Then 不低于 4.5:1`, () => {
      if (exempt.includes('muted-foreground')) return
      const muted = parseHslToken(tokens['muted-foreground'])
      expect(muted).not.toBeNull()
      expect(contrastRatio(muted!, area!)).toBeGreaterThanOrEqual(4.5)
    })

    test(`Given 主题 ${name} When 量主色对内容区 Then 不低于 3:1（UI 组件档）`, () => {
      if (exempt.includes('primary')) return
      const primary = parseHslToken(tokens['primary'])
      expect(primary).not.toBeNull()
      expect(contrastRatio(primary!, area!)).toBeGreaterThanOrEqual(3)
    })

    /**
     * 描边可辨识度。维护者 2026-09-09 报「浅色系很多地方看不清、全白的」，体检发现
     * 6 套浅色主题的描边对内容区只有 1.39~1.59——分隔线、卡片框、输入框边界全都
     * 形同虚设，问题不在文字而在「线」。本轮浅色统一提到 ~2.0、深色落队的三套拉到
     * ~1.8。这里钉死下限，防止以后调主题时又滑回去。
     * 门槛按明暗分档：深色 UI 的描边天然更含蓄，硬套浅色的 2.0 会显得框感过重。
     */
    test(`Given 主题 ${name} When 量描边对内容区 Then 达到可辨识下限`, () => {
      const border = parseHslToken(tokens['border'])
      if (border === null || area === null) return // 少数主题用函数写法定义，不参与
      const floor = name.endsWith('-dark') ? 1.7 : 1.9
      expect(contrastRatio(border, area)).toBeGreaterThanOrEqual(floor)
    })
  }

  test('Given 新增的云杉双主题 When 量三项对比度 Then 全部达标且不在豁免表里', () => {
    for (const name of ['spruce-light', 'spruce-dark']) {
      expect(KNOWN_GAPS.contrast[name]).toBeUndefined()
      expect(KNOWN_GAPS.missingTokens[name]).toBeUndefined()
      const tokens = themes.get(name)!
      const area = parseHslToken(tokens['content-area'])!
      expect(contrastRatio(parseHslToken(tokens['foreground'])!, area)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(parseHslToken(tokens['muted-foreground'])!, area)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(parseHslToken(tokens['primary'])!, area)).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('配色体系：每套主题自己的一组色在内容区上都站得住（WCAG）', () => {
  for (const [name, tokens] of themes) {
    const area = parseHslToken(tokens['content-area'])
    if (area === null) continue
    const need = (token: string, against: [number, number, number], floor: number) => {
      const color = parseHslToken(tokens[token])
      expect(color, `${name} 缺 --${token} 或写法不是 HSL 三元组`).not.toBeNull()
      expect(contrastRatio(color!, against), `${name} --${token} 对比度不足`).toBeGreaterThanOrEqual(floor)
    }
    test(`Given 主题 ${name} When 量次要 / 占位文字 Then fg-2 ≥ 4.5、fg-3 ≥ 3.0（实色，不再靠透明度）`, () => {
      need('fg-2', area, 4.5)
      need('fg-3', area, 3)
    })
    test(`Given 主题 ${name} When 量第二色相 Then accent-2 对内容区 ≥ 3.0，浅底上的字 ≥ 4.5`, () => {
      need('accent-2', area, 3)
      const soft = parseHslToken(tokens['accent-2-soft'])
      expect(soft).not.toBeNull()
      need('accent-2-soft-foreground', soft!, 4.5)
    })
    test(`Given 主题 ${name} When 量四个状态色 Then 对内容区各 ≥ 3.0`, () => {
      for (const token of ['success', 'warning', 'danger', 'info']) need(token, area, 3)
    })
    test(`Given 主题 ${name} When 量色族六色 Then 作为图标色对内容区各 ≥ 2.5`, () => {
      for (const token of ['palette-1', 'palette-2', 'palette-3', 'palette-4', 'palette-5', 'palette-6']) need(token, area, 2.5)
    })
    test(`Given 主题 ${name} When 量两层顶栏 Then band-2 与内容区、band-1 与 band-2 各拉开 ≥ 1.06（现代风格靠它分区）`, () => {
      const band1 = parseHslToken(tokens['band-1'])
      const band2 = parseHslToken(tokens['band-2'])
      expect(band1).not.toBeNull()
      expect(band2).not.toBeNull()
      expect(contrastRatio(band2!, area)).toBeGreaterThanOrEqual(1.06)
      expect(contrastRatio(band1!, band2!)).toBeGreaterThanOrEqual(1.06)
    })
    test(`Given 主题 ${name} When 量卡片与内容区 Then 拆开了（≥ 1.03，此前 6 套同色卡片浮不起来）`, () => {
      const card = parseHslToken(tokens['card'])
      expect(card).not.toBeNull()
      expect(contrastRatio(card!, area)).toBeGreaterThanOrEqual(1.03)
    })
  }
})
