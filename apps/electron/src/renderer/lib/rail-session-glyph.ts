/**
 * 折叠侧栏（rail）会话图标的着色规则。
 *
 * 维护者的用户反馈：rail 上按会话名首字显示（"ceshi" → "C"）不好看。改成固定图标
 * （Agent 用 AgentMascotIcon、Chat 用 MessageSquare），靠**色块**区分会话：
 * - 色相由会话 id 稳定哈希到 8 色调色板，同一会话每次打开颜色一致；
 * - rail 最多同时显示 8 个会话，`assignRailHues` 在可见集合内去重，保证一眼能分开；
 * - 去重按**创建时间**这个稳定顺序进行（老会话先拿色），与显示顺序无关——
 *   否则「当前会话排第一」的排序一变，颜色就跟着漂（维护者 2026-08-30 实测点一下变一下）。
 *   新会话进入可见集合时只给自己取一个空色，不会把老会话的颜色顶掉。
 */

/** 8 个间隔均匀、饱和度适中的色相（度）：珊瑚 / 琥珀 / 青柠 / 翡翠 / 天蓝 / 靛蓝 / 紫罗兰 / 玫红 */
export const RAIL_HUE_PALETTE: readonly number[] = [15, 40, 95, 150, 200, 235, 275, 330]

/** FNV-1a 32 位，够稳定、够散、零依赖 */
export function hashRailId(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 单个会话的首选色相（未去重） */
export function pickRailHue(id: string): number {
  return RAIL_HUE_PALETTE[hashRailId(id) % RAIL_HUE_PALETTE.length]!
}

export interface RailHueEntry {
  id: string
  /** 会话创建时间戳；缺省时退化为按 id 排序，仍然稳定 */
  createdAt?: number
}

/**
 * 给一组可见会话分配互不相同的色相（数量 ≤ 调色板大小时严格不重复；超出后允许循环复用）。
 * 返回顺序 = 输入顺序；分配顺序 = createdAt 升序（再按 id），与输入顺序无关。
 */
export function assignRailHues(entries: readonly RailHueEntry[]): number[] {
  const stableOrder = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const timeDelta = (a.entry.createdAt ?? 0) - (b.entry.createdAt ?? 0)
      if (timeDelta !== 0) return timeDelta
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
    })

  const used = new Set<number>()
  const hues = new Array<number>(entries.length)
  for (const { entry, index } of stableOrder) {
    const start = RAIL_HUE_PALETTE.indexOf(pickRailHue(entry.id))
    let assigned: number | null = null
    for (let offset = 0; offset < RAIL_HUE_PALETTE.length; offset++) {
      const hue = RAIL_HUE_PALETTE[(start + offset) % RAIL_HUE_PALETTE.length]!
      if (!used.has(hue)) {
        assigned = hue
        break
      }
    }
    if (assigned === null) {
      // 可见项多于调色板：从头循环复用
      used.clear()
      assigned = RAIL_HUE_PALETTE[start]!
    }
    used.add(assigned)
    hues[index] = assigned
  }
  return hues
}

/** 把去重后的色相挂到列表项上（保持原顺序） */
export function withRailHues<T extends RailHueEntry>(items: readonly T[]): Array<T & { hue: number }> {
  const hues = assignRailHues(items)
  return items.map((item, index) => ({ ...item, hue: hues[index]! }))
}
