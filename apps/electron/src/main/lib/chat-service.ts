/**
 * AI 聊天流式服务（Electron 编排层）
 *
 * 负责 Electron 特定的操作：
 * - 查找渠道、解密 API Key
 * - 管理 AbortController
 * - 调用 @canopy/core 的 Provider 适配器系统
 * - 桥接 StreamEvent → webContents.send()
 * - 持久化消息到 JSONL + 更新索引
 * - 模块化工具的 function calling 循环（通过 ChatToolRegistry + ChatToolExecutor）
 *
 * 纯逻辑（消息转换、SSE 解析、请求构建）已抽象到 @canopy/core/providers。
 */

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { CHAT_IPC_CHANNELS, formatRetiredModelMessage, isRetiredModelId } from '@canopy/shared'
import type { ChatSendInput, ChatMessage, GenerateTitleInput, FileAttachment, ChatToolActivity } from '@canopy/shared'
import {
  getAdapter,
  streamSSE,
  fetchTitle,
} from '@canopy/core'
import type { ImageAttachmentData, ContinuationMessage } from '@canopy/core'
import { listChannels, resolveChannelRuntimeApiKey } from './channel-manager'
import { appendMessage, updateConversationMeta, getConversationMessages, updateMessageAttachments } from './conversation-manager'
import { readAttachmentAsBase64, isImageAttachment, isVideoAttachment } from './attachment-service'
import { extractTextFromAttachment, isDocumentAttachment } from './document-parser'
import { inspectAttachmentWithVisionRelay, isVisionRelayConfigured, shouldAugmentModel } from './vision-relay-service'
import { inspectVideoAttachmentWithVideoRelay, isVideoRelayConfigured } from './video-relay-service'
import {
  appendImageDescriptionBlocks,
  appendVideoDescriptionBlocks,
  fillVisionDescriptions,
  fillVideoDescriptions,
  renderVisionDescription,
  VISION_AUGMENT_TOOL_NAME,
  VIDEO_AUGMENT_TOOL_NAME,
} from './chat-vision-augment'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getEnabledTools } from './chat-tool-registry'
import { executeToolCalls } from './chat-tool-executor'
import { createFallbackTitle, sanitizeGeneratedTitle, SHORT_MESSAGE_THRESHOLD, TITLE_PROMPT } from './title-generation'

/** 活跃的 AbortController 映射（conversationId → controller） */
const activeControllers = new Map<string, AbortController>()

/** 最大工具续接轮数（安全上限，防止极端情况下的无限循环） */
const MAX_TOOL_ROUNDS = 999

// ===== 平台相关：图片附件读取器 =====

/**
 * 读取图片附件的 base64 数据
 *
 * 此函数作为 ImageAttachmentReader 注入给 core 层，
 * 因为文件系统读取属于 Electron 平台操作。
 */
function getImageAttachmentData(attachments?: FileAttachment[]): ImageAttachmentData[] {
  if (!attachments || attachments.length === 0) return []

  return attachments
    .filter((att) => isImageAttachment(att.mediaType))
    .map((att) => ({
      mediaType: att.mediaType,
      data: readAttachmentAsBase64(att.localPath),
    }))
}

/**
 * 视觉补齐模式下的图片读取器：恒返回空。
 *
 * 所有 core adapter 对当前消息与每条历史用户消息的附件都会调用 readImageAttachments，
 * 换成本读取器后，当前轮与历史轮的原始图片同时被抑制（描述以文本块注入），
 * 这是防止纯文本模型收到 image 块报 400 的唯一 choke point。
 */
const NO_IMAGES_READER = (): ImageAttachmentData[] => []

