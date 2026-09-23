/**
 * 豆包大模型流式 ASR 服务
 *
 * 主进程负责连接 OpenSpeech WebSocket，因为浏览器 WebSocket 无法设置
 * 豆包要求的自定义鉴权 Header。
 */

import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import WebSocket from 'ws'
import type {
  VoiceDictationSettings,
  VoiceDictationTranscriptEvent,
  VoiceDictationStateEvent,
} from '../../types'
import { VOICE_DICTATION_IPC_CHANNELS } from '../../types'

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE = 0b0001

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0b0010
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001
const MESSAGE_TYPE_SERVER_ERROR = 0b1111

const FLAG_NO_SEQUENCE = 0b0000
const FLAG_LAST_NO_SEQUENCE = 0b0010
const FLAG_SERVER_SEQUENCE = 0b0001
const FLAG_SERVER_LAST_SEQUENCE = 0b0011

const SERIALIZATION_NONE = 0b0000
const SERIALIZATION_JSON = 0b0001

const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001

const ASYNC_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const DUPLEX_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
const DICTATION_END_WINDOW_SIZE_MS = 5000
const DICTATION_FORCE_TO_SPEECH_TIME_MS = 1000
const MAX_INLINE_HOTWORDS = 100
const HOTWORD_SEPARATOR_PATTERN = /[\n,，、;；]+/u

interface ServerUtterance {
  text?: string
  definite?: boolean
}

interface ServerResult {
  text?: string
  confidence?: number
  utterances?: ServerUtterance[]
}

interface ServerPayload {
  result?: ServerResult | ServerResult[]
  text?: string
  message?: string
  error?: string
}

/**
 * 服务端帧解析结果。错误帧（协议 message type 0b1111）与 payload 里只带 error/message 的帧
 * 必须与识别结果分开：此前它们被当成 transcript 下发，错误文案会被拼进用户正在听写的文字里，
 * 而 UI 完全不知道会话其实已经出错。
 */
export type ParsedServerMessage =
  | { kind: 'transcript'; text: string; isFinal: boolean }
  | { kind: 'error'; code: number | null; message: string }

interface DoubaoAsrHotword {
  word: string
}

interface DoubaoAsrCorpus {
  context: string
}

interface ActiveSession {
  sessionId: string
  ws: WebSocket
  win: BrowserWindow
  closed: boolean
  /** 会话是否因错误（错误帧 / socket error）而结束：关闭时通知渲染层「失败」而不是「正常结束」，渲染层据此不再自动重连 */
  failed: boolean
}

/** 会话正常被服务端关闭（如 VAD 静音超时），渲染层可自动重连 */
export const ASR_SESSION_ENDED = 'asr_session_ended'
/** 会话因错误结束（鉴权 / 额度 / 网络），渲染层不得自动重连 */
export const ASR_SESSION_FAILED = 'asr_session_failed'

const activeSessions = new Map<string, ActiveSession>()

function getEndpoint(settings: VoiceDictationSettings): string {
  return settings.endpointMode === 'duplex' ? DUPLEX_ENDPOINT : ASYNC_ENDPOINT
}

function parseCustomHotwords(value: string): DoubaoAsrHotword[] {
  const seen = new Set<string>()
  const hotwords: DoubaoAsrHotword[] = []

  for (const rawWord of value.split(HOTWORD_SEPARATOR_PATTERN)) {
    const word = rawWord.trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    hotwords.push({ word })
    if (hotwords.length >= MAX_INLINE_HOTWORDS) break
  }

  return hotwords
}

function buildCorpus(settings: VoiceDictationSettings): DoubaoAsrCorpus | undefined {
  const hotwords = parseCustomHotwords(settings.customHotwords)
  if (hotwords.length === 0) return undefined

  return {
    context: JSON.stringify({ hotwords }),
  }
}

function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function buildFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer,
): Buffer {
  const header = buildHeader(messageType, flags, serialization, compression)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, size, payload])
}

