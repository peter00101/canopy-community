import { describe, expect, test } from 'bun:test'
import {
  buildEditableContextMenuItems,
  resolveTextContextMenuPlacement,
  type TextContextMenuContext,
  type TextContextMenuWindowState,
} from './text-context-menu-policy'

const VISIBLE_WINDOW: TextContextMenuWindowState = { destroyed: false, visible: true, minimized: false }

describe('输入框右键菜单弹出位置（2026-09-15 菜单飘到别的窗口上置顶）', () => {
  test('Given 窗口正常可见 When 在输入框右键 Then 菜单锚定在右键坐标（不再跟随鼠标）', () => {
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: 320, y: 480, menuSourceType: 'mouse' }, 'win32'))
      .toEqual({ show: true, x: 320, y: 480, sourceType: 'mouse' })
  })

  test('Given 缩放后坐标带小数 When 右键 Then 坐标四舍五入为整数（popup 只收整数）', () => {
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: 120.4, y: 99.6 }, 'win32'))
      .toEqual({ show: true, x: 120, y: 100 })
  })

  test('Given 右键落在内容区左上角 When 坐标为 0,0 Then 仍算合法坐标', () => {
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: 0, y: 0 }, 'win32')).toEqual({ show: true, x: 0, y: 0 })
  })

  test('Given 窗口已最小化（模拟右键 / 后台事件） When 收到右键 Then 不弹菜单', () => {
    expect(resolveTextContextMenuPlacement({ destroyed: false, visible: true, minimized: true }, { x: 10, y: 10 }, 'win32'))
      .toEqual({ show: false, reason: 'window-minimized' })
  })

  test('Given 窗口隐藏（如预创建未显示的快速任务窗） When 收到右键 Then 不弹菜单', () => {
    expect(resolveTextContextMenuPlacement({ destroyed: false, visible: false, minimized: false }, { x: 10, y: 10 }, 'win32'))
      .toEqual({ show: false, reason: 'window-hidden' })
  })

  test('Given 窗口已销毁或找不到所属窗口 When 收到右键 Then 不弹菜单', () => {
    expect(resolveTextContextMenuPlacement({ destroyed: true, visible: true, minimized: false }, { x: 10, y: 10 }, 'win32'))
      .toEqual({ show: false, reason: 'window-destroyed' })
    expect(resolveTextContextMenuPlacement(null, { x: 10, y: 10 }, 'win32')).toEqual({ show: false, reason: 'no-window' })
  })

  test('Given 坐标异常（NaN / 负数） When 右键 Then 仍弹菜单但不带坐标，保住真实用户可用', () => {
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: Number.NaN, y: 10 }, 'win32')).toEqual({ show: true })
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: -1, y: 10 }, 'win32')).toEqual({ show: true })
  })

  test('Given macOS When 右键 Then 不传 sourceType（该选项只在 Windows / Linux 生效），坐标照常', () => {
    expect(resolveTextContextMenuPlacement(VISIBLE_WINDOW, { x: 5, y: 6, menuSourceType: 'keyboard' }, 'darwin'))
      .toEqual({ show: true, x: 5, y: 6 })
  })
})

function makeContext(overrides: Partial<TextContextMenuContext> = {}): TextContextMenuContext {
  return {
    isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...overrides,
  }
}

describe('输入框右键菜单判定', () => {
  test('Given 只读区域（消息文本、空白处） When 右键 Then 不弹菜单（复制由选中浮层负责）', () => {
    expect(buildEditableContextMenuItems(makeContext())).toEqual([])
    expect(
      buildEditableContextMenuItems(
        makeContext({ editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } }),
      ),
    ).toEqual([])
  })

  test('Given 输入框内无选中文本 When 右键 Then 弹四件套且剪切复制置灰、粘贴全选可用', () => {
    const items = buildEditableContextMenuItems(
      makeContext({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
    )
    expect(items).toEqual([
      { type: 'action', action: 'cut', label: '剪切', enabled: false },
      { type: 'action', action: 'copy', label: '复制', enabled: false },
      { type: 'action', action: 'paste', label: '粘贴', enabled: true },
      { type: 'separator' },
      { type: 'action', action: 'selectAll', label: '全选', enabled: true },
    ])
  })

  test('Given 输入框内有选中文本 When 右键 Then 四件全部可用', () => {
    const items = buildEditableContextMenuItems(
      makeContext({
        isEditable: true,
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }),
    )
    const actions = items.filter((item) => item.type === 'action')
    expect(actions.map((item) => item.action)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    expect(actions.every((item) => item.enabled)).toBe(true)
  })

  test('Given 剪贴板为空的输入框 When 右键 Then 粘贴项存在但置灰（不消失）', () => {
    const items = buildEditableContextMenuItems(
      makeContext({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
      }),
    )
    const paste = items.find((item) => item.type === 'action' && item.action === 'paste')
    expect(paste).toEqual({ type: 'action', action: 'paste', label: '粘贴', enabled: false })
  })
})
