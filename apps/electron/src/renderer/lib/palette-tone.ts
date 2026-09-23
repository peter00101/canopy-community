/**
 * 主题「色族」取色（配色体系，globals.css「palette contract」）。
 *
 * 每套主题定义六个同调性的颜色 --palette-1 ~ --palette-6（莫兰迪式：同一饱和度与明度带里的几个色相），
 * 侧栏入口、项目文件夹、会话色块、chip 这些「需要彼此区分又要属于同一套」的地方从色族里取，
 * 不再各自写死蓝 / 紫 / 灰。取色按 id 哈希稳定分配（同一项目永远同一色），与 rail-session-glyph 同一个哈希。
 */
import { hashRailId } from './rail-session-glyph'

export const PALETTE_TONE_COUNT = 6

/** 写成静态字面量，Tailwind 才扫得到（拼接字符串会被摇掉） */
export const PALETTE_TONE_TEXT_CLASSES = [
  'text-palette-1',
  'text-palette-2',
  'text-palette-3',
  'text-palette-4',
  'text-palette-5',
  'text-palette-6',
] as const

export type PaletteTone = 1 | 2 | 3 | 4 | 5 | 6

/** 按 id 稳定取 1~6；空 id 落 1 */
export function pickPaletteTone(id: string): PaletteTone {
  if (!id) return 1
  return ((hashRailId(id) % PALETTE_TONE_COUNT) + 1) as PaletteTone
}

export function paletteToneTextClass(tone: PaletteTone): string {
  return PALETTE_TONE_TEXT_CLASSES[tone - 1] ?? PALETTE_TONE_TEXT_CLASSES[0]
}

export function paletteToneTextClassForId(id: string): string {
  return paletteToneTextClass(pickPaletteTone(id))
}
