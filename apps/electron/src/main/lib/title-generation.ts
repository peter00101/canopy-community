/** 标题生成 Prompt */
export const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。如果消息内容过短或无明确主题，直接使用原始消息作为标题。\n\n用户消息：'

/** 短消息阈值：低于此长度直接使用原文作为标题 */
export const SHORT_MESSAGE_THRESHOLD = 4

/** 最大标题长度 */
export const MAX_TITLE_LENGTH = 20

const TITLE_PUNCTUATION = /^["'“”‘’「《]+|["'“”‘’」》]+$/g
const MARKDOWN_PREFIX = /^(?:[#>*\-\d.)]\s*)+/
const WHITESPACE = /\s+/g

/**
 * 从模型返回的原始标题内容中提取文本。
 *
 * OpenAI 兼容端点（如 OpenCode Go）对推理模型可能把 `message.content` 返回为
 * 字符串、内容块数组（`[{ type: 'text', text: '...' }]`）或空值。逐个归一为
 * 纯文本，避免 `.trim()` 在非字符串上抛异常，导致整个标题生成在 catch 里静默丢弃。
 */
function extractTitleText(title: unknown): string {
  if (typeof title === 'string') return title
  if (Array.isArray(title)) {
    return title
      .map((block) => {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .join('')
      .trim()
  }
  if (title && typeof title === 'object' && typeof (title as { text?: unknown }).text === 'string') {
    return (title as { text: string }).text
  }
  return ''
}

/** 清理模型返回的标题。兼容字符串与内容块数组，非文本内容返回 null。 */
export function sanitizeGeneratedTitle(title: string | unknown): string | null {
  const text = extractTitleText(title)
  const cleaned = text.trim().replace(TITLE_PUNCTUATION, '').trim()
  return cleaned.slice(0, MAX_TITLE_LENGTH) || null
}

/**
 * 无法调用标题模型时，基于首条用户消息生成一个稳定兜底标题。
 *
 * ChatGPT (Codex) OAuth 使用 Pi SDK 的 Codex Responses 协议，不适配当前
 * @canopy/core 的 Chat Completions / Messages 标题请求，因此需要本地兜底，
 * 避免会话长期停留在“新 Agent 会话”。
 */
export function createFallbackTitle(userMessage: string): string | null {
  const firstLine = userMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?? userMessage.trim()

  const cleaned = firstLine
    .replace(MARKDOWN_PREFIX, '')
    .replace(WHITESPACE, ' ')
    .trim()

  return cleaned.slice(0, MAX_TITLE_LENGTH) || null
}

/**
 * 标题请求失败 / 返回空标题时，是否退回本地首行兜底名。
 *
 * 只对「通用兼容渠道」放行——这三类的请求地址、响应结构都由第三方网关决定，我方无法假定
 * 其符合协议：`custom` 与 `anthropic-compatible` 要求用户填写完整请求端点（填成协议根就会
 * 打到网关首页），`opencode-go-openai` 的推理模型可能把预算全花在推理上返回空正文。
 *
 * ⚠️ `anthropic-compatible` 是 0.18.67 补进来的：维护者的中转站渠道 Base URL 填成了裸域名，
 * 标题请求打到网关首页拿回 HTML，取不到标题后**直接返回 null**，会话永远停在「新 Agent 会话」，
 * 且全程零提示——用户的感知是「自动命名没了」。主对话不受影响（走 Pi SDK，SDK 自己拼端点），
 * 因此从表面完全看不出渠道配错。
 *
 * 自营 / 官方协议渠道不放行：那些地址由我方或供应商固定，失败通常是真故障，
 * 用兜底名盖住反而会掩盖问题。
 */
const FALLBACK_TITLE_PROVIDERS: ReadonlySet<string> = new Set([
  'opencode-go-openai',
  'custom',
  'anthropic-compatible',
])

export function shouldUseFallbackTitle(provider: string): boolean {
  return FALLBACK_TITLE_PROVIDERS.has(provider)
}
