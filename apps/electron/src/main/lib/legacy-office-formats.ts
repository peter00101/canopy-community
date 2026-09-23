/**
 * 旧版 Office 97-2003 二进制格式的扩展名判定。
 *
 * 单独成文件、不引任何解析库：主进程里的工具与附件链路要在启动时就能判断格式，
 * 而 SheetJS / word-extractor 只应在后台解析线程（legacy-office-worker）里加载。
 */

import { extname } from 'node:path'

export type LegacyOfficeKind = 'document' | 'spreadsheet' | 'presentation'

const KIND_BY_EXTENSION: Readonly<Record<string, LegacyOfficeKind>> = {
  '.doc': 'document',
  '.dot': 'document',
  '.xls': 'spreadsheet',
  '.xlt': 'spreadsheet',
  '.ppt': 'presentation',
  '.pps': 'presentation',
  '.pot': 'presentation',
}

/** 按扩展名判断是不是旧版 Office 二进制格式（模板 / 放映变体与主格式同构） */
export function legacyOfficeKindOf(filePath: string): LegacyOfficeKind | null {
  return KIND_BY_EXTENSION[extname(filePath).toLowerCase()] ?? null
}

/** 旧版格式只读支持的 OfficeInspect 模式；get / query / issues / screenshot 依赖 OfficeCLI，旧格式做不了 */
export const LEGACY_INSPECT_MODES: ReadonlySet<string> = new Set(['outline', 'text', 'stats'])

/** 对应的新格式扩展名，用于提示用户另存 */
export function modernOfficeExtensionFor(kind: LegacyOfficeKind): '.docx' | '.xlsx' | '.pptx' {
  return kind === 'document' ? '.docx' : kind === 'spreadsheet' ? '.xlsx' : '.pptx'
}
