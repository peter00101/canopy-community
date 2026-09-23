import { describe, expect, test } from 'bun:test'
import type { TerminalOutputEvent } from '@canopy/shared'
import { TerminalOutputBuffer, readTerminalOutput } from './terminal-output-buffer'

const event = (sequence: number, data: string): TerminalOutputEvent => ({ terminalId: 't', sequence, data })

/** 按顺序追加若干块后返回缓冲；maxChars 默认取生产值 1,000,000。 */
function build(chunks: string[], maxChars = 1_000_000): TerminalOutputBuffer {
  const buffer = new TerminalOutputBuffer(maxChars)
  chunks.forEach((data, index) => buffer.append(event(index + 1, data)))
  return buffer
}

/**
 * 0.18.63 及更早的实现（整串拼接再 slice），逐字照抄作为差分测试的参照物：
 * 新实现换了存储结构，但对外可观察的 text / 三个偏移 / sequence 必须与它逐一相同。
 */
interface ReferenceBuffer { output: string; sequence: number; startOffset: number; endOffset: number }
function referenceAppend(buffer: ReferenceBuffer, data: string, sequence: number, maxChars: number): ReferenceBuffer {
  const output = `${buffer.output}${data}`
  const retainedOutput = output.length > maxChars ? output.slice(output.length - maxChars) : output
  const endOffset = buffer.endOffset + data.length
  return { output: retainedOutput, sequence, startOffset: endOffset - retainedOutput.length, endOffset }
}