function buildClientRequest(settings: VoiceDictationSettings): Buffer {
  const audio: Record<string, unknown> = {
    format: 'pcm',
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1,
  }
  if (settings.language) {
    audio.language = settings.language
  }

  const corpus = buildCorpus(settings)
  const requestOptions = {
    model_name: 'bigmodel',
    enable_nonstream: true,
    show_utterances: true,
    result_type: 'full',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    // 听写场景允许用户自然停顿，避免 800ms 静音就过早切句。
    end_window_size: DICTATION_END_WINDOW_SIZE_MS,
    force_to_speech_time: DICTATION_FORCE_TO_SPEECH_TIME_MS,
    ...(corpus ? { corpus } : {}),
  }

  const request = {
    user: {
      uid: 'canopy-desktop',
    },
    audio,
    request: requestOptions,
  }

  const payload = gzipSync(Buffer.from(JSON.stringify(request), 'utf-8'))
  return buildFrame(
    MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    FLAG_NO_SEQUENCE,
    SERIALIZATION_JSON,
    COMPRESSION_GZIP,
    payload,
  )
}

function buildAudioFrame(audio: Buffer, isLast: boolean): Buffer {
  const payload = gzipSync(audio)
  return buildFrame(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    isLast ? FLAG_LAST_NO_SEQUENCE : FLAG_NO_SEQUENCE,
    SERIALIZATION_NONE,
    COMPRESSION_GZIP,
    payload,
  )
}

function sendState(win: BrowserWindow, event: VoiceDictationStateEvent): void {
  if (!win.isDestroyed()) {
    win.webContents.send(VOICE_DICTATION_IPC_CHANNELS.STATE, event)
  }
}

function sendTranscript(win: BrowserWindow, event: VoiceDictationTranscriptEvent): void {
  if (!win.isDestroyed()) {
    win.webContents.send(VOICE_DICTATION_IPC_CHANNELS.TRANSCRIPT, event)
  }
}

function getResultText(result: ServerResult): string {
  return result.text ?? result.utterances?.map((item) => item.text ?? '').join('') ?? ''
}

function getAuthoritativeResult(results: ServerResult[]): ServerResult | null {
  const candidates = results
    .map((result) => ({ result, text: getResultText(result) }))
    .filter((item) => item.text.trim().length > 0)

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!.result

  // result 数组表示识别候选，不是需要拼接的分句；拼接会制造重复文本。
  return [...candidates]
    .sort((left, right) => (right.result.confidence ?? 0) - (left.result.confidence ?? 0))[0]!
    .result
}

function isResultFinal(result: ServerResult): boolean {
  return result.utterances?.some((item) => item.definite === true) ?? false
}

export function parseServerPayload(value: unknown, fallbackFinal: boolean): ParsedServerMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const payload = value as ServerPayload
  const results = Array.isArray(payload.result)
    ? payload.result
    : payload.result
      ? [payload.result]
      : []

  if (results.length === 0) {
    if (payload.text) return { kind: 'transcript', text: payload.text, isFinal: fallbackFinal }
    // 没有识别结果、只带 error / message 的 payload 是服务端在报错，不是用户说的话
    const errorMessage = payload.error ?? payload.message
    return errorMessage ? { kind: 'error', code: null, message: errorMessage } : null
  }

  if (payload.text) {
    return {
      kind: 'transcript',
      text: payload.text,
      isFinal: fallbackFinal || results.some(isResultFinal),
    }
  }

  const authoritativeResult = getAuthoritativeResult(results)
  const text = authoritativeResult ? getResultText(authoritativeResult) : ''
  const utteranceFinal = authoritativeResult ? isResultFinal(authoritativeResult) : false
  if (!text) return null
  return {
    kind: 'transcript',
    text,
    isFinal: fallbackFinal || utteranceFinal,
  }
}

export function formatAsrError(error: { code: number | null; message: string }): string {
  return error.code === null ? `豆包 ASR 错误: ${error.message}` : `豆包 ASR 错误 ${error.code}: ${error.message}`
}

