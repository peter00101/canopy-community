import type { TerminalOutputEvent } from '@canopy/shared'

/**
 * 小块先攒在尾部零件里，攒够这个长度再合并成一个扁平块。块数因此有上界
 * （≈ maxChars / 64K），既不会像旧实现那样每来一块就把整个 1M 字符串重新拷一遍，
 * 也不会在「每 16ms 一个字节」的长时间小块流下让块数无限膨胀。
 */
const SEALED_CHUNK_MIN_CHARS = 65_536

/**
 * 单终端的有限回放缓冲：TerminalRead 与终端标签重挂载（getTerminalSnapshot）都从这里读。
 *
 * 只保留末尾 maxChars 个原始 PTY 字符；startOffset / endOffset 是它们在完整输出流中的
 * 字符偏移，缓冲滚动后调用方依然能明确知道可用范围。对外可观察的 text() 与三个偏移量
 * 与 0.18.63 之前「整串拼接再 slice」的实现逐一相同（有差分测试钉住），只是追加不再
 * O(缓冲长度)：追加把新块推到尾部，超上限从最老的块裁，读取时才拼接一次。
 */
export class TerminalOutputBuffer {
  /** 已封存的扁平块；下标小于 head 的是逻辑上已裁掉、等待压缩的旧块。 */
  private sealed: string[] = []
  private head = 0
  /** sealed[head..] 的总字符数。 */
  private sealedLength = 0
  /** 尚未封存的尾部零件及其总字符数。 */
  private tailParts: string[] = []
  private tailLength = 0
  /** 单终端最后接收的输出事件序号。 */
  sequence = 0
  /** 当前保留内容在该终端完整输出流中的起始字符偏移。 */
  startOffset = 0
  /** 完整输出流截至目前的字符偏移（exclusive）。 */
  endOffset = 0

  constructor(private readonly maxChars: number) {}

  /** 当前仍保留在内存中的字符数。 */
  get retainedLength(): number {
    return this.sealedLength + this.tailLength
  }

  /** 追加一块输出；序列号始终对应最后一批已接收数据（空块也推进它）。 */
  append(event: TerminalOutputEvent): void {
    this.sequence = event.sequence
    this.endOffset += event.data.length
    if (event.data.length > 0) {
      this.tailParts.push(event.data)
      this.tailLength += event.data.length
      if (this.tailLength >= SEALED_CHUNK_MIN_CHARS) this.sealTail()
      this.trim()
    }
    this.startOffset = this.endOffset - this.retainedLength
  }

  /** 拼接出当前保留的全部原始输出（≤ maxChars 个字符）；只在读取时调用。 */
  text(): string {
    const sealedText = this.head === 0 ? this.sealed.join('') : this.sealed.slice(this.head).join('')
    return this.tailLength > 0 ? sealedText + this.tailParts.join('') : sealedText
  }

  /** 当前内部块数（诊断与测试用）。 */
  chunkCount(): number {
    return this.sealed.length - this.head + (this.tailLength > 0 ? 1 : 0)
  }

  private sealTail(): void {
    if (this.tailLength === 0) return
    const only = this.tailParts.length === 1 ? this.tailParts[0] : undefined
    this.sealed.push(only ?? this.tailParts.join(''))
    this.sealedLength += this.tailLength
    this.tailParts = []
    this.tailLength = 0
  }

  /** 超过上限时从最老的块开始裁；封存块用完再封存尾部继续裁。 */
  private trim(): void {
    let excess = this.retainedLength - this.maxChars
    while (excess > 0) {
      if (this.head >= this.sealed.length) this.sealTail()
      const chunk = this.sealed[this.head]
      if (chunk === undefined) break
      if (chunk.length <= excess) {
        excess -= chunk.length
        this.sealedLength -= chunk.length
        this.head += 1
      } else {
        this.sealed[this.head] = chunk.slice(excess)
        this.sealedLength -= excess
        excess = 0
      }
    }
    if (this.head > 0 && this.head * 2 >= this.sealed.length) {
      this.sealed = this.sealed.slice(this.head)
      this.head = 0
    }
  }
}

export interface TerminalOutputReadOptions {
  /** 从完整输出流的指定字符偏移开始读取；省略时读取末尾。 */
  offset?: number
  /** 最多返回的原始 PTY 字符数。 */
  limit?: number
}

export interface TerminalOutputReadResult {
  /** 供 Agent 阅读的、去除终端控制序列后的文本。 */
  output: string
  /** 当前内存缓冲仍可读取的完整输出流起始偏移。 */
  availableStartOffset: number
  /** 当前完整输出流的末尾偏移（exclusive）。 */
  availableEndOffset: number
  /** 本次读取的原始输出范围起点。 */
  offset: number
  /** 下一页应传入的 offset。 */
  nextOffset: number
  /** 缓冲区之前已有输出因容量限制不可用，或本次默认从末尾读取而省略了前文。 */
  truncatedBefore: boolean
  /** 当前缓冲区中还有未读取的后续输出。 */
  truncatedAfter: boolean
}

const DEFAULT_READ_CHARS = 12_000
const MAX_READ_CHARS = 48_000

/**
 * 从有限的 PTY 回放缓冲中分页读取终端文本。
 * offset 使用原始 PTY 流的字符偏移，因而即使缓冲滚动也能明确告知调用方可用范围。
 */
export function readTerminalOutput(
  buffer: TerminalOutputBuffer,
  options: TerminalOutputReadOptions = {},
): TerminalOutputReadResult {
  const limit = normalizeLimit(options.limit)
  const requestedOffset = normalizeOffset(options.offset)
  const defaultOffset = Math.max(buffer.startOffset, buffer.endOffset - limit)
  const offset = clamp(requestedOffset ?? defaultOffset, buffer.startOffset, buffer.endOffset)
  const nextOffset = Math.min(buffer.endOffset, offset + limit)
  const rawOutput = buffer.text().slice(offset - buffer.startOffset, nextOffset - buffer.startOffset)

  return {
    output: normalizeTerminalText(rawOutput),
    availableStartOffset: buffer.startOffset,
    availableEndOffset: buffer.endOffset,
    offset,
    nextOffset,
    truncatedBefore: buffer.startOffset > 0 || offset > buffer.startOffset,
    truncatedAfter: nextOffset < buffer.endOffset,
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_CHARS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_CHARS) {
    throw new Error(`终端输出读取长度必须是 1 到 ${MAX_READ_CHARS} 之间的整数`)
  }
  return value
}

function normalizeOffset(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('终端输出偏移必须是非负整数')
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * PTY 输出含颜色、窗口标题、光标移动和 ZLE 重绘控制序列，直接交给模型会降低可读性。
 * 这是可读文本摘要而非终端模拟器：保留真实换行，但忽略孤立 \r 与其他光标操作，
 * 防止交互行重绘被误表现为多行命令回显。
 */
function normalizeTerminalText(output: string): string {
  return output
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '') // OSC（如窗口标题）
    .replace(/\u001BP[\s\S]*?\u001B\\/g, '') // DCS（如光标样式请求）
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '') // CSI（颜色、光标、清屏等）
    .replace(/\u001B[()][0-?]*[ -/]*[@-~]/g, '') // 字符集切换
    .replace(/\u001B[=>78DEHMNOVWXYZc]/g, '') // ESC 单字符控制（如 zsh 的 keypad mode）
    .replace(/\u001B(?:[ -/][0-~]?|[0-~])?/g, '') // 残留或不完整 ESC 序列
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '')
    .replace(/\r/g, '')
}