/** 可复现的伪随机数（LCG），差分测试用。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('终端回放缓冲：追加与裁剪', () => {
  test('Given 空缓冲 When 读取 Then 文本为空、偏移全 0、不标记截断', () => {
    const buffer = build([])
    expect(buffer.text()).toBe('')
    expect(readTerminalOutput(buffer)).toEqual({
      output: '', availableStartOffset: 0, availableEndOffset: 0, offset: 0, nextOffset: 0, truncatedBefore: false, truncatedAfter: false,
    })
  })

  test('Given 未超上限的多块 When 追加 Then 文本按到达顺序拼接、sequence 取最后一块、startOffset 为 0', () => {
    const buffer = build(['abc', 'de', '', 'f'])
    expect(buffer.text()).toBe('abcdef')
    expect(buffer.sequence).toBe(4)
    expect(buffer.startOffset).toBe(0)
    expect(buffer.endOffset).toBe(6)
  })

  test('Given 累计超过上限 When 追加 Then 只保留末尾 maxChars 个字符，startOffset 随之前移，endOffset 记完整流长度', () => {
    const buffer = build(['0123456789', 'abcdef'], 8)
    expect(buffer.text()).toBe('89abcdef')
    expect(buffer.startOffset).toBe(8)
    expect(buffer.endOffset).toBe(16)
  })

  test('Given 单块本身就超过上限 When 追加 Then 只留该块尾部', () => {
    const buffer = build(['x'.repeat(5), 'y'.repeat(20)], 8)
    expect(buffer.text()).toBe('y'.repeat(8))
    expect(buffer.startOffset).toBe(17)
    expect(buffer.endOffset).toBe(25)
  })

  test('Given 裁剪恰好落在块边界 When 追加 Then 整块丢弃、不残留空块', () => {
    const buffer = build(['aaaa', 'bbbb', 'cccc'], 8)
    expect(buffer.text()).toBe('bbbbcccc')
    expect(buffer.startOffset).toBe(4)
  })

  test('Given 大量小块累计到上限 When 持续追加 Then 保留长度恒等于上限、内部块数被合并压住（不随小块数线性增长）', () => {
    const buffer = new TerminalOutputBuffer(100_000)
    for (let sequence = 1; sequence <= 300_000; sequence += 1) buffer.append(event(sequence, 'x'))
    expect(buffer.text().length).toBe(100_000)
    expect(buffer.startOffset).toBe(200_000)
    expect(buffer.endOffset).toBe(300_000)
    expect(buffer.chunkCount()).toBeLessThan(64)
  })

  test('差分：随机块序列下 text / startOffset / endOffset / sequence 与旧实现逐一相同', () => {
    const sizes = [0, 1, 2, 12, 13, 100, 4095, 4096, 4097, 65_535, 65_536, 65_537, 70_000, 300_000, 999_999, 1_000_000, 1_000_001, 1_500_000]
    const limits = [1, 13, 1000, 65_536, 1_000_000]
    let checked = 0
    for (let seed = 1; seed <= 12; seed += 1) {
      const random = lcg(seed)
      const maxChars = limits[Math.floor(random() * limits.length)] ?? 1000
      const buffer = new TerminalOutputBuffer(maxChars)
      let reference: ReferenceBuffer = { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
      const rounds = 40
      for (let sequence = 1; sequence <= rounds; sequence += 1) {
        const size = sizes[Math.floor(random() * sizes.length)] ?? 0
        const glyph = String.fromCharCode(97 + (sequence % 26))
        const data = size > 0 ? glyph.repeat(size) : ''
        buffer.append(event(sequence, data))
        reference = referenceAppend(reference, data, sequence, maxChars)
        expect(buffer.sequence).toBe(reference.sequence)
        expect(buffer.startOffset).toBe(reference.startOffset)
        expect(buffer.endOffset).toBe(reference.endOffset)
        expect(buffer.text()).toBe(reference.output)
        checked += 1
      }
    }
    expect(checked).toBe(480)
  })

  test('差分：小上限下的长小块流（反复触发头部压缩与尾部封存后裁剪） 与旧实现逐一相同', () => {
    const random = lcg(2026)
    for (const maxChars of [1, 7, 100, 1000]) {
      const buffer = new TerminalOutputBuffer(maxChars)
      let reference: ReferenceBuffer = { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
      for (let sequence = 1; sequence <= 3000; sequence += 1) {
        const size = Math.floor(random() * 200)
        const data = String.fromCharCode(97 + (sequence % 26)).repeat(size)
        buffer.append(event(sequence, data))
        reference = referenceAppend(reference, data, sequence, maxChars)
        if (sequence % 97 === 0 || sequence > 2990) {
          expect(buffer.startOffset).toBe(reference.startOffset)
          expect(buffer.endOffset).toBe(reference.endOffset)
          expect(buffer.text()).toBe(reference.output)
        }
      }
      expect(buffer.text()).toBe(reference.output)
    }
  })
})

describe('终端回放缓冲：分页读取（TerminalRead 的语义）', () => {
  test('Given 缓冲少于默认页长 When 不带参数读取 Then 从头读到尾、不标记截断', () => {
    const buffer = build(['hello\r\nworld\r\n'])
    const read = readTerminalOutput(buffer)
    expect(read.output).toBe('hello\nworld\n')
    expect(read.offset).toBe(0)
    expect(read.nextOffset).toBe(14)
    expect(read.truncatedBefore).toBe(false)
    expect(read.truncatedAfter).toBe(false)
  })

  test('Given 缓冲长于默认页长 When 不带参数读取 Then 默认读末尾 12000 字符并标记前文省略', () => {
    const buffer = build(['a'.repeat(20_000)])
    const read = readTerminalOutput(buffer)
    expect(read.output.length).toBe(12_000)
    expect(read.offset).toBe(8_000)
    expect(read.nextOffset).toBe(20_000)
    expect(read.truncatedBefore).toBe(true)
    expect(read.truncatedAfter).toBe(false)
  })

  test('Given 指定 offset 与 limit When 分页 Then 按完整流偏移取段、nextOffset 供下一页、末页 truncatedAfter 为 false', () => {
    const buffer = build(['0123456789'])
    const first = readTerminalOutput(buffer, { offset: 0, limit: 4 })
    expect(first.output).toBe('0123')
    expect(first.nextOffset).toBe(4)
    expect(first.truncatedAfter).toBe(true)
    const last = readTerminalOutput(buffer, { offset: first.nextOffset, limit: 100 })
    expect(last.output).toBe('456789')
    expect(last.nextOffset).toBe(10)
    expect(last.truncatedAfter).toBe(false)
    expect(last.truncatedBefore).toBe(true)
  })

  test('Given 缓冲已裁剪 When 读取被裁掉的偏移 Then 钳到可用起点并标记 truncatedBefore', () => {
    const buffer = build(['0123456789', 'abcdef'], 8)
    const read = readTerminalOutput(buffer, { offset: 2, limit: 3 })
    expect(read.offset).toBe(8)
    expect(read.output).toBe('89a')
    expect(read.availableStartOffset).toBe(8)
    expect(read.availableEndOffset).toBe(16)
    expect(read.truncatedBefore).toBe(true)
  })

  test('Given offset 超过末尾 When 读取 Then 钳到末尾、返回空串', () => {
    const buffer = build(['abc'])
    const read = readTerminalOutput(buffer, { offset: 999 })
    expect(read.output).toBe('')
    expect(read.offset).toBe(3)
    expect(read.nextOffset).toBe(3)
  })

  test('Given 非法 limit 或 offset When 读取 Then 抛出与原实现相同的中文错误', () => {
    const buffer = build(['abc'])
    expect(() => readTerminalOutput(buffer, { limit: 0 })).toThrow('终端输出读取长度必须是 1 到 48000 之间的整数')
    expect(() => readTerminalOutput(buffer, { limit: 48_001 })).toThrow('终端输出读取长度必须是 1 到 48000 之间的整数')
    expect(() => readTerminalOutput(buffer, { limit: 1.5 })).toThrow('终端输出读取长度必须是 1 到 48000 之间的整数')
    expect(() => readTerminalOutput(buffer, { offset: -1 })).toThrow('终端输出偏移必须是非负整数')
    expect(() => readTerminalOutput(buffer, { offset: 2.5 })).toThrow('终端输出偏移必须是非负整数')
  })

  test('Given 带控制序列的真实 zsh 输出 When 读取 Then 颜色 / OSC 标题 / 光标序列被剥掉、孤立 \\r 不外显、真实换行保留', () => {
    const raw = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m   \r \r\x1b]7;file://host/Users/user\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Juser@host ~ % \x1b[K\x1b[?2004hecho hi\r\nhi\r\n\x1bP$q q\x1b\\\x1b(B\x1b=\x00\x7f'
    const buffer = build([raw])
    expect(readTerminalOutput(buffer).output).toBe('%    user@host ~ % echo hi\nhi\n')
  })

  test('Given 读取范围跨越多个内部块 When 读取 Then 与整串切片结果一致', () => {
    const chunks = ['abc', 'defg', '', 'hijkl', 'm']
    const buffer = build(chunks)
    const whole = chunks.join('')
    for (let offset = 0; offset <= whole.length; offset += 1) {
      for (const limit of [1, 2, 3, 7, 48_000]) {
        const read = readTerminalOutput(buffer, { offset, limit })
        expect(read.output).toBe(whole.slice(offset, Math.min(whole.length, offset + limit)))
      }
    }
  })
})
