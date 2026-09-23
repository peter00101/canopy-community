import { describe, expect, test } from 'bun:test'
import { isRetryableAssistantError, retryAssistantCall, type AssistantMessage } from '@earendil-works/pi-ai/compat'

function failedAssistant(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
  } as unknown as AssistantMessage
}

describe('Pi native retry classifier', () => {
  test('classifies an OpenAI Responses terminal-event stream interruption as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('OpenAI Responses stream ended before a terminal response event'),
    )).toBe(true)
  })

  test('classifies an OpenAI-compatible terminal-event stream interruption as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('Error Code undefined: Upstream Responses stream ended before a terminal event'),
    )).toBe(true)
  })

  test('classifies a corrupted upstream JSON response as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'),
    )).toBe(true)
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
    'Connection error. Failed to fetch',
    'TypeError: Failed to fetch',
  ])('classifies transient transport interruption "%s" as retryable', (errorMessage) => {
    expect(isRetryableAssistantError(failedAssistant(errorMessage))).toBe(true)
  })

  test('retries Failed to fetch through Pi’s actual native retry loop', async () => {
    let calls = 0
    const result = await retryAssistantCall(async () => {
      calls += 1
      return calls === 1
        ? failedAssistant('TypeError: Failed to fetch')
        : { role: 'assistant', content: [], stopReason: 'stop' } as unknown as AssistantMessage
    }, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)

    expect(calls).toBe(2)
    expect(result.stopReason).toBe('stop')
  })

  test('does not broadly retry unrelated stream-ended errors', () => {
    expect(isRetryableAssistantError(
      failedAssistant('stream ended before the model emitted a local marker'),
    )).toBe(false)
  })

  // 中转网关注入 Claude Code system prompt 时，顶层 system 已被我方占用，它只能把注入内容
  // 塞进 messages 数组；同一网关后面部分上游渠道不接受 messages 里的 system role 而报 400。
  // 换一条渠道即可成功，属渠道级瞬时故障——2026-09-21 实测：同一请求的失败率随渠道池健康度
  // 在 0%～25% 之间摆动。这两条串必须留在 pi-ai patch 里，升级 Pi 时不能丢。
  describe('中转网关注入 system 导致的渠道级 400', () => {
    test.each([
      "status_code=400, messages.1: role 'system' must precede an 'assistant' message or end the array; the directive-only form (content: [] with output_config) is accepted at any position (request id: 202609210559129122883838268d9d6RPmeW8i3)",
      "role 'system' is not supported on this model (request id: 202609210618264864050168268d9d6mUfNGREC)",
      'messages.2: role "system" must precede an "assistant" message',
    ])('Given 网关注入 system 引发的 400 When 判定 Then 可重试（换渠道即自愈）', (errorMessage) => {
      expect(isRetryableAssistantError(failedAssistant(errorMessage))).toBe(true)
    })

    test.each([
      'messages.0.content: field required',
      'messages.1: content must be a non-empty array',
      'model not found: claude-nonexistent',
      'invalid api key provided',
    ])('Given 与注入无关的确定性请求错误 "%s" When 判定 Then 不重试（必须快速失败）', (errorMessage) => {
      expect(isRetryableAssistantError(failedAssistant(errorMessage))).toBe(false)
    })

    test('Given 该类 400 When 走 Pi 真实重试循环 Then 第二发成功、对上层透明', async () => {
      let calls = 0
      const result = await retryAssistantCall(async () => {
        calls += 1
        return calls === 1
          ? failedAssistant("status_code=400, messages.1: role 'system' must precede an 'assistant' message or end the array")
          : { role: 'assistant', content: [], stopReason: 'stop' } as unknown as AssistantMessage
      }, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)

      expect(calls).toBe(2)
      expect(result.stopReason).toBe('stop')
    })
  })

  test('keeps non-transient quota failures non-retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('429 insufficient_quota: billing limit reached'),
    )).toBe(false)
  })

  // 上游 #2081 随 Pi 0.86.1 在 patch 里新增的整词串；Pi 0.86.1 与上游源码里都没找到它的产生点，
  // 按整词精确匹配、不会误伤，照收。
  describe('stream_read_error（收上游 #2081）', () => {
    test('Given 错误文本带 stream_read_error 错误码 When 判定 Then 可重试', () => {
      expect(isRetryableAssistantError(failedAssistant('stream_read_error: failed to read upstream stream'))).toBe(true)
      expect(isRetryableAssistantError(failedAssistant('{"error":{"type":"stream_read_error"}}'))).toBe(true)
    })

    test('Given 只是包含相近字样而非整词 When 判定 Then 不重试（\\b 词边界生效）', () => {
      expect(isRetryableAssistantError(failedAssistant('my_stream_read_errors_counter overflow'))).toBe(false)
    })
  })
})
