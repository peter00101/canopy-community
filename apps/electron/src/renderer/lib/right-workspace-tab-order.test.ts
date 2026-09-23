import { describe, expect, test } from 'bun:test'
import {
  applyRightWorkspaceTabOrder,
  getRightWorkspaceDropIndex,
  getScrollLeftFromThumbDrag,
  getTabShiftOffsets,
  moveRightWorkspaceTab,
  shouldStartTabReorder,
} from './right-workspace-tab-order'

const tabs = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }))

describe('右侧工作区标签顺序应用', () => {
  test('Given 没有保存过顺序 When 应用 Then 保持默认顺序', () => {
    expect(applyRightWorkspaceTabOrder(tabs('files', 'changes', 'browser:a'), undefined).map((t) => t.id))
      .toEqual(['files', 'changes', 'browser:a'])
    expect(applyRightWorkspaceTabOrder(tabs('files', 'changes'), []).map((t) => t.id))
      .toEqual(['files', 'changes'])
  })

  test('Given 用户排过序 When 应用 Then 按用户顺序排列', () => {
    const result = applyRightWorkspaceTabOrder(tabs('files', 'changes', 'browser:a'), ['browser:a', 'files', 'changes'])
    expect(result.map((t) => t.id)).toEqual(['browser:a', 'files', 'changes'])
  })

  test('Given 顺序表里有已关闭的标签 When 应用 Then 忽略它不报错', () => {
    const result = applyRightWorkspaceTabOrder(tabs('files', 'changes'), ['browser:closed', 'changes', 'files'])
    expect(result.map((t) => t.id)).toEqual(['changes', 'files'])
  })

  test('Given 新开了顺序表里没有的标签 When 应用 Then 追加到末尾且不打乱既有排列', () => {
    const result = applyRightWorkspaceTabOrder(
      tabs('files', 'changes', 'terminal:new', 'browser:a'),
      ['browser:a', 'files'],
    )
    expect(result.map((t) => t.id)).toEqual(['browser:a', 'files', 'changes', 'terminal:new'])
  })

  test('Given 标签全部关闭后重开 When 应用 Then 不会残留空洞', () => {
    expect(applyRightWorkspaceTabOrder(tabs('files'), ['a', 'b', 'c']).map((t) => t.id)).toEqual(['files'])
  })
})

