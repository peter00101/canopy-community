/**
 * 视频助手端点派生（纯逻辑，零 Electron 依赖，方便直接单元测试）。
 *
 * kimi-api 渠道 baseUrl 为 `https://api.moonshot.cn/anthropic`：
 * 消息端点挂在 baseUrl 下（`{baseUrl}/v1/messages`），
 * 文件端点挂在源站根下（`{origin}/v1/files`）——2026-08 实测验证。
 */

export interface VideoRelayEndpoints {
  /** OpenAI 兼容文件上传端点（多部分表单，purpose=video） */
  uploadUrl: string
  /** Anthropic 协议消息端点（video 内容块在此发送） */
  messagesUrl: string
  /** 删除已上传文件的端点 */
  deleteUrl: (fileId: string) => string
}

export function deriveVideoRelayEndpoints(baseUrl: string): VideoRelayEndpoints | undefined {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return undefined
  }
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  const filesBase = `${parsed.origin}/v1/files`
  return {
    uploadUrl: filesBase,
    messagesUrl: `${trimmedBase}/v1/messages`,
    deleteUrl: (fileId: string) => `${filesBase}/${encodeURIComponent(fileId)}`,
  }
}
