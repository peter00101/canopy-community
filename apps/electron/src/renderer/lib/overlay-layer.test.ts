import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { menuSurfaceClassName } from '../components/ui/menu-styles'

/**
 * 层级回归护栏。
 *
 * 维护者报障：折叠侧栏的「更多工作区工具」（⋯）点了没反应还会卡。
 * 真因是 dropdown-menu / context-menu 的 Portal 内容停在 z-50，
 * 而 AppShell 的主内容区是 `relative z-[60]`——两者同在 body 的根层叠上下文里，
 * 菜单被内容区整块盖住：DOM 里已展开、屏幕上却什么都没有；
 * 同时 Radix 给 body 挂了 pointer-events:none，整个界面像卡死。
 *
 * 这里锁住「菜单层必须高于 AppShell 层」，避免以后有人把 z 调回去，
 * 也避免继续用各调用点手写 z-[9999] 的方式打补丁。
 *
 * 注意：菜单基础样式已收拢到 components/ui/menu-styles.ts（上游 39181e1d 统一了
 * 右键菜单与下拉菜单的样式），z 值现在只此一处。上游那份写的是 z-50，我方必须保持
 * z-[9999]——所以下面额外钉一条 menuSurfaceClassName 的断言。
 */

const RENDERER = join(import.meta.dir, '..')

function readSource(relativePath: string): string {
  return readFileSync(join(RENDERER, relativePath), 'utf-8')
}

/** 取源码里 `"z-[N] ...` / `"z-N ...` 这类基础样式串首个 z 值。 */
function baseZIndexes(source: string): number[] {
  const values: number[] = []
  for (const match of source.matchAll(/"z-(?:\[(\d+)\]|(\d+))\s/g)) {
    values.push(Number(match[1] ?? match[2]))
  }
  return values
}

const APP_SHELL_LAYER = 60
const TOOLTIP_LAYER = 10050
const MENU_STYLES = 'components/ui/menu-styles.ts'

describe('弹层 z-index 层级', () => {
  test('Given AppShell 主区为 z-[60] When 读取 AppShell 源码 Then 该常量仍成立', () => {
    // 这条断言的作用：如果哪天 AppShell 抬高了层级，下面几条会跟着暴露出来
    expect(readSource('components/app-shell/AppShell.tsx')).toContain('relative z-[60]')
  })

  test('Given menu-styles.ts When 读取基础 z 值 Then 全部高于 AppShell 的 z-[60]', () => {
    const zs = baseZIndexes(readSource(MENU_STYLES))
    expect(zs.length).toBeGreaterThan(0)
    for (const z of zs) expect(z).toBeGreaterThan(APP_SHELL_LAYER)
  })

  test('Given menuSurfaceClassName When 检查 z 值 Then 固定为 z-[9999]（不得跟随上游回落到 z-50）', () => {
    expect(menuSurfaceClassName).toContain('z-[9999]')
    expect(menuSurfaceClassName).not.toContain('z-50')
  })

  test.each([
    ['components/ui/dropdown-menu.tsx'],
    ['components/ui/context-menu.tsx'],
  ])('Given %s When 仍有内联 z 值 Then 不得低于 AppShell 层', (file) => {
    // 这两个文件的 z 值已搬到 menu-styles.ts，正常应扫不出结果；
    // 留着是防止有人回头在组件里手写一个低 z 覆盖回去。
    for (const z of baseZIndexes(readSource(file))) {
      expect(z).toBeGreaterThan(APP_SHELL_LAYER)
    }
  })

  test('Given 菜单与 Tooltip When 比较层级 Then 菜单低于 Tooltip（提示始终压在菜单之上）', () => {
    const menuZs = baseZIndexes(readSource(MENU_STYLES))
    expect(menuZs.length).toBeGreaterThan(0)
    expect(Math.max(...menuZs)).toBeLessThan(TOOLTIP_LAYER)
    expect(readSource('components/ui/tooltip.tsx')).toContain(`z-[${TOOLTIP_LAYER}]`)
  })

  test('Given 调用点自定义 z When 扫描 DropdownMenuContent/ContextMenuContent Then 不得低于 AppShell 层', () => {
    const files = [
      'components/chat/SystemPromptSelector.tsx',
      'components/agent/AgentHeader.tsx',
      'components/planning/PlanningGroupManager.tsx',
    ]
    for (const file of files) {
      const source = readSource(file)
      for (const match of source.matchAll(/<(?:DropdownMenu|ContextMenu)(?:Sub)?Content[^>]*className="([^"]*)"/g)) {
        for (const z of (match[1] ?? '').matchAll(/\bz-(?:\[(\d+)\]|(\d+))\b/g)) {
          expect(Number(z[1] ?? z[2])).toBeGreaterThan(APP_SHELL_LAYER)
        }
      }
    }
  })
})
