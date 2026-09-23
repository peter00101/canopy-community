/**
 * 输入框高度拖拽的纯逻辑
 *
 * 参考 Cherry Studio Composer 的高度拖拽交互：
 * - 手动高度存在组件 state（null = 自动模式，沿用三档 max-height）
 * - 拖动上边缘调整；向上拖增高、向下拖降低
 * - clamp 在 [MIN, MAX] 区间；MAX 随窗口高度自适应
 */

/** 手动高度下限（与编辑器 min-h-[101px] 一致） */
export const INPUT_HEIGHT_MIN = 101

/** 自动模式展开态的上限，同时是手动高度的保底上限 */
export const INPUT_HEIGHT_AUTO_MAX = 500

/** 键盘 ↑/↓ 调整步长 */
export const INPUT_HEIGHT_KEYBOARD_STEP = 16

/** 计算手动高度上限：不小于自动上限，最多占窗口高度一半 */
export function resolveInputHeightMax(viewportHeight: number): number {
  return Math.max(INPUT_HEIGHT_AUTO_MAX, Math.floor(viewportHeight * 0.5))
}

/** 夹取手动高度到合法区间 */
export function clampInputHeight(height: number, viewportHeight: number): number {
  const max = resolveInputHeightMax(viewportHeight)
  return Math.min(max, Math.max(INPUT_HEIGHT_MIN, Math.round(height)))
}

/**
 * 由拖拽位移计算新高度。
 * 拖拽条在输入框顶部：指针向上移动（clientY 变小）应增高。
 */
export function computeDragHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number,
  viewportHeight: number
): number {
  return clampInputHeight(startHeight + (startClientY - currentClientY), viewportHeight)
}

/** 键盘步进：direction 为 1 增高，-1 降低 */
export function stepInputHeight(
  currentHeight: number,
  direction: 1 | -1,
  viewportHeight: number
): number {
  return clampInputHeight(currentHeight + direction * INPUT_HEIGHT_KEYBOARD_STEP, viewportHeight)
}
