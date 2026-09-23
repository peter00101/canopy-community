import { describe, expect, it } from 'bun:test'
import { RAIL_HUE_PALETTE, assignRailHues, hashRailId, pickRailHue, withRailHues } from './rail-session-glyph'

/** 找一个与 base 哈希同色的 id（用来构造撞色场景） */
function findCollidingId(base: string, prefix: string): string {
  for (let i = 0; i < 10000; i++) {
    const candidate = `${prefix}-${i}`
    if (candidate !== base && pickRailHue(candidate) === pickRailHue(base)) return candidate
  }
  throw new Error('找不到撞色 id')
}

describe('pickRailHue — 会话 id 到色相', () => {
  it('Given 同一个会话 id，When 多次取色，Then 颜色稳定不变', () => {
    const id = '64e9cdac-6f4e-49ac-9531-ff3139cc8eda'
    expect(pickRailHue(id)).toBe(pickRailHue(id))
    expect(hashRailId(id)).toBe(hashRailId(id))
  })

  it('Given 任意 id，When 取色，Then 落在 8 色调色板内', () => {
    for (const id of ['a', 'ceshi', 'nihao', '', '哦吗', 'x'.repeat(200)]) {
      expect(RAIL_HUE_PALETTE).toContain(pickRailHue(id))
    }
  })

  it('Given 200 个不同的 uuid 样式 id，When 逐个取色，Then 8 种颜色都会被用到（哈希够散）', () => {
    const hues = new Set<number>()
    for (let i = 0; i < 200; i++) hues.add(pickRailHue(`session-${i}-${(i * 2654435761) >>> 0}`))
    expect(hues.size).toBe(RAIL_HUE_PALETTE.length)
  })
})

describe('assignRailHues — 可见集合内去重，且与显示顺序无关', () => {
  it('Given 两个哈希撞色的会话，When 分配，Then 创建更早的保住哈希色、更晚的顺延到下一个空色', () => {
    const older = 'session-older'
    const newer = findCollidingId(older, 'session-newer')
    const [hueOlder, hueNewer] = assignRailHues([
      { id: older, createdAt: 1000 },
      { id: newer, createdAt: 2000 },
    ])
    expect(hueOlder).toBe(pickRailHue(older))
    expect(hueNewer).not.toBe(hueOlder)
    const expectedNext = RAIL_HUE_PALETTE[(RAIL_HUE_PALETTE.indexOf(hueOlder!) + 1) % RAIL_HUE_PALETTE.length]
    expect(hueNewer).toBe(expectedNext)
  })

  it('Given 同一组会话只是显示顺序变了（当前会话被排到最前），When 重新分配，Then 每个会话的颜色纹丝不动', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ id: `s-${i}`, createdAt: 1000 + i }))
    const before = new Map(assignRailHues(entries).map((hue, i) => [entries[i]!.id, hue]))
    const reordered = [entries[5]!, entries[7]!, ...entries.slice(0, 5), entries[6]!]
    const after = assignRailHues(reordered)
    reordered.forEach((entry, i) => expect(after[i]).toBe(before.get(entry.id)!))
  })

  it('Given 新会话进入可见集合，When 重新分配，Then 老会话的颜色不被顶掉、新会话拿一个空色', () => {
    const olds = Array.from({ length: 5 }, (_, i) => ({ id: `old-${i}`, createdAt: 1000 + i }))
    const before = new Map(assignRailHues(olds).map((hue, i) => [olds[i]!.id, hue]))
    const newcomer = { id: findCollidingId('old-0', 'new'), createdAt: 9000 }
    const after = assignRailHues([newcomer, ...olds])
    olds.forEach((entry, i) => expect(after[i + 1]).toBe(before.get(entry.id)!))
    expect(new Set(after).size).toBe(6)
  })

  it('Given rail 上限 8 个会话，When 分配，Then 8 个颜色互不相同', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, createdAt: i }))
    const hues = assignRailHues(entries)
    expect(new Set(hues).size).toBe(8)
    for (const hue of hues) expect(RAIL_HUE_PALETTE).toContain(hue)
  })

  it('Given 缺 createdAt 的条目，When 分配，Then 按 id 排序兜底、结果仍与输入顺序无关', () => {
    const a = assignRailHues([{ id: 'b' }, { id: 'a' }])
    const b = assignRailHues([{ id: 'a' }, { id: 'b' }])
    expect(a[0]).toBe(b[1])
    expect(a[1]).toBe(b[0])
  })

  it('Given 空列表，When 分配，Then 返回空数组', () => {
    expect(assignRailHues([])).toEqual([])
  })

  it('Given 可见项多于调色板（9 个），When 分配，Then 不抛错、前 8 个（按创建序）互不相同', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ id: `many-${i}`, createdAt: i }))
    const hues = assignRailHues(entries)
    expect(hues).toHaveLength(9)
    expect(new Set(hues.slice(0, 8)).size).toBe(8)
    expect(hues[8]).toBe(pickRailHue(entries[8]!.id))
  })
})

describe('withRailHues — 挂到列表项', () => {
  it('Given 带 id 的列表项，When 挂色相，Then 原字段与顺序保留、每项多一个 hue', () => {
    const items = [{ id: 'a', title: 'A', createdAt: 2 }, { id: 'b', title: 'B', createdAt: 1 }]
    const result = withRailHues(items)
    expect(result.map((item) => item.title)).toEqual(['A', 'B'])
    expect(result.map((item) => item.hue)).toEqual(assignRailHues(items))
  })
})
