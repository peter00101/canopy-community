/**
 * 教程阅读器的纯逻辑（无 React / DOM 依赖，便于单测）。
 *
 * 阅读器挂在设置右侧，宽度随窗口与设置导航（220 / 277px）变化：
 * 最小窗口 800px 时只剩约 580px，宽屏可到 1600px 以上。
 * 目录因此按阅读器自身宽度摆放——够宽放左侧栏，窄时收到顶部折叠条。
 */

export type TutorialTocPlacement = 'side' | 'top'

/**
 * 目录放侧栏所需的最小阅读器宽度。
 * 侧栏占 208px + 左右 8px 外边距，正文至少留 ~730px 才不至于把配图和表格挤得太窄。
 */
export const TUTORIAL_SIDE_TOC_MIN_WIDTH = 960

export function resolveTutorialTocPlacement(width: number): TutorialTocPlacement {
  return Number.isFinite(width) && width >= TUTORIAL_SIDE_TOC_MIN_WIDTH ? 'side' : 'top'
}

/** 用户手动开关目录的记录；只对记录时的摆放方式生效 */
export interface TutorialTocChoice {
  placement: TutorialTocPlacement
  open: boolean
}

/**
 * 目录是否展开：
 * - 用户在当前摆放方式下手动开关过，以用户为准；
 * - 否则侧栏默认展开（地方够），顶部默认收起（不占正文首屏）。
 * 窗口拉宽 / 拉窄导致摆放方式变化时，回到新摆放方式的默认值。
 */
export function resolveTutorialTocOpen(
  placement: TutorialTocPlacement,
  choice: TutorialTocChoice | null,
): boolean {
  if (choice && choice.placement === placement) return choice.open
  return placement === 'side'
}

/** 目录条目（与 MarkdownToc 的 source 模式条目同形；line 只作稳定序号用） */
export interface TutorialTocEntry {
  id: string
  level: number
  text: string
  line: number
}

export function toTutorialTocEntries(
  headings: ReadonlyArray<{ id: string; level: number; text: string }>,
): TutorialTocEntry[] {
  return headings.map((heading, index) => ({
    id: heading.id,
    level: heading.level,
    text: heading.text,
    line: index,
  }))
}

/** 顶部折叠条上显示的「当前章节」：优先滚动联动命中的标题，未命中时不显示 */
export function getTutorialCurrentSectionLabel(
  entries: ReadonlyArray<TutorialTocEntry>,
  activeId: string | null,
): string | null {
  if (!activeId) return null
  return entries.find((entry) => entry.id === activeId)?.text ?? null
}

/** 目录缩进用：当前条目相对最浅一级标题的层级差 */
export function getTutorialTocMinLevel(entries: ReadonlyArray<TutorialTocEntry>): number {
  if (entries.length === 0) return 1
  return entries.reduce((min, entry) => Math.min(min, entry.level), Number.POSITIVE_INFINITY)
}

export interface HeadingScrollInput {
  /** 标题元素 getBoundingClientRect().top */
  headingTop: number
  /** 滚动容器 getBoundingClientRect().top */
  containerTop: number
  /** 滚动容器当前 scrollTop */
  scrollTop: number
  /** 标题距容器顶部留的空隙 */
  offset?: number
}

/**
 * 跳转到标题时滚动容器应滚到的位置：用视口坐标差换算，不依赖 offsetParent 链
 * （阅读器外层有 transform 入场动画与 flex 嵌套，offsetTop 不可靠）。
 */
export function computeHeadingScrollTop({
  headingTop,
  containerTop,
  scrollTop,
  offset = 8,
}: HeadingScrollInput): number {
  const top = headingTop - containerTop + scrollTop - offset
  if (!Number.isFinite(top)) return 0
  return Math.max(Math.round(top), 0)
}
