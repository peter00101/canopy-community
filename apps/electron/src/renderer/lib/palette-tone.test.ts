import { describe, expect, test } from 'bun:test'
import { PALETTE_TONE_COUNT, PALETTE_TONE_TEXT_CLASSES, paletteToneTextClass, paletteToneTextClassForId, pickPaletteTone } from './palette-tone'

describe('色族取色：按 id 稳定分配到六色之一', () => {
  test('Given 同一个 id，When 多次取色，Then 永远同一档', () => {
    expect(pickPaletteTone('workspace-abc')).toBe(pickPaletteTone('workspace-abc'))
  })

  test('Given 一批不同 id，When 取色，Then 都落在 1~6 内且不止一种（色族真的被用开）', () => {
    const tones = new Set(Array.from({ length: 40 }, (_, i) => pickPaletteTone(`ws-${i}`)))
    for (const t of tones) expect(t).toBeGreaterThanOrEqual(1), expect(t).toBeLessThanOrEqual(PALETTE_TONE_COUNT)
    expect(tones.size).toBeGreaterThan(3)
  })

  test('Given 空 id，When 取色，Then 落第 1 档不抛错', () => {
    expect(pickPaletteTone('')).toBe(1)
  })

  test('类名是静态字面量、六个互不相同，且与档位一一对应', () => {
    expect(new Set(PALETTE_TONE_TEXT_CLASSES).size).toBe(PALETTE_TONE_COUNT)
    expect(paletteToneTextClass(1)).toBe('text-palette-1')
    expect(paletteToneTextClass(6)).toBe('text-palette-6')
    expect((PALETTE_TONE_TEXT_CLASSES as readonly string[]).includes(paletteToneTextClassForId('any-id'))).toBe(true)
  })
})
