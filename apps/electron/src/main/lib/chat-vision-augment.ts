/**
 * Chat 模式视觉补齐（纯逻辑层）
 *
 * 当用户给不支持图片输入的模型（DeepSeek V4 或用户在视觉助手页勾选的模型）发图时，
 * 先用视觉助手配置的视觉模型把图片转成文字描述，再以文本块注入消息，
 * 使纯文本模型也能"看图"（思路来源：deepseek-vision 的视觉中间件）。
 *
 * 本模块不依赖 Electron / 文件系统，方便直接单元测试；
 * 视觉调用通过 VisionDescriber 注入（生产实现见 vision-relay-service）。
 */

import type { FileAttachment } from '@canopy/shared'

/** 单次请求最多补齐的图片数量（超出部分注入占位文本，控制成本与时延） */
export const MAX_VISION_IMAGES = 6

/** 单次请求最多补齐的视频数量（视频上传与理解开销远大于图片，上限更低） */
export const MAX_VIDEO_ATTACHMENTS = 2

/** 无描述可用（生成失败 / 超限 / 存量历史）时注入的占位文本 */
export const VISION_PLACEHOLDER = '[图片内容不可用]'

/** 视频无描述可用时注入的占位文本 */
export const VIDEO_PLACEHOLDER = '[视频内容不可用]'

/** 视觉补齐进度合成工具名（仅用于前端进度指示，不持久化） */
export const VISION_AUGMENT_TOOL_NAME = 'VisionAugment'

/** 视频补齐进度合成工具名（仅用于前端进度指示，不持久化） */
export const VIDEO_AUGMENT_TOOL_NAME = 'VideoAugment'

/**
 * 视觉描述生成器。
 *
 * 输入单个图片附件与聚焦指令，返回可注入的文字描述；
 * 失败（模型异常 / 图片无法解码）返回 undefined，由调用方走占位逻辑。
 */
export type VisionDescriber = (
  attachment: FileAttachment,
  instruction: string | undefined,
  signal?: AbortSignal,
) => Promise<string | undefined>

/** 判定图片附件（与 attachment-service 的 MIME 白名单一致，此处按前缀宽松判定即可） */
function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}

/** 判定视频附件（同上，按前缀宽松判定） */
function isVideoMediaType(mediaType: string): boolean {
  return mediaType.startsWith('video/')
}

/**
 * 为附件列表补齐视觉描述。
 *
 * - 只处理无 visionDescription 缓存的图片附件，最多 MAX_VISION_IMAGES 张，并行调用；
 * - 单图失败不影响其他图片，也不写入缓存（下次重发可重试）；
 * - 返回新数组（不修改入参）；若无任何新描述生成，原样返回入参引用，
 *   调用方可用引用比较判断是否需要持久化写回。
 */
export async function fillVisionDescriptions(
  attachments: FileAttachment[] | undefined,
  describe: VisionDescriber,
  instruction: string | undefined,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<FileAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return attachments

  const targets = attachments
    .filter((att) => isImageMediaType(att.mediaType) && !att.visionDescription)
    .slice(0, MAX_VISION_IMAGES)
  if (targets.length === 0) return attachments

  onProgress?.(0, targets.length)
  let done = 0
  const descriptionByAttachmentId = new Map<string, string>()

  await Promise.all(targets.map(async (att) => {
    try {
      const description = await describe(att, instruction, signal)
      if (description && description.trim()) {
        descriptionByAttachmentId.set(att.id, description.trim())
      }
    } catch {
      // 单图失败 → 不缓存，注入时走占位文本
    } finally {
      done++
      onProgress?.(done, targets.length)
    }
  }))

  if (descriptionByAttachmentId.size === 0) return attachments

  return attachments.map((att) => {
    const description = descriptionByAttachmentId.get(att.id)
    return description ? { ...att, visionDescription: description } : att
  })
}

