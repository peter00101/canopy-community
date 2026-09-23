import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { formatAsrError, parseServerMessage, parseServerPayload } from './doubao-asr-service'

// 协议常量（与实现一致）：header 4 字节 = [version<<4|headerSize, messageType<<4|flags, serialization<<4|compression, 0]
const HEADER_BYTE0 = (0b0001 << 4) | 0b0001
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001
const MESSAGE_TYPE_SERVER_ERROR = 0b1111
const FLAG_NO_SEQUENCE = 0b0000
const FLAG_SERVER_SEQUENCE = 0b0001
const SERIALIZATION_JSON = 0b0001
const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001

function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value, 0)
  return b
}

function errorFrame(code: number, message: string, flags = FLAG_NO_SEQUENCE): Buffer {
  const body = Buffer.from(message, 'utf-8')
  const seq = flags === FLAG_SERVER_SEQUENCE ? u32(1) : Buffer.alloc(0)
  return Buffer.concat([
    Buffer.from([HEADER_BYTE0, (MESSAGE_TYPE_SERVER_ERROR << 4) | flags, (SERIALIZATION_JSON << 4) | COMPRESSION_NONE, 0]),
    seq,
    u32(code),
    u32(body.length),
    body,
  ])
}

function responseFrame(payload: unknown, options: { gzip?: boolean; flags?: number } = {}): Buffer {
  const flags = options.flags ?? FLAG_NO_SEQUENCE
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8')
  const body = options.gzip ? gzipSync(raw) : raw
  const seq = flags === FLAG_SERVER_SEQUENCE ? u32(1) : Buffer.alloc(0)
  return Buffer.concat([
    Buffer.from([HEADER_BYTE0, (MESSAGE_TYPE_FULL_SERVER_RESPONSE << 4) | flags, (SERIALIZATION_JSON << 4) | (options.gzip ? COMPRESSION_GZIP : COMPRESSION_NONE), 0]),
    seq,
    u32(body.length),
    body,
  ])
}

describe('豆包 ASR 服务端帧解析：错误帧与识别结果必须分开', () => {
  test('Given 服务端错误帧（message type 0b1111） When 解析 Then 归类为 error 而不是 transcript', () => {
    const parsed = parseServerMessage(errorFrame(45000001, 'invalid access token'))
    expect(parsed).toEqual({ kind: 'error', code: 45000001, message: 'invalid access token' })
  })

  test('Given 带 sequence 的错误帧 When 解析 Then 正确跳过 4 字节序号后读取 code 与文案', () => {
    const parsed = parseServerMessage(errorFrame(55000002, 'quota exceeded', FLAG_SERVER_SEQUENCE))
    expect(parsed).toEqual({ kind: 'error', code: 55000002, message: 'quota exceeded' })
  })

  test('Given 带 gzip JSON 的识别结果帧 When 解析 Then 归类为 transcript 并按 definite 判定 final', () => {
    const parsed = parseServerMessage(responseFrame({
      result: { text: '你好世界', utterances: [{ text: '你好世界', definite: true }] },
    }, { gzip: true, flags: FLAG_SERVER_SEQUENCE }))
    expect(parsed).toEqual({ kind: 'transcript', text: '你好世界', isFinal: true })
  })

  test('Given 未压缩的中间结果 When 解析 Then isFinal 为 false', () => {
    const parsed = parseServerMessage(responseFrame({ result: { text: '你好', utterances: [{ text: '你好', definite: false }] } }))
    expect(parsed).toEqual({ kind: 'transcript', text: '你好', isFinal: false })
  })

  test('Given 会话建立后的空应答（无 result 无 text） When 解析 Then 返回 null（不制造空转写）', () => {
    expect(parseServerMessage(responseFrame({}))).toBeNull()
    expect(parseServerMessage(responseFrame({ result: { text: '' } }))).toBeNull()
  })

  test('Given payload 只带 error / message 字段 When 解析 Then 是服务端报错，不是用户说的话', () => {
    expect(parseServerPayload({ error: 'resource not authorized' }, false)).toEqual({ kind: 'error', code: null, message: 'resource not authorized' })
    expect(parseServerPayload({ message: 'session closed by server' }, true)).toEqual({ kind: 'error', code: null, message: 'session closed by server' })
  })

  test('Given payload 顶层 text（无 result） When 解析 Then 仍视为转写文本', () => {
    expect(parseServerPayload({ text: '直接文本' }, true)).toEqual({ kind: 'transcript', text: '直接文本', isFinal: true })
  })

  test('Given 多个候选 result When 解析 Then 取置信度最高者而不是拼接', () => {
    const parsed = parseServerPayload({
      result: [
        { text: '候选一', confidence: 0.4 },
        { text: '候选二', confidence: 0.9 },
      ],
    }, false)
    expect(parsed).toEqual({ kind: 'transcript', text: '候选二', isFinal: false })
  })

  test('Given 错误对象 When 格式化 Then 有码带码、无码不带', () => {
    expect(formatAsrError({ code: 45000001, message: 'x' })).toBe('豆包 ASR 错误 45000001: x')
    expect(formatAsrError({ code: null, message: 'y' })).toBe('豆包 ASR 错误: y')
  })
})
