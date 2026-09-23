import { describe, expect, test } from 'bun:test'
import { createStore, type Atom } from 'jotai'
import type { BrowserViewState } from '@canopy/shared'
import {
  browserFocusRequestMapAtom,
  browserPanelMinimizedMapAtom,
  browserPanelOpenMapAtom,
  browserPendingNavigationMapAtom,
  browserStateMapAtom,
  clearBrowserSessionStateAtom,
} from './browser-atoms'

function seed(store: ReturnType<typeof createStore>, sessionIds: string[]): void {
  const state = {} as BrowserViewState
  store.set(browserPanelOpenMapAtom, new Map(sessionIds.map((id) => [id, true])))
  store.set(browserPanelMinimizedMapAtom, new Map(sessionIds.map((id) => [id, false])))
  store.set(browserStateMapAtom, new Map(sessionIds.map((id) => [id, state])))
  store.set(browserFocusRequestMapAtom, new Map(sessionIds.map((id) => [id, `tab-${id}`])))
  store.set(browserPendingNavigationMapAtom, new Map(sessionIds.map((id) => [id, 'https://example.com'])))
}

const ALL_MAPS: ReadonlyArray<Atom<ReadonlyMap<string, unknown>>> = [
  browserPanelOpenMapAtom,
  browserPanelMinimizedMapAtom,
  browserStateMapAtom,
  browserFocusRequestMapAtom,
  browserPendingNavigationMapAtom,
]

describe('删除会话时清掉受管浏览器 UI 状态（收上游 #2078）', () => {
  test('Given 两个会话都开着浏览器 When 删除其中一个 Then 五张表里只移除它，另一个原样保留', () => {
    const store = createStore()
    seed(store, ['deleted', 'kept'])

    store.set(clearBrowserSessionStateAtom, 'deleted')

    for (const mapAtom of ALL_MAPS) {
      const map = store.get(mapAtom)
      expect(map.has('deleted')).toBe(false)
      expect(map.has('kept')).toBe(true)
    }
  })

  test('Given 会话从没开过浏览器 When 清理 Then 表对象引用不变，不触发无谓的重渲染', () => {
    const store = createStore()
    seed(store, ['kept'])
    const before = ALL_MAPS.map((mapAtom) => store.get(mapAtom))

    store.set(clearBrowserSessionStateAtom, 'never-opened')

    ALL_MAPS.forEach((mapAtom, index) => {
      expect(store.get(mapAtom)).toBe(before[index]!)
    })
  })
})