/**
 * 为附件列表补齐视频描述。
 *
 * 与 fillVisionDescriptions 同构：只处理无 visionDescription 缓存的视频附件，
 * 最多 MAX_VIDEO_ATTACHMENTS 个，并行调用；单个失败不影响其他，也不写缓存；
 * 返回新数组，无新描述时原样返回入参引用。
 */
export async function fillVideoDescriptions(
  attachments: FileAttachment[] | undefined,
  describe: VisionDescriber,
  instruction: string | undefined,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<FileAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return attachments

  const targets = attachments
    .filter((att) => isVideoMediaType(att.mediaType) && !att.visionDescription)
    .slice(0, MAX_VIDEO_ATTACHMENTS)
  if (targets.length === 0) return attachments

  onProgress?.(0, targets.length)
  let done = 0
  const descriptionByAttachmentId = new Map<string, string>()

  await Promise.all(targets.map(async (att) => {
    try {
      const description = await describe(att, instruction, signal)
      if (description && description.trim()) {
        descriptionByAttachmentId.set(att.id, description.trim())
      }
    } catch {
      // 单个失败 → 不缓存，注入时走占位文本
    } finally {
      done++
      onProgress?.(done, targets.length)
    }
  }))

  if (descriptionByAttachmentId.size === 0) return attachments

  return attachments.map((att) => {
    const description = descriptionByAttachmentId.get(att.id)
    return description ? { ...att, visionDescription: description } : att
  })
}

/**
 * 把图片附件的文字描述以 <image> 文本块追加到消息文本。
 *
 * 格式与文档注入的 <file name="..."> 一致，index 提供"第 N 张图"语义：
 * `<image index="1" name="photo.png">描述文字</image>`
 *
 * 无缓存描述的图片注入占位文本（保证纯文本模型知道"这里有一张图但内容不可用"）。
 */
export function appendImageDescriptionBlocks(
  messageText: string,
  attachments: FileAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return messageText

  const images = attachments.filter((att) => isImageMediaType(att.mediaType))
  if (images.length === 0) return messageText

  const parts: string[] = [messageText]
  images.forEach((att, index) => {
    const body = att.visionDescription?.trim() || VISION_PLACEHOLDER
    parts.push(`\n<image index="${index + 1}" name="${att.filename}">\n${body}\n</image>`)
  })
  return parts.join('')
}

/**
 * 把视频附件的文字描述以 <video> 文本块追加到消息文本。
 *
 * 与 <image> 注入同构：`<video index="1" name="demo.mp4">描述文字</video>`；
 * 无缓存描述的视频注入占位文本。视频描述对所有对话模型注入（没有模型原生收视频）。
 */
export function appendVideoDescriptionBlocks(
  messageText: string,
  attachments: FileAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return messageText

  const videos = attachments.filter((att) => isVideoMediaType(att.mediaType))
  if (videos.length === 0) return messageText

  const parts: string[] = [messageText]
  videos.forEach((att, index) => {
    const body = att.visionDescription?.trim() || VIDEO_PLACEHOLDER
    parts.push(`\n<video index="${index + 1}" name="${att.filename}">\n${body}\n</video>`)
  })
  return parts.join('')
}

/**
 * 把视觉模型返回的结构化 JSON 渲染为可注入的描述字符串。
 *
 * 输入是视觉助手约定的 { answer, observations[], limitations[], extractedText? }
 * （见 vision-relay-service 的 system prompt）；容忍字段缺失。
 * 缓存与注入用的都是渲染后的字符串。
 */
export function renderVisionDescription(result: Record<string, unknown>): string | undefined {
  const answer = typeof result.answer === 'string' ? result.answer.trim() : ''
  const observations = Array.isArray(result.observations)
    ? result.observations.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : []
  const extractedText = typeof result.extractedText === 'string' ? result.extractedText.trim() : ''

  const parts: string[] = []
  if (answer) parts.push(answer)
  if (observations.length > 0) parts.push(`关键观察：${observations.join('；')}`)
  if (extractedText) parts.push(`图中文字：${extractedText}`)

  const rendered = parts.join('\n')
  return rendered.trim() ? rendered : undefined
}
