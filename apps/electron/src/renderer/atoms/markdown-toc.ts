import { atomWithStorage } from 'jotai/utils'

/**
 * Markdown 预览目录（TOC）侧栏是否展开。
 *
 * 默认收起：预览以文档独占视图呈现（用户反馈：目录常开会把视觉重心拽到侧栏上）。
 * 用户手动开关后跨启动记忆（工具栏「显示目录」按钮与面板内折叠钮都写这里）。
 */
export const markdownTocOpenAtom = atomWithStorage<boolean>(
  'canopy-markdown-toc-open',
  false,
  undefined,
  { getOnInit: true },
)