export function parseServerMessage(data: Buffer): ParsedServerMessage | null {
  if (data.length < 8) return null

  const headerSize = (data[0]! & 0x0f) * 4
  const messageType = data[1]! >> 4
  const flags = data[1]! & 0x0f
  const serialization = data[2]! >> 4
  const compression = data[2]! & 0x0f
  let offset = headerSize

  const hasSequence = flags === FLAG_SERVER_SEQUENCE || flags === FLAG_SERVER_LAST_SEQUENCE
  if (hasSequence) {
    offset += 4
  }

  if (messageType === MESSAGE_TYPE_SERVER_ERROR) {
    if (data.length < offset + 8) return null
    const code = data.readUInt32BE(offset)
    offset += 4
    const size = data.readUInt32BE(offset)
    offset += 4
    const message = data.subarray(offset, offset + size).toString('utf-8')
    return { kind: 'error', code, message }
  }

  if (messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE || data.length < offset + 4) {
    return null
  }

  const payloadSize = data.readUInt32BE(offset)
  offset += 4
  const payload = data.subarray(offset, offset + payloadSize)
  const decoded = compression === COMPRESSION_GZIP ? gunzipSync(payload) : payload

  if (serialization !== SERIALIZATION_JSON) return null
  const parsed = JSON.parse(decoded.toString('utf-8')) as unknown
  return parseServerPayload(parsed, flags === FLAG_SERVER_LAST_SEQUENCE)
}

/**
 * 测试豆包 ASR 连接：握手 + 鉴权 Header 之后**真正建立一次识别会话**（发 full client request 并等服务端首帧）。
 * 只测握手会漏掉一类最常见的配置错误——Resource ID 无权限 / 套餐未开通时握手照样成功，
 * 服务端要到收到 full client request 才回错误帧；此前「测试连接」对此报成功，用户一开始听写就失败。
 */
export async function testDoubaoAsrConnection(
  settings: VoiceDictationSettings,
): Promise<{ success: boolean; message: string }> {
  if (!settings.appId || !settings.accessToken || !settings.resourceId) {
    return { success: false, message: '请先填写 APP ID、Access Token 和 Resource ID' }
  }

  return await new Promise((resolve) => {
    const ws = new WebSocket(getEndpoint(settings), {
      headers: {
        'X-Api-App-Key': settings.appId,
        'X-Api-Access-Key': settings.accessToken,
        'X-Api-Resource-Id': settings.resourceId,
        'X-Api-Connect-Id': randomUUID(),
      },
    })

    let settled = false
    let handshakeDone = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (result: { success: boolean; message: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else ws.terminate()
      } catch { /* 关闭失败不影响结果 */ }
      resolve(result)
    }

    timer = setTimeout(() => {
      settle({
        success: false,
        message: handshakeDone ? '会话建立超时：握手成功但服务端 8 秒内未应答，请检查 Resource ID 与套餐状态' : '连接超时，请检查网络或凭证',
      })
    }, 8000)

    ws.once('open', () => {
      handshakeDone = true
      // 握手通过只说明鉴权 Header 没问题；发一次真实的会话请求，等服务端首帧才算连通
      ws.send(buildClientRequest(settings))
    })

    ws.once('message', (message: Buffer | ArrayBuffer | Buffer[]) => {
      const buffer = Array.isArray(message)
        ? Buffer.concat(message)
        : Buffer.isBuffer(message)
          ? message
          : Buffer.from(message)
      try {
        const parsed = parseServerMessage(buffer)
        if (parsed?.kind === 'error') {
          settle({ success: false, message: `握手成功但会话建立失败：${formatAsrError(parsed)}` })
          return
        }
        settle({ success: true, message: '豆包 ASR 连接成功，识别会话建立正常' })
      } catch (error) {
        const text = error instanceof Error ? error.message : '未知解析错误'
        settle({ success: false, message: `服务端应答无法解析: ${text}` })
      }
    })

    ws.once('close', () => {
      settle({
        success: false,
        message: handshakeDone ? '握手成功但服务端在会话建立前关闭了连接，请检查 Resource ID 与套餐状态' : '连接在建立前被关闭',
      })
    })

    ws.once('error', (error: Error) => {
      settle({ success: false, message: `连接失败: ${error.message}` })
    })
  })
}

