import { describe, expect, test } from 'bun:test'
import {
  INPUT_HEIGHT_AUTO_MAX,
  INPUT_HEIGHT_KEYBOARD_STEP,
  INPUT_HEIGHT_MIN,
  clampInputHeight,
  computeDragHeight,
  resolveInputHeightMax,
  stepInputHeight,
} from './input-height'

describe('输入框高度拖拽', () => {
  test('Given 小窗口 When 计算上限 Then 保底为自动展开上限', () => {
    expect(resolveInputHeightMax(600)).toBe(INPUT_HEIGHT_AUTO_MAX)
  })

  test('Given 大窗口 When 计算上限 Then 为窗口高度一半', () => {
    expect(resolveInputHeightMax(1440)).toBe(720)
  })

  test('Given 超出区间的高度 When 夹取 Then 落回边界', () => {
    expect(clampInputHeight(20, 900)).toBe(INPUT_HEIGHT_MIN)
    expect(clampInputHeight(9999, 900)).toBe(resolveInputHeightMax(900))
  })

  test('Given 指针上移 When 计算拖拽高度 Then 输入框增高', () => {
    expect(computeDragHeight(200, 500, 440, 900)).toBe(260)
  })

  test('Given 指针下移 When 计算拖拽高度 Then 输入框降低且不低于下限', () => {
    expect(computeDragHeight(200, 500, 560, 900)).toBe(140)
    expect(computeDragHeight(120, 500, 900, 900)).toBe(INPUT_HEIGHT_MIN)
  })

  test('Given 键盘步进 When 上/下调整 Then 按固定步长变化并受边界约束', () => {
    expect(stepInputHeight(200, 1, 900)).toBe(200 + INPUT_HEIGHT_KEYBOARD_STEP)
    expect(stepInputHeight(200, -1, 900)).toBe(200 - INPUT_HEIGHT_KEYBOARD_STEP)
    expect(stepInputHeight(INPUT_HEIGHT_MIN, -1, 900)).toBe(INPUT_HEIGHT_MIN)
  })
})
