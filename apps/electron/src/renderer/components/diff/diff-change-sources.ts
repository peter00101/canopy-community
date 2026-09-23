import type { ChangeSource } from '@canopy/shared'

export interface DiffChangeSourceEntry {
  source?: ChangeSource
}

/** 改动来源按稳定顺序展示，避免筛选或刷新时 badge 跳动。 */
const DIFF_CHANGE_SOURCE_ORDER: readonly ChangeSource[] = [
  'session',
  'workspace',
  'both',
  'none',
]

/** 文件来源 badge 的颜色和文案。 */
export const DIFF_CHANGE_SOURCE_CONFIG: Record<ChangeSource, { color: string; label: string }> = {
  // 三类来源各占主题色族一档（配色体系），不再是固定的蓝 / 紫 / 青
  session: { color: 'bg-palette-1/15 text-palette-1', label: '会话文件' },
  workspace: { color: 'bg-palette-6/15 text-palette-6', label: '项目文件' },
  both: { color: 'bg-palette-2/15 text-palette-2', label: '会话+项目文件' },
  none: { color: 'bg-muted text-muted-foreground', label: '附加目录文件' },
}

/** 聚合一个 Git 仓库内的来源类型；未追踪文件不会伪造来源。 */
export function collectDiffChangeSources(entries: readonly DiffChangeSourceEntry[]): ChangeSource[] {
  const sources = new Set<ChangeSource>()
  for (const entry of entries) {
    if (entry.source) sources.add(entry.source)
  }
  return DIFF_CHANGE_SOURCE_ORDER.filter((source) => sources.has(source))
}