export async function startDoubaoAsrSession(
  sessionId: string,
  settings: VoiceDictationSettings,
  win: BrowserWindow,
): Promise<void> {
  if (!settings.appId || !settings.accessToken || !settings.resourceId) {
    throw new Error('请先填写豆包 ASR 凭证')
  }

  await stopDoubaoAsrSession(sessionId)
  sendState(win, { sessionId, status: 'connecting', message: '正在连接豆包 ASR...' })

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(getEndpoint(settings), {
      headers: {
        'X-Api-App-Key': settings.appId,
        'X-Api-Access-Key': settings.accessToken,
        'X-Api-Resource-Id': settings.resourceId,
        'X-Api-Connect-Id': randomUUID(),
      },
    })

    const active: ActiveSession = { sessionId, ws, win, closed: false, failed: false }
    activeSessions.set(sessionId, active)
    let connected = false
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    const timer = setTimeout(() => {
      active.failed = true
      ws.terminate()
      activeSessions.delete(sessionId)
      fail(new Error('连接豆包 ASR 超时'))
    }, 10000)

    ws.once('open', () => {
      if (settled) return
      clearTimeout(timer)
      connected = true
      settled = true
      ws.send(buildClientRequest(settings))
      sendState(win, { sessionId, status: 'recording', message: '正在听写' })
      resolve()
    })

    ws.on('message', (message: Buffer | ArrayBuffer | Buffer[]) => {
      const buffer = Array.isArray(message)
        ? Buffer.concat(message)
        : Buffer.isBuffer(message)
          ? message
          : Buffer.from(message)
      try {
        const parsed = parseServerMessage(buffer)
        if (!parsed) return
        if (parsed.kind === 'error') {
          // 服务端报错帧：推错误状态、标记失败并主动关闭；绝不能当成识别文本下发
          const errorText = formatAsrError(parsed)
          console.warn(`[豆包 ASR] 会话 ${sessionId} 收到服务端错误: ${errorText}`)
          active.failed = true
          sendState(win, { sessionId, status: 'error', message: errorText })
          if (!connected) fail(new Error(errorText))
          ws.close()
          return
        }
        sendTranscript(win, {
          sessionId,
          text: parsed.text,
          isFinal: parsed.isFinal,
        })
      } catch (error) {
        const messageText = error instanceof Error ? error.message : '未知解析错误'
        sendState(win, {
          sessionId,
          status: 'error',
          message: `解析 ASR 响应失败: ${messageText}`,
        })
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      active.closed = true
      activeSessions.delete(sessionId)
      // 失败关闭与正常关闭分开通知：渲染层只对正常关闭自动重连
      sendState(win, { sessionId, status: 'idle', message: active.failed ? ASR_SESSION_FAILED : ASR_SESSION_ENDED })
      if (!connected) fail(new Error('连接豆包 ASR 在建立前已关闭'))
    })

    ws.once('error', (error: Error) => {
      clearTimeout(timer)
      active.failed = true
      activeSessions.delete(sessionId)
      sendState(win, { sessionId, status: 'error', message: error.message })
      fail(error)
    })
  })
}

export function sendDoubaoAsrAudio(sessionId: string, data: ArrayBuffer): void {
  const active = activeSessions.get(sessionId)
  if (!active || active.closed || active.ws.readyState !== WebSocket.OPEN) return
  const audio = Buffer.from(data)
  if (audio.length === 0) return
  active.ws.send(buildAudioFrame(audio, false))
}

export async function stopDoubaoAsrSession(sessionId: string): Promise<void> {
  const active = activeSessions.get(sessionId)
  if (!active || active.closed) return

  if (active.ws.readyState === WebSocket.OPEN) {
    active.ws.send(buildAudioFrame(Buffer.alloc(0), true))
    setTimeout(() => {
      if (!active.closed) active.ws.close()
    }, 800)
  } else {
    active.ws.terminate()
  }
}

export function cancelDoubaoAsrSession(sessionId: string): void {
  const active = activeSessions.get(sessionId)
  if (!active) return
  active.ws.terminate()
  activeSessions.delete(sessionId)
}

export function cancelAllDoubaoAsrSessions(): void {
  for (const session of activeSessions.values()) {
    session.ws.terminate()
  }
  activeSessions.clear()
}
