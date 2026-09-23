/**
 * 输入框（可编辑区）右键菜单接线层。
 *
 * 挂在 webContents 的 `context-menu` 事件上，按 text-context-menu-policy
 * 的判定弹原生菜单；只读区域返回空数组即不弹；窗口不可见不弹；
 * 弹出位置锚定右键坐标，不跟随鼠标（见 resolveTextContextMenuPlacement）。
 */

import { BrowserWindow, Menu, type MenuItemConstructorOptions, type PopupOptions, type WebContents } from 'electron'
import { buildEditableContextMenuItems, resolveTextContextMenuPlacement } from './text-context-menu-policy'

export function attachTextContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const window = BrowserWindow.fromWebContents(contents)
    const placement = resolveTextContextMenuPlacement(
      window
        ? window.isDestroyed()
          ? { destroyed: true, visible: false, minimized: false }
          : { destroyed: false, visible: window.isVisible(), minimized: window.isMinimized() }
        : null,
      { x: params.x, y: params.y, menuSourceType: params.menuSourceType },
      process.platform,
    )
    // 窗口看不见（最小化 / 隐藏 / 已销毁）就不弹：否则原生菜单会冒在用户正在用的别的窗口上
    if (!placement.show || !window) return

    const items = buildEditableContextMenuItems({
      isEditable: params.isEditable,
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    })
    if (items.length === 0) return

    const template: MenuItemConstructorOptions[] = items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' }
      return {
        label: item.label,
        enabled: item.enabled,
        click: () => {
          if (contents.isDestroyed()) return
          switch (item.action) {
            case 'cut':
              contents.cut()
              break
            case 'copy':
              contents.copy()
              break
            case 'paste':
              contents.paste()
              break
            case 'selectAll':
              contents.selectAll()
              break
          }
        },
      }
    })

    // 带上右键坐标：菜单锚定在窗口里右键发生的位置。不带坐标时系统会放在「鼠标此刻所在处」，
    // 模拟右键 / 后台事件时就飘到别的窗口上置顶（2026-09-15 维护者截图）。
    const options: PopupOptions = { window }
    if (placement.x !== undefined && placement.y !== undefined) {
      options.x = placement.x
      options.y = placement.y
    }
    if (placement.sourceType) options.sourceType = params.menuSourceType
    Menu.buildFromTemplate(template).popup(options)
  })
}