/** 生产视觉描述生成器：调视觉助手 + 渲染为可注入文本 */
async function describeAttachmentForChat(
  attachment: FileAttachment,
  instruction: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const outcome = await inspectAttachmentWithVisionRelay({ attachment, instruction, signal })
  if (!outcome.ok) {
    console.warn(`[聊天服务] 视觉补齐失败 (${attachment.filename}): ${outcome.code} ${outcome.message}`)
    return undefined
  }
  const inner = outcome.result.result
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return undefined
  return renderVisionDescription(inner as Record<string, unknown>)
}

/** 生产视频描述生成器：调视频助手 + 渲染为可注入文本（渲染器与视觉共用） */
async function describeVideoAttachmentForChat(
  attachment: FileAttachment,
  instruction: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const outcome = await inspectVideoAttachmentWithVideoRelay({ attachment, instruction, signal })
  if (!outcome.ok) {
    console.warn(`[聊天服务] 视频补齐失败 (${attachment.filename}): ${outcome.code} ${outcome.message}`)
    return undefined
  }
  const inner = outcome.result.result
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return undefined
  return renderVisionDescription(inner as Record<string, unknown>)
}

// ===== 文档附件文本提取 =====

/**
 * 为单条消息提取文档附件的文本内容
 *
 * 将非图片附件的文本内容提取后，以结构化格式追加到消息文本后面。
 * 图片附件由适配器层单独处理，这里只处理文档类附件。
 *
 * @param messageText 原始消息文本
 * @param attachments 消息的附件列表
 * @returns 包含文档文本的增强消息
 */
async function enrichMessageWithDocuments(
  messageText: string,
  attachments?: FileAttachment[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return messageText

  // 筛选出文档类附件（非图片）
  const docAttachments = attachments.filter((att) => isDocumentAttachment(att.mediaType))
  if (docAttachments.length === 0) return messageText

  const parts: string[] = [messageText]

  for (const att of docAttachments) {
    try {
      const text = await extractTextFromAttachment(att.localPath)
      if (text.trim()) {
        parts.push(`\n<file name="${att.filename}">\n${text}\n</file>`)
      } else {
        parts.push(`\n<file name="${att.filename}">\n[文件内容为空]\n</file>`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      console.warn(`[聊天服务] 文档提取失败: ${att.filename}`, error)
      parts.push(`\n<file name="${att.filename}">\n[文件内容提取失败: ${errorMsg}]\n</file>`)
    }
  }

  return parts.join('')
}

/**
 * 为单条消息注入附件的文本表示
 *
 * - 文档附件：提取文本以 <file> 块追加（原有行为）
 * - 图片附件：augmentVision 时以 <image> 块追加视觉描述（缓存缺失则占位），
 *   原始图片块由 NO_IMAGES_READER 抑制，纯文本模型只看到文字
 * - 视频附件：无条件以 <video> 块追加视频描述（没有对话模型能原生收视频，
 *   适配器层本就不会外发视频字节，无需 reader 抑制）
 *
 * @param messageText 原始消息文本
 * @param attachments 消息的附件列表
 * @param augmentVision 是否处于视觉补齐模式
 * @returns 包含附件文本的增强消息
 */
async function enrichMessageWithAttachments(
  messageText: string,
  attachments: FileAttachment[] | undefined,
  augmentVision: boolean,
): Promise<string> {
  const withDocuments = await enrichMessageWithDocuments(messageText, attachments)
  const withVideos = appendVideoDescriptionBlocks(withDocuments, attachments)
  if (!augmentVision) return withVideos
  return appendImageDescriptionBlocks(withVideos, attachments)
}

/**
 * 为历史消息列表注入文档附件文本
 *
 * 遍历历史消息，对包含文档/视频附件的用户消息进行文本增强；
 * augmentVision 时同时注入图片描述。视频/图片描述只读 visionDescription 缓存，
 * 命中用缓存、未命中用占位，绝不为历史附件重新调用视觉/视频模型。
 * 返回新的消息数组（不修改原始消息）。
 */
async function enrichHistoryWithDocuments(
  history: ChatMessage[],
  augmentVision = false,
): Promise<ChatMessage[]> {
  const enriched: ChatMessage[] = []

  for (const msg of history) {
    // 只对包含附件的用户消息进行文本增强
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      const hasDocuments = msg.attachments.some((att) => isDocumentAttachment(att.mediaType))
      const hasVideos = msg.attachments.some((att) => isVideoAttachment(att.mediaType))
      const hasImages = augmentVision && msg.attachments.some((att) => isImageAttachment(att.mediaType))
      if (hasDocuments || hasVideos || hasImages) {
        const enrichedContent = await enrichMessageWithAttachments(msg.content, msg.attachments, augmentVision)
        enriched.push({ ...msg, content: enrichedContent })
        continue
      }
    }
    enriched.push(msg)
  }

  return enriched
}

// ===== 上下文过滤 =====

/**
 * 根据分隔线和上下文长度裁剪历史消息
 *
 * 三层过滤：
 * 1. 分隔线过滤：仅保留最后一个分隔线之后的消息
 * 2. 轮数裁剪：按轮数（user+assistant = 1 轮）限制历史
 * 3. contextLength === 'infinite' 或 undefined 时保留全部
 */
function filterHistory(
  messageHistory: ChatMessage[],
  contextDividers?: string[],
  contextLength?: number | 'infinite',
): ChatMessage[] {
  // 过滤掉空内容的助手消息，避免发送无效消息给 API
  let filtered = messageHistory.filter(
    (msg) => !(msg.role === 'assistant' && !msg.content.trim()),
  )

  // 分隔线过滤：仅保留最后一个分隔线之后的消息
  if (contextDividers && contextDividers.length > 0) {
    const lastDividerId = contextDividers[contextDividers.length - 1]
    const dividerIndex = filtered.findIndex((msg) => msg.id === lastDividerId)
    if (dividerIndex >= 0) {
      filtered = filtered.slice(dividerIndex + 1)
    }
  }

  // 上下文长度过滤：按轮数裁剪
  if (typeof contextLength === 'number' && contextLength >= 0) {
    if (contextLength === 0) {
      return []
    }
    // 从后往前，收集 N 轮对话
    const collected: ChatMessage[] = []
    let roundCount = 0
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i] as ChatMessage
      collected.unshift(msg)
      // 每遇到一条 user 消息算一轮结束
      if (msg.role === 'user') {
        roundCount++
        if (roundCount >= contextLength) break
      }
    }
    return collected
  }

  // contextLength === 'infinite' 或 undefined 时保留全部
  return filtered
}

