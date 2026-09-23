/**
 * 右侧工作区标签的用户自定义顺序。
 *
 * 默认顺序由 SidePanel 按类型硬编码拼接（文件 → 改动 → 工作区组件 → 预览 → 终端 →
 * 问答 → 探索 → 委派 → 浏览器）。同类标签多开时（实测常见 7 个浏览器标签）用户需要
 * 自己调整位置，这里提供一层顺序覆盖：
 *
 * - 只记 tabId 序列，不复制标签内容；标签关掉后 id 自然失配、被忽略
 * - 新出现的标签（用户刚开的浏览器/终端）追加到末尾，不打乱既有排列
 * - 用户没拖过的会话保持默认顺序（order 为空即原样返回）
 */

export interface TabOrderEntry {
  id: string
}

/** 把保存的顺序应用到当前标签列表；未记录的新标签保持在原有相对位置之后。 */
export function applyRightWorkspaceTabOrder<T extends TabOrderEntry>(
  tabs: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return [...tabs]
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const result: T[] = []
  for (const id of order) {
    const tab = byId.get(id)
    if (!tab) continue // 已关闭的标签
    result.push(tab)
    byId.delete(id)
  }
  // 顺序表里没有的（本次新开的标签）按原顺序补到末尾
  for (const tab of tabs) {
    if (byId.has(tab.id)) result.push(tab)
  }
  return result
}

/**
 * 把 tabId 移动到目标下标，返回新的完整顺序（基于当前可见顺序重算，
 * 这样即使之前没有保存过顺序，一次拖动也能固化下来）。
 */
export function moveRightWorkspaceTab(
  currentOrder: readonly string[],
  tabId: string,
  toIndex: number,
): string[] {
  const from = currentOrder.indexOf(tabId)
  if (from === -1) return [...currentOrder]
  const rest = currentOrder.filter((id) => id !== tabId)
  // toIndex 由 getRightWorkspaceDropIndex 在**含被拖标签**的列表上算出；
  // 从左往右拖时，把自己摘掉会让后面的位置整体前移一格，不减 1 就会多落一位。
  const adjusted = from < toIndex ? toIndex - 1 : toIndex
  const clamped = Math.max(0, Math.min(adjusted, rest.length))
  rest.splice(clamped, 0, tabId)
  return rest
}

export interface TabHitBox {
  id: string
  left: number
  right: number
}

/**
 * 根据指针横坐标算插入下标：落在某标签左半边则插到它前面，右半边插到它后面。
 * 返回值是「插入位置」（0..n），可直接交给 moveRightWorkspaceTab。
 */
export function getRightWorkspaceDropIndex(boxes: readonly TabHitBox[], clientX: number): number {
  if (boxes.length === 0) return 0
  for (const [i, box] of boxes.entries()) {
    if (clientX < box.left + (box.right - box.left) / 2) return i
  }
  return boxes.length
}

/**
 * 拖动是否已足以判定为「排序」。
 *
 * 与分屏手势（向下拖出标签栏）共存，所以要求横向意图**明显占优**：
 * 横向位移过阈值，且横向分量至少是纵向的 2 倍。实测斜向拖去分屏时，
 * 早期几帧常常是「横 40 / 纵 25」这种，1 倍判据会先被排序抢走。
 */
export function shouldStartTabReorder(dx: number, dy: number, threshold = 8): boolean {
  return Math.abs(dx) >= threshold && Math.abs(dx) >= Math.abs(dy) * 2
}

/**
 * 拖动中其他标签的「让位」位移（Chrome 标签页手感）。
 *
 * 被拖标签跟着光标走，其余标签实时平移让出空位：光标越过谁，谁就往回挪一格宽度，
 * 松手时被拖标签正好落进那个空位。只画一条插入线是不够的——用户要能看见队列真的在重排。
 *
 * @param fromIndex 被拖标签在当前顺序中的原始下标
 * @param dropIndex 当前落点（getRightWorkspaceDropIndex 的返回值，0..n）
 * @param slotWidth 被拖标签占位宽度（含间距）
 * @returns 下标 → 水平位移；未列出的标签不动
 */
export function getTabShiftOffsets(
  tabCount: number,
  fromIndex: number,
  dropIndex: number,
  slotWidth: number,
): Map<number, number> {
  const shifts = new Map<number, number>()
  if (fromIndex < 0 || tabCount <= 1 || slotWidth <= 0) return shifts
  // dropIndex 落在自身前后一格内 = 没挪动
  if (dropIndex === fromIndex || dropIndex === fromIndex + 1) return shifts

  if (dropIndex > fromIndex) {
    // 往右拖：夹在中间的标签整体左移一格
    for (let i = fromIndex + 1; i < dropIndex; i++) shifts.set(i, -slotWidth)
  } else {
    // 往左拖：夹在中间的标签整体右移一格
    for (let i = dropIndex; i < fromIndex; i++) shifts.set(i, slotWidth)
  }
  return shifts
}

/**
 * 拖动滚动条滑块时换算目标 scrollLeft。
 *
 * @param deltaX 滑块相对按下点的水平位移
 * @param trackWidth 轨道可用宽度
 * @param thumbWidth 滑块宽度
 * @param startScrollLeft 按下时的 scrollLeft
 * @param maxScrollLeft 最大可滚距离（scrollWidth - clientWidth）
 */
export function getScrollLeftFromThumbDrag(
  deltaX: number,
  trackWidth: number,
  thumbWidth: number,
  startScrollLeft: number,
  maxScrollLeft: number,
): number {
  const travel = trackWidth - thumbWidth
  if (travel <= 0 || maxScrollLeft <= 0) return startScrollLeft
  const next = startScrollLeft + (deltaX / travel) * maxScrollLeft
  return Math.max(0, Math.min(maxScrollLeft, next))
}
