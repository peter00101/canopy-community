import { describe, expect, test } from 'bun:test'
import { shouldExcludeSelection, type SelectionNodeTraits } from './useTextSelectionAnchor'

/** 造一个祖先链节点；默认全部为"普通只读元素"。 */
function node(overrides: Partial<SelectionNodeTraits> = {}): SelectionNodeTraits {
  return {
    isPopover: false,
    isExplicitlyExcluded: false,
    isHidden: false,
    isEditable: false,
    isRoot: false,
    ...overrides,
  }
}

describe('选区浮层的排除判定', () => {
  test('Given 选区在容器内的普通文本 When 判定 Then 不排除（正常弹浮层）', () => {
    const chain = [node(), node(), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(false)
  })

  test('Given 选区落在浮层自身 When 判定 Then 排除（避免点按钮时自弹自）', () => {
    const chain = [node({ isPopover: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 祖先标了 data-text-selection-excluded When 判定 Then 排除', () => {
    const chain = [node(), node({ isExplicitlyExcluded: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 祖先是隐藏子树 When 判定 Then 排除', () => {
    const chain = [node(), node({ isHidden: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 选区在输入框内且未开 includeEditable When 判定 Then 排除（Chat 输入框不该弹）', () => {
    const chain = [node({ isEditable: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 同一编辑器选区但开了 includeEditable When 判定 Then 不排除（笔记库正文场景）', () => {
    const chain = [node({ isEditable: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, true)).toBe(false)
  })

  test('Given includeEditable 打开但祖先显式排除 When 判定 Then 仍排除（显式标记优先级更高）', () => {
    const chain = [node({ isEditable: true }), node({ isExplicitlyExcluded: true }), node({ isRoot: true })]
    expect(shouldExcludeSelection(chain, true)).toBe(true)
  })

  test('Given 走完整条祖先链都没遇到容器根 When 判定 Then 排除（选区不在本容器内）', () => {
    const chain = [node(), node(), node()]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 空链（选区节点已脱离文档）When 判定 Then 排除', () => {
    expect(shouldExcludeSelection([], false)).toBe(true)
    expect(shouldExcludeSelection([], true)).toBe(true)
  })

  test('Given 容器根本身可编辑但未开 includeEditable When 判定 Then 排除', () => {
    const chain = [node({ isEditable: true, isRoot: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(true)
  })

  test('Given 排除性特征出现在容器根之外（更上层）When 判定 Then 不受影响（遇到根即停）', () => {
    const chain = [node(), node({ isRoot: true }), node({ isExplicitlyExcluded: true })]
    expect(shouldExcludeSelection(chain, false)).toBe(false)
  })
})