// ===== 核心流式函数 =====

/**
 * 发送消息并流式返回 AI 响应
 *
 * 通过 ChatToolRegistry 获取启用的工具定义，
 * 通过 ChatToolExecutor 统一执行工具调用。
 *
 * @param input 发送参数
 * @param webContents 渲染进程的 webContents 实例（用于推送事件）
 */
export async function sendMessage(
  input: ChatSendInput,
  webContents: WebContents,
): Promise<boolean> {
  const {
    conversationId, userMessage, channelId,
    modelId, systemMessage, contextLength, contextDividers, attachments,
    thinkingEnabled, thinkingLevel, enabledToolIds,
  } = input

  // 1. 查找渠道
  const channels = listChannels()
  const channel = channels.find((c) => c.id === channelId)
  if (!channel) {
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: '渠道不存在',
    })
    return false
  }

  // 官方已下线的模型：渠道配置里的条目已清掉，但历史对话仍可能记着它。发请求前说人话，
  // 不把网关「模型不存在」的原文甩给用户，也不静默换成别的模型。
  if (isRetiredModelId(modelId)) {
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: formatRetiredModelMessage(modelId),
    })
    return false
  }

  // Subscription OAuth uses Pi provider-specific transports, which Chat mode does
  // not currently implement. Keep this guard for historical conversations that
  // still reference a formerly selectable subscription model.
  if (channel.provider === 'openai-codex' || channel.provider === 'xai') {
    const providerName = channel.provider === 'xai' ? 'xAI（Grok OAuth）' : 'ChatGPT 订阅（Codex OAuth）'
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: `Chat 模式暂不支持 ${providerName}，请切换到 Agent 模式使用。`,
    })
    return false
  }

  // 2. 解密 API Key
  let apiKey: string
  try {
    apiKey = await resolveChannelRuntimeApiKey(channelId)
  } catch {
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: '解密 API Key 失败',
    })
    return false
  }

  // 3. 先读取历史消息（在追加用户消息之前，避免 adapter 重复发送当前消息）
  const fullHistory = getConversationMessages(conversationId)

  // 4. 构造用户消息（视觉补齐判定后再落盘）
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: userMessage,
    createdAt: Date.now(),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  }

  // 5. 过滤历史（提前到视觉补齐判定之前：需要知道上下文内是否有图片）
  const filteredHistory = filterHistory(fullHistory, contextDividers, contextLength)

  // 6. 视觉补齐判定：仅当上下文带图时才做异步能力查询（纯文本会话零额外开销）。
  // 命中（用户勾选或 catalog 判定不支持图片输入）且视觉助手已配置 → 补齐模式；
  // 命中但视觉助手未配置 → 不放任上游 400，落盘消息并给出可操作引导。
  const hasImageIn = (list?: FileAttachment[]): boolean =>
    !!list && list.some((att) => isImageAttachment(att.mediaType))
  const hasCurrentImage = hasImageIn(attachments)
  const hasAnyImage = hasCurrentImage
    || filteredHistory.some((msg) => msg.role === 'user' && hasImageIn(msg.attachments))
  let augmentMode = false
  if (hasAnyImage && await shouldAugmentModel(channelId, modelId)) {
    if (isVisionRelayConfigured()) {
      augmentMode = true
    } else {
      const guideMessage = '当前模型不支持图片输入。请在「设置 → 视觉助手」选择视觉模型（并勾选当前模型）后重试，或切换到支持视觉的模型。'
      appendMessage(conversationId, userMsg)
      // 与流式错误路径一致：持久化错误消息，切换对话或重启后仍可见
      appendMessage(conversationId, {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        model: modelId,
        stopped: true,
        error: guideMessage,
      })
      try {
        updateConversationMeta(conversationId, {})
      } catch {
        // 索引更新失败不影响主流程
      }
      webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
        conversationId,
        error: guideMessage,
      })
      return false
    }
  }

  // 6b. 视频补齐判定：视频没有任何对话模型能原生接收，一律经视频助手转描述。
  // 带视频但视频助手未配置 → 同视觉补齐的引导路径，不静默丢内容。
  const hasVideoIn = (list?: FileAttachment[]): boolean =>
    !!list && list.some((att) => isVideoAttachment(att.mediaType))
  const hasCurrentVideo = hasVideoIn(attachments)
  if (hasCurrentVideo && !isVideoRelayConfigured()) {
    const guideMessage = '发送视频需要先配置视频助手。请在「设置 → 视觉助手」的视频助手区块选择 Kimi 渠道的视频模型（如 kimi-k3）后重试。'
    appendMessage(conversationId, userMsg)
    appendMessage(conversationId, {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      model: modelId,
      stopped: true,
      error: guideMessage,
    })
    try {
      updateConversationMeta(conversationId, {})
    } catch {
      // 索引更新失败不影响主流程
    }
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: guideMessage,
    })
    return false
  }

  // 7. 创建 AbortController（提前到视觉补齐之前，使描述生成同样可被停止按钮中止）
  const controller = new AbortController()
  activeControllers.set(conversationId, controller)

  // 8. 追加用户消息到 JSONL（先落盘原始消息，视觉调用期间崩溃或中止不丢消息）
  appendMessage(conversationId, userMsg)

  // 在 try 外累积流式内容，abort 时 catch 块仍可访问
  let accumulatedContent = ''
  let accumulatedReasoning = ''
  const accumulatedToolActivities: ChatToolActivity[] = []
  const accumulatedGeneratedAttachments: FileAttachment[] = []

  try {
    // 9. 视觉补齐：为当前轮图片生成描述（并行、有上限、可中止），成功后写回持久化缓存。
    // 历史图片只读缓存不重新生成（见 enrichHistoryWithDocuments）。
    let attachmentsForSend = attachments
    if (augmentMode && hasCurrentImage) {
      const needsDescription = (attachments ?? []).some(
        (att) => isImageAttachment(att.mediaType) && !att.visionDescription,
      )
      const progressToolCallId = `vision-augment-${userMsg.id}`
      if (needsDescription) {
        // 瞬时进度指示（不推入 accumulatedToolActivities，不持久化）
        webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
          conversationId,
          activity: { type: 'start', toolName: VISION_AUGMENT_TOOL_NAME, toolCallId: progressToolCallId },
        })
      }
      const enrichedAttachments = await fillVisionDescriptions(
        attachments,
        describeAttachmentForChat,
        userMessage,
        controller.signal,
      )
      if (needsDescription) {
        webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
          conversationId,
          activity: {
            type: 'result',
            toolName: VISION_AUGMENT_TOOL_NAME,
            toolCallId: progressToolCallId,
            result: '已生成图片文字描述',
          },
        })
      }
      if (enrichedAttachments && enrichedAttachments !== attachments) {
        // 写回缓存：此刻 userMsg 是会话文件最后一行，assistant 消息尚未追加，无并发写者
        userMsg.attachments = enrichedAttachments
        updateMessageAttachments(conversationId, userMsg.id, enrichedAttachments)
        attachmentsForSend = enrichedAttachments
      }
    }

    // 9b. 视频补齐：为当前轮视频生成描述（上传→理解→删除远端，可中止），成功后写回缓存。
    // 历史视频只读缓存不重新生成（同图片策略）。
    if (hasCurrentVideo) {
      const needsVideoDescription = (attachmentsForSend ?? []).some(
        (att) => isVideoAttachment(att.mediaType) && !att.visionDescription,
      )
      const videoProgressToolCallId = `video-augment-${userMsg.id}`
      if (needsVideoDescription) {
        webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
          conversationId,
          activity: { type: 'start', toolName: VIDEO_AUGMENT_TOOL_NAME, toolCallId: videoProgressToolCallId },
        })
      }
      const enrichedWithVideos = await fillVideoDescriptions(
        attachmentsForSend,
        describeVideoAttachmentForChat,
        userMessage,
        controller.signal,
      )
      if (needsVideoDescription) {
        webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
          conversationId,
          activity: {
            type: 'result',
            toolName: VIDEO_AUGMENT_TOOL_NAME,
            toolCallId: videoProgressToolCallId,
            result: '已生成视频文字描述',
          },
        })
      }
      if (enrichedWithVideos && enrichedWithVideos !== attachmentsForSend) {
        userMsg.attachments = enrichedWithVideos
        updateMessageAttachments(conversationId, userMsg.id, enrichedWithVideos)
        attachmentsForSend = enrichedWithVideos
      }
    }

    // 10. 注入附件文本（文档 <file> 块；视频 <video> 描述块；补齐模式下追加图片 <image> 描述块）
    const enrichedHistory = await enrichHistoryWithDocuments(filteredHistory, augmentMode)
    const enrichedUserMessage = await enrichMessageWithAttachments(userMessage, attachmentsForSend, augmentMode)

    // 11. 获取适配器
    const adapter = getAdapter(channel.provider)

    // 12. 视觉补齐模式下抑制原始图片外发（当前轮与历史轮同时生效）
    const readImageAttachments = augmentMode ? NO_IMAGES_READER : getImageAttachmentData

    // 13. 从工具注册表获取启用的工具
    const { tools, systemPromptAppend } = getEnabledTools(enabledToolIds)

    // 注入工具系统提示词
    const effectiveSystemMessage = systemPromptAppend && systemMessage
      ? systemMessage + systemPromptAppend
      : systemPromptAppend
        ? systemPromptAppend
        : systemMessage

    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)

    // 14. 工具续接循环
    let continuationMessages: ContinuationMessage[] = []
    let round = 0
    /** 标记最近一轮是否执行了工具（用于判断是否需要最终响应轮） */
    let pendingToolResults = false

    /** 流式事件处理器（工具轮和最终响应轮复用） */
    const handleStreamEvent = (event: { type: string; delta?: string; toolCallId?: string; toolName?: string }): void => {
      switch (event.type) {
        case 'chunk':
          accumulatedContent += event.delta ?? ''
          webContents.send(CHAT_IPC_CHANNELS.STREAM_CHUNK, {
            conversationId,
            delta: event.delta,
          })
          break
        case 'reasoning':
          accumulatedReasoning += event.delta ?? ''
          webContents.send(CHAT_IPC_CHANNELS.STREAM_REASONING, {
            conversationId,
            delta: event.delta,
          })
          break
        case 'tool_call_start':
          accumulatedToolActivities.push({
            toolCallId: event.toolCallId!,
            toolName: event.toolName!,
            type: 'start',
          })
          webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
            conversationId,
            activity: { type: 'start', toolName: event.toolName!, toolCallId: event.toolCallId! },
          })
          break
        // done 事件在外部处理
      }
    }

    while (round < MAX_TOOL_ROUNDS) {
      round++
      pendingToolResults = false

      const request = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        history: enrichedHistory,
        userMessage: enrichedUserMessage,
        systemMessage: effectiveSystemMessage,
        attachments: attachmentsForSend,
        readImageAttachments,
        thinkingEnabled,
        thinkingLevel,
        tools,
        continuationMessages: continuationMessages.length > 0 ? continuationMessages : undefined,
      })

      const { content, reasoning, thinkingBlocks, toolCalls, stopReason } = await streamSSE({
        request,
        adapter,
        signal: controller.signal,
        fetchFn,
        onEvent: handleStreamEvent,
      })

      // 如果没有工具调用或不是 tool_use 停止，退出循环
      if (!toolCalls || toolCalls.length === 0 || stopReason !== 'tool_use') {
        break
      }

      // 执行工具调用（通过统一执行器）
      // 提取前一轮对话的附件（用于参考图支持）
      const lastUserMsg = fullHistory.filter((m) => m.role === 'user').at(-1)
      const lastAssistantMsg = fullHistory.filter((m) => m.role === 'assistant').at(-1)
      const toolResults = await executeToolCalls(toolCalls, {
        webContents,
        conversationId,
        currentAttachments: attachments,
        previousUserAttachments: lastUserMsg?.attachments,
        previousAssistantAttachments: lastAssistantMsg?.attachments,
      })

      // 累积工具结果到持久化数据
      for (const tc of toolCalls) {
        const tr = toolResults.find((r) => r.toolCallId === tc.id)
        if (tr) {
          accumulatedToolActivities.push({
            toolCallId: tc.id,
            toolName: tc.name,
            type: 'result',
            result: tr.content,
            isError: tr.isError,
            input: tc.arguments,
          })
          // 收集工具生成的附件（如生图工具的图片）
          if (tr.generatedAttachments) {
            accumulatedGeneratedAttachments.push(...tr.generatedAttachments)
          }
        }
      }

      // 构建续接消息
      // thinkingBlocks 保留服务端原始的 thinking 块结构（含签名），
      // 在思考+工具模式下必须原样回传给 Anthropic 协议家族（Anthropic/DeepSeek/Kimi）
      continuationMessages = [
        ...continuationMessages,
        { role: 'assistant' as const, content, reasoning, thinkingBlocks, toolCalls },
        { role: 'tool' as const, results: toolResults },
      ]
      pendingToolResults = true

      // 注意：不重置 accumulatedContent/accumulatedReasoning，跨轮次持续累积
    }

    // 15. 最终响应轮：如果因达到 MAX_TOOL_ROUNDS 退出但仍有待处理的工具结果，
    // 再发起一次 API 调用（不传 tools）让模型基于工具结果生成最终文本回复
    if (pendingToolResults && continuationMessages.length > 0) {
      console.log(`[聊天服务] 工具轮次已达上限 (${MAX_TOOL_ROUNDS})，发起最终响应轮`)

      const finalRequest = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        history: enrichedHistory,
        userMessage: enrichedUserMessage,
        systemMessage: effectiveSystemMessage,
        attachments: attachmentsForSend,
        readImageAttachments,
        thinkingEnabled,
        thinkingLevel,
        // 不传 tools，强制模型生成文本回复而非继续调用工具
        continuationMessages,
      })

      await streamSSE({
        request: finalRequest,
        adapter,
        signal: controller.signal,
        fetchFn,
        onEvent: handleStreamEvent,
      })
    }

    // 16. 保存 assistant 消息（空内容不保存，除非有生成的附件）
    const assistantMsgId = randomUUID()
    if (accumulatedContent.trim() || accumulatedGeneratedAttachments.length > 0) {
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: accumulatedContent,
        createdAt: Date.now(),
        model: modelId,
        reasoning: accumulatedReasoning || undefined,
        toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined,
        attachments: accumulatedGeneratedAttachments.length > 0 ? accumulatedGeneratedAttachments : undefined,
      }
      appendMessage(conversationId, assistantMsg)

      // 更新对话索引的 updatedAt
      try {
        updateConversationMeta(conversationId, {})
      } catch {
        // 索引更新失败不影响主流程
      }
    } else {
      console.warn(`[聊天服务] 模型返回空内容且无生成附件，跳过保存 (对话 ${conversationId})`)
    }

    webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, {
      conversationId,
      model: modelId,
      messageId: (accumulatedContent.trim() || accumulatedGeneratedAttachments.length > 0) ? assistantMsgId : undefined,
    })
    return true
  } catch (error) {
    // 被中止的请求：保存已输出的部分内容，通知前端停止
    if (controller.signal.aborted) {
      console.log(`[聊天服务] 对话 ${conversationId} 已被用户中止`)

      // 保存已累积的部分助手消息
      if (accumulatedContent) {
        const assistantMsgId = randomUUID()
        const partialMsg: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content: accumulatedContent,
          createdAt: Date.now(),
          model: modelId,
          reasoning: accumulatedReasoning || undefined,
          stopped: true,
          toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined,
        }
        appendMessage(conversationId, partialMsg)

        try {
          updateConversationMeta(conversationId, {})
        } catch {
          // 索引更新失败不影响主流程
        }

        webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, {
          conversationId,
          model: modelId,
          messageId: assistantMsgId,
        })
      } else {
        webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, {
          conversationId,
          model: modelId,
        })
      }
      return true
    }

    const errorMessage = error instanceof Error ? error.message : '未知错误'
    console.error(`[聊天服务] 流式请求失败:`, error)

    // 保存已累积的部分助手消息（与 abort 逻辑一致，防止内容丢失）
    if (accumulatedContent) {
      const assistantMsgId = randomUUID()
      const partialMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: accumulatedContent,
        createdAt: Date.now(),
        model: modelId,
        reasoning: accumulatedReasoning || undefined,
        stopped: true,
        error: errorMessage,
        toolActivities: accumulatedToolActivities.length > 0 ? accumulatedToolActivities : undefined,
      }
      appendMessage(conversationId, partialMsg)

      try {
        updateConversationMeta(conversationId, {})
      } catch {
        // 索引更新失败不影响主流程
      }
    } else {
      // 即使没有累积内容，也保存一条错误消息到 JSONL，
      // 确保切换对话或重启后错误仍然可见（而非仅靠临时 atom 横幅）
      const assistantMsgId = randomUUID()
      const errorMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        model: modelId,
        stopped: true,
        error: errorMessage,
      }
      appendMessage(conversationId, errorMsg)

      try {
        updateConversationMeta(conversationId, {})
      } catch {
        // 索引更新失败不影响主流程
      }
    }

    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: errorMessage,
    })
    return false
  } finally {
    activeControllers.delete(conversationId)
  }
}

