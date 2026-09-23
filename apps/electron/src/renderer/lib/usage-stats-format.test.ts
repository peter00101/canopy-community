import { describe, expect, test } from 'bun:test'
import {
  buildUsageBreakdownItems,
  CACHE_HIT_RATIO_HINT,
  cacheHitRatio,
  EMPTY_VALUE,
  formatCompactCount,
  formatExactCount,
  formatRatio,
} from './usage-stats-format'

describe('formatCompactCount：用量数字的紧凑写法', () => {
  test('给定 0 当格式化 则输出「0」', () => {
    expect(formatCompactCount(0)).toBe('0')
  })

  test('给定 999 与 12,345 当格式化 则 10 万以下给千分位原数', () => {
    expect(formatCompactCount(999)).toBe('999')
    expect(formatCompactCount(12_345)).toBe('12,345')
    expect(formatCompactCount(99_999)).toBe('99,999')
  })

  test('给定 10 万到百万之间的数 当格式化 则用 K 保留 1 位', () => {
    expect(formatCompactCount(100_000)).toBe('100.0 K')
    expect(formatCompactCount(525_628)).toBe('525.6 K')
  })

  test('给定 1.2 亿 当格式化 则用 M 保留 2 位', () => {
    expect(formatCompactCount(120_000_000)).toBe('120.00 M')
    expect(formatCompactCount(1_927_040)).toBe('1.93 M')
  })

  test('给定十亿级与万亿级 当格式化 则依次进到 B 与 T', () => {
    expect(formatCompactCount(3_456_000_000)).toBe('3.46 B')
    expect(formatCompactCount(7_800_000_000_000)).toBe('7.80 T')
  })

  test('给定四舍五入后会到 1000 的边界值 当格式化 则进到下一档，而不是输出更长的「1000.0 K」', () => {
    expect(formatCompactCount(999_960)).toBe('1.00 M')
    expect(formatCompactCount(999_996_000)).toBe('1.00 B')
    expect(formatCompactCount(999_999_999_999)).toBe('1.00 T')
  })

  test('给定超大数 9e15 当格式化 则改用科学计数法，长度仍有上限', () => {
    expect(formatCompactCount(9e15)).toBe('9.00e+15')
    expect(formatCompactCount(Number.MAX_VALUE)).toBe('1.80e+308')
    // T 档四舍五入到 1000 时同样转科学计数法，不出「1000.00 T」
    expect(formatCompactCount(999_999_999_999_999)).toBe('1.00e+15')
  })

  test('给定任意合法输入 当格式化 则结果不超过 9 个字符，定宽列放得下', () => {
    const samples = [0, 7, 999, 12_345, 99_999, 100_000, 999_949, 999_960, 123_456_789, 9.99e11, 9.99e14, 9e15, 1e100, Number.MAX_VALUE]
    for (const value of samples) expect(formatCompactCount(value).length).toBeLessThanOrEqual(9)
  })

  test('给定小数 当格式化 则先四舍五入成整数', () => {
    expect(formatCompactCount(12.6)).toBe('13')
  })

  test('给定负数、NaN、Infinity 或非数字 当格式化 则输出「—」', () => {
    expect(formatCompactCount(-1)).toBe(EMPTY_VALUE)
    expect(formatCompactCount(Number.NaN)).toBe(EMPTY_VALUE)
    expect(formatCompactCount(Number.POSITIVE_INFINITY)).toBe(EMPTY_VALUE)
    expect(formatCompactCount(Number.NEGATIVE_INFINITY)).toBe(EMPTY_VALUE)
    expect(formatCompactCount(undefined)).toBe(EMPTY_VALUE)
    expect(formatCompactCount('12345')).toBe(EMPTY_VALUE)
  })
})

describe('formatExactCount：悬停提示里的精确值', () => {
  test('给定大数 当格式化 则给出完整千分位而不压缩', () => {
    expect(formatExactCount(0)).toBe('0')
    expect(formatExactCount(1_927_040)).toBe('1,927,040')
    expect(formatExactCount(9e15)).toBe('9,000,000,000,000,000')
  })

  test('给定负数或 NaN 当格式化 则输出「—」', () => {
    expect(formatExactCount(-5)).toBe(EMPTY_VALUE)
    expect(formatExactCount(Number.NaN)).toBe(EMPTY_VALUE)
  })
})

describe('cacheHitRatio：缓存命中率口径', () => {
  test('给定输入、缓存读取、缓存写入 当计算 则分母是三段之和', () => {
    // 100 非缓存输入 + 300 缓存读取 + 100 缓存写入 = 500 提示词，其中 300 命中
    expect(cacheHitRatio({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100 })).toBe(0.6)
  })

  test('给定本机实测的真实量级 当计算 则与手算一致', () => {
    const ratio = cacheHitRatio({ inputTokens: 528_432, cacheReadTokens: 1_762_688, cacheCreationTokens: 0 })
    expect(formatRatio(ratio)).toBe('76.9%')
  })

  test('给定三段全 0（只有输出或没有数据）当计算 则返回 null，不出现 NaN', () => {
    expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull()
  })

  test('给定全部命中缓存 当计算 则为 1', () => {
    expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 42, cacheCreationTokens: 0 })).toBe(1)
  })

  test('给定字段里混入负数或 NaN 当计算 则坏值按 0 处理', () => {
    expect(cacheHitRatio({ inputTokens: Number.NaN, cacheReadTokens: 50, cacheCreationTokens: -10 })).toBe(1)
    expect(cacheHitRatio({ inputTokens: -1, cacheReadTokens: Number.NaN, cacheCreationTokens: 0 })).toBeNull()
  })
})

