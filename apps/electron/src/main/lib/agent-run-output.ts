import type { SDKMessage } from '@canopy/shared'

/**
 * 判定一批已落盘消息里是否有「实质产出」——run 零产出留痕的依据。
 * abort 挂死流时 Pi 会生成一条内容全空的 aborted assistant，它对用户毫无信息量，
 * 不能算产出，否则「已读不回」的留痕会被这条空壳顶掉（2026-08-31 E2E 实测踩到）。
 */
export function hasSubstantiveRunOutput(messages: SDKMessage[]): boolean {
  return messages.some((m) => {
    if (m.type === 'result' || m.type === 'system') return true
    const content = (m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content
    if (!Array.isArray(content)) return false
    return content.some((b) => {
      if (b.type === 'tool_use' || b.type === 'tool_result') return true
      if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0
      if (b.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.trim().length > 0
      return false
    })
  })
}