/**
 * 中止指定对话的生成
 */
export function stopGeneration(conversationId: string): void {
  const controller = activeControllers.get(conversationId)
  if (controller) {
    controller.abort()
    activeControllers.delete(conversationId)
    console.log(`[聊天服务] 已中止对话: ${conversationId}`)
  }
}

/** 中止所有活跃的聊天流（应用退出时调用） */
export function stopAllGenerations(): void {
  if (activeControllers.size === 0) return
  console.log(`[聊天服务] 正在中止所有活跃对话 (${activeControllers.size} 个)...`)
  for (const [conversationId, controller] of activeControllers) {
    controller.abort()
    console.log(`[聊天服务] 已中止对话: ${conversationId}`)
  }
  activeControllers.clear()
}

// ===== 标题生成 =====

/**
 * 调用 AI 生成对话标题
 *
 * 使用与聊天相同的渠道和模型，发送非流式请求，
 * 让模型根据用户第一条消息生成简短标题。
 *
 * @param input 生成标题参数
 * @returns 生成的标题，失败时返回 null
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const { userMessage, channelId, modelId } = input
  console.log('[标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

  // 短消息直接使用原文作为标题，避免 AI 幻觉
  const trimmedMessage = userMessage.trim()
  if (trimmedMessage.length <= SHORT_MESSAGE_THRESHOLD) {
    const shortTitle = createFallbackTitle(trimmedMessage)
    console.log('[标题生成] 消息过短，直接使用原文作为标题:', shortTitle)
    return shortTitle
  }

  // 查找渠道
  const channels = listChannels()
  const channel = channels.find((c) => c.id === channelId)
  if (!channel) {
    console.warn('[标题生成] 渠道不存在:', channelId)
    return null
  }

  if (channel.provider === 'openai-codex') {
    const fallbackTitle = createFallbackTitle(userMessage)
    console.log('[标题生成] ChatGPT OAuth 渠道使用本地标题:', fallbackTitle)
    return fallbackTitle
  }

  // 解密 API Key
  let apiKey: string
  try {
    apiKey = await resolveChannelRuntimeApiKey(channelId)
  } catch {
    console.warn('[标题生成] 解密 API Key 失败')
    // OpenCode Go / 自定义渠道无法解密也仍要完成重命名，避免对话长期停在默认标题。
    return (channel.provider === 'opencode-go-openai' || channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
  }

  try {
    const adapter = getAdapter(channel.provider)
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      prompt: TITLE_PROMPT + userMessage,
    })

    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)
    const title = await fetchTitle(request, adapter, fetchFn)
    const result = title ? sanitizeGeneratedTitle(title) : null
    if (!result) {
      console.warn('[标题生成] API 未返回可用标题')
      // OpenCode Go / 自定义渠道的服务端偶发返回空标题时，仍要完成重命名，避免对话长期停在默认标题。
      return (channel.provider === 'opencode-go-openai' || channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
    }

    console.log('[标题生成] 成功生成标题:', result)
    return result
  } catch (error) {
    console.warn('[标题生成] 请求失败:', error)
    // OpenCode Go / 自定义渠道的服务端偶发返回空标题/异常响应/超时，异常路径同样要完成重命名。
    return (channel.provider === 'opencode-go-openai' || channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
  }
}