describe('右侧工作区标签移动', () => {
  test('Given 把最后一个标签拖到最前 When 移动 Then 顺序正确', () => {
    expect(moveRightWorkspaceTab(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  test('Given 把第一个拖到末尾 When 移动 Then 顺序正确', () => {
    expect(moveRightWorkspaceTab(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
  })

  test('Given 拖到中间 When 移动 Then 插在目标位置', () => {
    expect(moveRightWorkspaceTab(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  test('Given 目标下标越界 When 移动 Then 夹取到合法范围', () => {
    expect(moveRightWorkspaceTab(['a', 'b'], 'a', 99)).toEqual(['b', 'a'])
    expect(moveRightWorkspaceTab(['a', 'b'], 'b', -5)).toEqual(['b', 'a'])
  })

  test('Given 拖动一个不在顺序里的 id When 移动 Then 原样返回', () => {
    expect(moveRightWorkspaceTab(['a', 'b'], 'zzz', 0)).toEqual(['a', 'b'])
  })

  test('Given 拖到自己原位 When 移动 Then 顺序不变', () => {
    expect(moveRightWorkspaceTab(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
  })

  test('Given 从左往右拖 When 移动 Then 落点不多一位（off-by-one 回归锁）', () => {
    // 落点下标由「含被拖标签」的列表算出：把 a 拖到 c 的左半 → dropIndex=2
    // 期望 a 落在 b 与 c 之间；不做修正会变成 ['b','c','a']
    expect(moveRightWorkspaceTab(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'a', 'c', 'd'])
    // 实测场景：9 个标签里把首个「文件」拖到第 3 个标签上
    expect(moveRightWorkspaceTab(['文件', '改动', '搜索1', '搜索2'], '文件', 2)).toEqual(['改动', '文件', '搜索1', '搜索2'])
  })

  test('Given 从右往左拖 When 移动 Then 落点不受修正影响', () => {
    expect(moveRightWorkspaceTab(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })
})

describe('陈旧顺序表的处理（实测坑：拖动无效）', () => {
  test('Given 保存的顺序里全是已关闭标签 When 移动当前标签 Then 移动无效', () => {
    // 这就是「反向拖不动」的根因：baseline 里没有 terminal，indexOf 返回 -1
    const stale = ['browser:old1', 'browser:old2', 'files']
    expect(moveRightWorkspaceTab(stale, 'terminal:new', 1)).toEqual(stale)
  })

  test('Given 以当前渲染顺序为基准 When 移动 Then 正常生效（修复后的做法）', () => {
    const current = ['files', 'browser:a', 'changes', 'terminal:new']
    expect(moveRightWorkspaceTab(current, 'terminal:new', 1)).toEqual(['files', 'terminal:new', 'browser:a', 'changes'])
  })
})

describe('拖放插入位置判定', () => {
  const boxes = [
    { id: 'a', left: 0, right: 100 },
    { id: 'b', left: 100, right: 200 },
    { id: 'c', left: 200, right: 300 },
  ]

  test('Given 指针在首个标签左半 When 判定 Then 插到最前', () => {
    expect(getRightWorkspaceDropIndex(boxes, 10)).toBe(0)
  })

  test('Given 指针在某标签左半 When 判定 Then 插到它前面', () => {
    expect(getRightWorkspaceDropIndex(boxes, 120)).toBe(1) // b 的左半 → 插到 b 前
    expect(getRightWorkspaceDropIndex(boxes, 210)).toBe(2) // c 的左半 → 插到 c 前
  })

  test('Given 指针在某标签右半 When 判定 Then 插到它后面', () => {
    expect(getRightWorkspaceDropIndex(boxes, 160)).toBe(2) // b 的右半 → 插到 b 后（b 与 c 之间）
    expect(getRightWorkspaceDropIndex(boxes, 260)).toBe(3) // c 的右半 → 末尾
  })

  test('Given 指针在所有标签右侧 When 判定 Then 插到末尾', () => {
    expect(getRightWorkspaceDropIndex(boxes, 999)).toBe(3)
  })

  test('Given 空标签栏 When 判定 Then 返回 0', () => {
    expect(getRightWorkspaceDropIndex([], 50)).toBe(0)
  })
})

describe('排序手势判定', () => {
  test('Given 明显横向拖动 When 判定 Then 进入排序', () => {
    expect(shouldStartTabReorder(20, 3)).toBe(true)
  })

  test('Given 位移太小 When 判定 Then 不触发（避免误触点击）', () => {
    expect(shouldStartTabReorder(4, 1)).toBe(false)
  })

  test('Given 明显向下拖动 When 判定 Then 不进入排序（留给分屏手势）', () => {
    expect(shouldStartTabReorder(10, 40)).toBe(false)
  })

  test('Given 斜向拖去分屏（横 40 / 纵 25）When 判定 Then 不抢排序', () => {
    // 实测斜拖到内容区时早期帧就是这种比例，1 倍判据会被排序抢走
    expect(shouldStartTabReorder(40, 25)).toBe(false)
  })

  test('Given 近乎纯横向（横 40 / 纵 8）When 判定 Then 进入排序', () => {
    expect(shouldStartTabReorder(40, 8)).toBe(true)
  })

  test('Given 向左拖动 When 判定 Then 同样进入排序', () => {
    expect(shouldStartTabReorder(-25, 5)).toBe(true)
  })
})


describe('拖动中其他标签的让位位移（Chrome 手感）', () => {
  const W = 100

  test('Given 把第 0 个往右拖过第 2 个 When 计算 Then 中间两个左移一格、其余不动', () => {
    const shifts = getTabShiftOffsets(5, 0, 3, W)
    expect([...shifts.entries()].sort()).toEqual([[1, -W], [2, -W]])
  })

  test('Given 把第 4 个往左拖到第 1 位 When 计算 Then 中间三个右移一格', () => {
    const shifts = getTabShiftOffsets(5, 4, 1, W)
    expect([...shifts.entries()].sort()).toEqual([[1, W], [2, W], [3, W]])
  })

  test('Given 落点就在自身前后一格 When 计算 Then 谁都不动（没有实际换位）', () => {
    expect(getTabShiftOffsets(5, 2, 2, W).size).toBe(0)
    expect(getTabShiftOffsets(5, 2, 3, W).size).toBe(0)
  })

  test('Given 拖到最末 When 计算 Then 后面全部左移', () => {
    const shifts = getTabShiftOffsets(4, 0, 4, W)
    expect([...shifts.entries()].sort()).toEqual([[1, -W], [2, -W], [3, -W]])
  })

  test('Given 只有一个标签或宽度非法 When 计算 Then 返回空（不做无谓动画）', () => {
    expect(getTabShiftOffsets(1, 0, 1, W).size).toBe(0)
    expect(getTabShiftOffsets(5, 0, 3, 0).size).toBe(0)
    expect(getTabShiftOffsets(5, -1, 3, W).size).toBe(0)
  })
})

describe('滚动条滑块拖动换算', () => {
  test('Given 滑块从最左拖到最右 When 换算 Then 得到最大滚动位置', () => {
    // 轨道 500、滑块 100 → 可行程 400；拖满 400 应到 maxScroll
    expect(getScrollLeftFromThumbDrag(400, 500, 100, 0, 800)).toBe(800)
  })

  test('Given 拖一半行程 When 换算 Then 得到一半滚动量', () => {
    expect(getScrollLeftFromThumbDrag(200, 500, 100, 0, 800)).toBe(400)
  })

  test('Given 从中间往回拖 When 换算 Then 基于按下时的位置递减', () => {
    expect(getScrollLeftFromThumbDrag(-100, 500, 100, 400, 800)).toBe(200)
  })

  test('Given 拖出边界 When 换算 Then 夹取在 [0, max]', () => {
    expect(getScrollLeftFromThumbDrag(9999, 500, 100, 0, 800)).toBe(800)
    expect(getScrollLeftFromThumbDrag(-9999, 500, 100, 400, 800)).toBe(0)
  })

  test('Given 无可滚空间或滑块占满轨道 When 换算 Then 保持原位', () => {
    expect(getScrollLeftFromThumbDrag(100, 500, 500, 42, 800)).toBe(42)
    expect(getScrollLeftFromThumbDrag(100, 500, 100, 42, 0)).toBe(42)
  })
})
