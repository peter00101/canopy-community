/**
 * 右侧工作区标签「关闭」按钮的样式（纯逻辑，DiffPanelTabBar 与测试共用）。
 *
 * 0.19.10 之前未选中标签的关闭按钮是 `w-0` → 悬停 `w-7` 的宽度动画：鼠标一进标签，标签就变宽 20px（实测 84 → 104）；
 * 滚轮滚动标签条时光标不动、标签在底下移动，悬停对象不断切换，整条标签条连同滚动条一起抖。
 * 现在按钮在任何状态下都占同一块位置（w-7 + mr-1），只用透明度表达「悬停才显示」，
 * 标签宽度与悬停彻底无关——与 Chrome 标签条的做法一致。
 */

/** 所有状态共用的基础类：尺寸与边距固定，过渡里不再有 width / margin */
export const RIGHT_PANEL_TAB_CLOSE_BUTTON_BASE_CLASS =
  'inline-flex h-7 w-7 mr-1 shrink-0 items-center justify-center overflow-hidden rounded-md text-muted-foreground transition-[background-color,color,opacity,transform] hover:bg-background/70 hover:text-foreground active:scale-[0.96]'

export interface RightPanelTabCloseButtonState {
  /** 并排视图里两个标签共用的那颗「退出并排」按钮 */
  sharedSplit: boolean
  /** 标签是否为当前选中 */
  selected: boolean
  /** 并排标签组是否被悬停（只对 sharedSplit 有意义） */
  groupHovered: boolean
}

/** 只表达「显不显示」的那部分类名 */
export function getRightPanelTabCloseButtonVisibilityClass(state: RightPanelTabCloseButtonState): string {
  if (state.sharedSplit) {
    return state.groupHovered ? 'opacity-60 hover:opacity-100' : 'opacity-0'
  }
  if (state.selected) return 'opacity-60 hover:opacity-100'
  // 未选中：默认隐藏，鼠标进入标签（group）后显示；按钮位置始终保留
  return 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100'
}

export function getRightPanelTabCloseButtonClassName(state: RightPanelTabCloseButtonState): string {
  return `${RIGHT_PANEL_TAB_CLOSE_BUTTON_BASE_CLASS} ${getRightPanelTabCloseButtonVisibilityClass(state)}`
}
