/**
 * 输入框（可编辑区）右键菜单的纯逻辑判定。
 *
 * 只对 isEditable 的目标弹菜单——粘贴是主场景（粘贴时没有选区，
 * 选中浮层帮不上忙）；只读文本区一律不弹，那里的复制由选中浮层的
 * 「复制文本」按钮负责（SelectionActionPopover），两者互不重叠。
 * 渲染层自定义右键菜单的区域（Radix ContextMenu）会 preventDefault，
 * 主进程收不到事件，天然不冲突。
 */

export interface TextContextMenuEditFlags {
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

export interface TextContextMenuContext {
  isEditable: boolean
  editFlags: TextContextMenuEditFlags
}

export type TextContextMenuItem =
  | { type: 'separator' }
  | {
      type: 'action'
      action: 'cut' | 'copy' | 'paste' | 'selectAll'
      label: string
      enabled: boolean
    }

export interface TextContextMenuWindowState {
  destroyed: boolean
  visible: boolean
  minimized: boolean
}

export interface TextContextMenuTrigger {
  /** `context-menu` 事件给的坐标：相对窗口内容区左上角，已换算到窗口坐标系 */
  x: number
  y: number
  /** `context-menu` 事件的 menuSourceType（鼠标 / 键盘 / 触摸…），原样转交给 popup */
  menuSourceType?: string
}

export type TextContextMenuPlacement =
  | { show: false; reason: 'no-window' | 'window-destroyed' | 'window-hidden' | 'window-minimized' }
  | { show: true; x?: number; y?: number; sourceType?: string }

/**
 * 决定原生右键菜单弹不弹、弹在哪。
 *
 * 旧实现 `popup({ window })` 不带坐标，系统就把菜单放在**鼠标此刻所在位置**，而原生菜单天然置顶。
 * 真实右键时鼠标就在点的地方，看不出问题；可一旦右键事件不是这只鼠标在这个窗口里点出来的
 * （CDP / 自动化模拟右键、窗口最小化或隐藏时收到事件），菜单就会飘到用户正在用的别的窗口上
 * （2026-09-15 维护者截图：「剪切 / 复制 / 粘贴 / 全选」压在终端上，当时 dev 窗口是最小化的）。
 *
 * 规则：
 * - 没有所属窗口、窗口已销毁 / 隐藏 / 最小化：不弹——用户看不到这个窗口，就不该冒出它的菜单；
 * - 坐标合法：带上坐标，菜单锚定在窗口里右键发生的位置，与鼠标在哪无关；键盘唤出（Shift+F10）时这个坐标就是光标处；
 * - 坐标不合法（理论上不会出现）：照旧不带坐标弹，保证真实用户右键时菜单一定出得来。
 * - `sourceType` 只在 Windows / Linux 生效（Electron 文档），macOS 不传。
 */
export function resolveTextContextMenuPlacement(
  window: TextContextMenuWindowState | null,
  trigger: TextContextMenuTrigger,
  platform: string,
): TextContextMenuPlacement {
  if (!window) return { show: false, reason: 'no-window' }
  if (window.destroyed) return { show: false, reason: 'window-destroyed' }
  if (!window.visible) return { show: false, reason: 'window-hidden' }
  if (window.minimized) return { show: false, reason: 'window-minimized' }

  const sourceType = platform !== 'darwin' && trigger.menuSourceType ? trigger.menuSourceType : undefined
  const validPoint = Number.isFinite(trigger.x) && Number.isFinite(trigger.y) && trigger.x >= 0 && trigger.y >= 0
  return {
    show: true,
    ...(validPoint ? { x: Math.round(trigger.x), y: Math.round(trigger.y) } : {}),
    ...(sourceType ? { sourceType } : {}),
  }
}

/**
 * 结构与 menu.ts 应用菜单一致：剪切 / 复制 / 粘贴 / ─ / 全选。
 * 无选中时剪切复制置灰而不是消失——右键粘贴是输入框的主场景。
 */
export function buildEditableContextMenuItems(context: TextContextMenuContext): TextContextMenuItem[] {
  if (!context.isEditable) return []
  return [
    { type: 'action', action: 'cut', label: '剪切', enabled: context.editFlags.canCut },
    { type: 'action', action: 'copy', label: '复制', enabled: context.editFlags.canCopy },
    { type: 'action', action: 'paste', label: '粘贴', enabled: context.editFlags.canPaste },
    { type: 'separator' },
    { type: 'action', action: 'selectAll', label: '全选', enabled: context.editFlags.canSelectAll },
  ]
}