describe('formatRatio：百分数写法', () => {
  test('给定 null 当格式化 则输出「—」', () => {
    expect(formatRatio(null)).toBe(EMPTY_VALUE)
    expect(formatRatio(undefined)).toBe(EMPTY_VALUE)
    expect(formatRatio(Number.NaN)).toBe(EMPTY_VALUE)
    expect(formatRatio(-0.2)).toBe(EMPTY_VALUE)
  })

  test('给定恰好 0 与 1 当格式化 则输出「0%」「100%」', () => {
    expect(formatRatio(0)).toBe('0%')
    expect(formatRatio(1)).toBe('100%')
  })

  test('给定常规比例 当格式化 则保留 1 位小数', () => {
    expect(formatRatio(0.6)).toBe('60.0%')
    expect(formatRatio(0.12345)).toBe('12.3%')
  })

  test('给定极接近 0 或 1 的比例 当格式化 则不被四舍五入成 0.0% 或 100.0%', () => {
    expect(formatRatio(0.0001)).toBe('<0.1%')
    expect(formatRatio(0.99999)).toBe('>99.9%')
  })
})

describe('buildUsageBreakdownItems：各行下方的明细', () => {
  // 四个字段取值互不相同，某项取错字段会立刻对不上
  const totals = { inputTokens: 1_500, outputTokens: 250_000, cacheReadTokens: 6_000, cacheCreationTokens: 2_500, calls: 9 }

  test('给定一行用量 当生成明细 则依次是输入、输出、缓存读取、缓存写入、缓存命中率，不含调用次数', () => {
    expect(buildUsageBreakdownItems(totals).map((item) => [item.key, item.label])).toEqual([
      ['inputTokens', '输入'],
      ['outputTokens', '输出'],
      ['cacheReadTokens', '缓存读取'],
      ['cacheCreationTokens', '缓存写入'],
      ['cacheHitRatio', '缓存命中率'],
    ])
  })

  test('给定四个字段各不相同 当生成明细 则每项的短值、完整值与悬停提示都取自对应字段', () => {
    const byKey = new Map(buildUsageBreakdownItems(totals).map((item) => [item.key, item]))

    expect(byKey.get('inputTokens')).toMatchObject({ compact: '1,500', exact: '1,500', title: '输入 1,500 token' })
    expect(byKey.get('outputTokens')).toMatchObject({ compact: '250.0 K', exact: '250,000', title: '输出 250,000 token' })
    // 缓存读取取 cacheReadTokens，缓存写入取 cacheCreationTokens，不能互换
    expect(byKey.get('cacheReadTokens')).toMatchObject({ compact: '6,000', exact: '6,000', title: '缓存读取 6,000 token' })
    expect(byKey.get('cacheCreationTokens')).toMatchObject({ compact: '2,500', exact: '2,500', title: '缓存写入 2,500 token' })
  })

  test('给定输入 1,500、缓存读取 6,000、缓存写入 2,500 当生成明细 则命中率为 6,000 ÷ 10,000 = 60.0%，悬停给出口径', () => {
    const ratio = buildUsageBreakdownItems(totals).find((item) => item.key === 'cacheHitRatio')

    expect(ratio).toEqual({
      key: 'cacheHitRatio',
      label: '缓存命中率',
      compact: '60.0%',
      exact: '60.0%',
      title: CACHE_HIT_RATIO_HINT,
    })
  })

  test('给定输入、缓存读取、缓存写入全为 0（只有输出） 当生成明细 则命中率分母为 0，显示「—」而不是 0% 或 NaN', () => {
    const items = buildUsageBreakdownItems({ inputTokens: 0, outputTokens: 1_234, cacheReadTokens: 0, cacheCreationTokens: 0 })

    expect(items.find((item) => item.key === 'cacheHitRatio')?.compact).toBe(EMPTY_VALUE)
    expect(items.find((item) => item.key === 'outputTokens')?.compact).toBe('1,234')
    expect(items.find((item) => item.key === 'inputTokens')?.compact).toBe('0')
  })

  test('给定字段里混入 NaN 当生成明细 则该项显示「—」，其余项照常', () => {
    const items = buildUsageBreakdownItems({ inputTokens: 100, outputTokens: Number.NaN, cacheReadTokens: 300, cacheCreationTokens: 100 })

    expect(items.find((item) => item.key === 'outputTokens')).toMatchObject({ compact: EMPTY_VALUE, exact: EMPTY_VALUE })
    expect(items.find((item) => item.key === 'cacheHitRatio')?.compact).toBe('60.0%')
  })
})
