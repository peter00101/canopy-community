import { describe, expect, test } from 'bun:test'
import {
  PI_AUTO_COMPACTION_MAX_RATIO,
  PI_AUTO_COMPACTION_MIN_RATIO,
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
  normalizePiAutoCompactionRatio,
} from './pi-compaction'

describe('自动压缩比例归一化', () => {
  test('缺省或非法值回落到默认 80%', () => {
    expect(normalizePiAutoCompactionRatio(undefined)).toBe(PI_AUTO_COMPACTION_THRESHOLD_RATIO)
    expect(normalizePiAutoCompactionRatio(Number.NaN)).toBe(PI_AUTO_COMPACTION_THRESHOLD_RATIO)
    expect(normalizePiAutoCompactionRatio(Number.POSITIVE_INFINITY)).toBe(PI_AUTO_COMPACTION_THRESHOLD_RATIO)
  })

  test('区间内的值原样保留', () => {
    expect(normalizePiAutoCompactionRatio(0.5)).toBe(0.5)
    expect(normalizePiAutoCompactionRatio(0.7)).toBe(0.7)
    expect(normalizePiAutoCompactionRatio(0.95)).toBe(0.95)
  })

  test('越界值夹到边界，不抛错也不透传', () => {
    expect(normalizePiAutoCompactionRatio(0.1)).toBe(PI_AUTO_COMPACTION_MIN_RATIO)
    expect(normalizePiAutoCompactionRatio(0)).toBe(PI_AUTO_COMPACTION_MIN_RATIO)
    expect(normalizePiAutoCompactionRatio(-1)).toBe(PI_AUTO_COMPACTION_MIN_RATIO)
    expect(normalizePiAutoCompactionRatio(1)).toBe(PI_AUTO_COMPACTION_MAX_RATIO)
    expect(normalizePiAutoCompactionRatio(2)).toBe(PI_AUTO_COMPACTION_MAX_RATIO)
  })
})

describe('reserveTokens 换算', () => {
  test('省略比例时保持默认 80% 行为不变', () => {
    expect(calculatePiAutoCompactionReserveTokens(200_000)).toBe(40_000)
    expect(calculatePiAutoCompactionThresholdTokens(200_000)).toBe(160_000)
  })

  test('自定义比例按 (1 - ratio) 预留窗口', () => {
    expect(calculatePiAutoCompactionReserveTokens(200_000, 0.5)).toBe(100_000)
    expect(calculatePiAutoCompactionReserveTokens(200_000, 0.9)).toBe(20_000)
    expect(calculatePiAutoCompactionThresholdTokens(200_000, 0.5)).toBe(100_000)
    expect(calculatePiAutoCompactionThresholdTokens(200_000, 0.9)).toBe(180_000)
  })

  test('比例越界时按夹住后的边界换算', () => {
    expect(calculatePiAutoCompactionReserveTokens(200_000, 0.1))
      .toBe(calculatePiAutoCompactionReserveTokens(200_000, PI_AUTO_COMPACTION_MIN_RATIO))
    expect(calculatePiAutoCompactionReserveTokens(200_000, 1))
      .toBe(calculatePiAutoCompactionReserveTokens(200_000, PI_AUTO_COMPACTION_MAX_RATIO))
  })

  test('阈值始终为正且小于窗口，避免压缩永不触发或立刻触发', () => {
    for (const ratio of [0.5, 0.8, 0.95, 0.1, 2]) {
      const threshold = calculatePiAutoCompactionThresholdTokens(200_000, ratio)
      expect(threshold).toBeGreaterThan(0)
      expect(threshold).toBeLessThan(200_000)
    }
  })

  test('非正数窗口仍然抛错', () => {
    expect(() => calculatePiAutoCompactionReserveTokens(0)).toThrow(TypeError)
    expect(() => calculatePiAutoCompactionReserveTokens(-1, 0.8)).toThrow(TypeError)
    expect(() => calculatePiAutoCompactionReserveTokens(Number.NaN, 0.8)).toThrow(TypeError)
  })

  test('小窗口向上取整，预留不会为 0', () => {
    expect(calculatePiAutoCompactionReserveTokens(1001, 0.95)).toBe(51)
    expect(calculatePiAutoCompactionThresholdTokens(1001, 0.95)).toBe(950)
  })
})
