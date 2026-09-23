/**
 * 本轮工具调用触及的文件路径提取（纯逻辑，供 TurnFileChangesSummary 与正文文件引用补全使用）。
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@canopy/shared'

/**
 * ⚠️ 0.18.60 新增的 Office 工具族当初漏登记（0.18.67 补）：Agent 改完 .xlsx/.docx
 * 后本轮汇总 chip 整排不出现。它们的路径入参是驼峰 `filePath`，`getFilePath` 已认。
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'OfficeCreate', 'OfficeEdit', 'OfficeBatch',
])

/**
 * 本轮"触碰过"的工具集合（改 + 读）——用于正文内联文件引用的路径补全，比 MUTATING_TOOLS 更宽。
 * Read 的 input.file_path 与 Edit/Write 同构，都是绝对路径，可零解析纳入映射。
 * Grep/Glob 的 input 只有 pattern、命中文件仅存在于 tool_result 中，暂不纳入。
 * OfficeInspect 与 Read 同性质（只读且入参含目标文件），一并纳入。
 * 注意：底部"文件改动汇总"chip 仍只用 MUTATING_TOOLS，不受此集合影响。
 */
export const TOUCHED_TOOLS: ReadonlySet<string> = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read',
  'OfficeCreate', 'OfficeEdit', 'OfficeBatch', 'OfficeInspect',
])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

export function collectTurnFilePaths(turnMessages: SDKMessage[], tools: ReadonlySet<string> = MUTATING_TOOLS): string[] {
  // 只有已返回且未报错的工具调用才能作为文件证据（上游 #2069）。
  // 旧口径是「排除报错的」：流式过程中尚未返回的 tool_use、以及被权限拒绝后错误结果落在轮外的
  // 调用，都会被提前当成「已改动的文件」渲染成可点击 chip，而那时文件可能根本不存在。
  const succeeded = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error !== true) succeeded.add(rb.tool_use_id)
    }
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (!tools.has(tu.name)) continue
      if (!succeeded.has(tu.id)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/**
 * 构建「文件名 → 绝对路径」映射，供消息正文内联文件引用补全裸文件名使用。
 * 数据源为本轮"触碰过"的文件（TOUCHED_TOOLS：改过 + Read 读过），比底部改动汇总更宽，
 * 覆盖"本轮只读过没改就在正文引用"的高频场景；拿到的都是绝对路径。
 * 同名不同目录的文件无法凭裸文件名区分，直接从映射中剔除，交由既有 basePaths 解析逻辑处理
 * （不比补全前更差）。
 */
export function buildTurnFileNameMap(turnMessages: SDKMessage[]): Map<string, string> {
  const paths = collectTurnFilePaths(turnMessages, TOUCHED_TOOLS)
  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p
    if (conflicted.has(name)) continue
    const existing = map.get(name)
    if (existing && existing !== p) {
      map.delete(name)
      conflicted.add(name)
      continue
    }
    map.set(name, p)
  }
  return map
}
