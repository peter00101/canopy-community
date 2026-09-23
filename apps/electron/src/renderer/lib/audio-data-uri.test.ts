import { test, expect, describe } from 'bun:test'
import { decodeDataUriToArrayBuffer } from './audio-data-uri'

describe('decodeDataUriToArrayBuffer', () => {
  test('Given vite 内联音频形态的 base64 data: URI，When 解码，Then 得到原始字节', () => {
    // 真实 mp3 文件头（ID3v2.4 起始 "ID3\x04\x00"），与 vite 内联产物同构
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])
    const base64 = btoa(String.fromCharCode(...bytes))
    const result = decodeDataUriToArrayBuffer(`data:audio/mpeg;base64,${base64}`)
    expect(result).not.toBeNull()
    expect([...new Uint8Array(result!)]).toEqual([...bytes])
  })

  test('Given base64 标记大小写混合（;BASE64），When 解码，Then 同样按 base64 处理', () => {
    const result = decodeDataUriToArrayBuffer('data:audio/mpeg;BASE64,QUJD')
    expect(result).not.toBeNull()
    expect([...new Uint8Array(result!)]).toEqual([0x41, 0x42, 0x43])
  })

  test('Given 普通 http/file/相对 URL，When 解码，Then 返回 null 交还正常加载路径', () => {
    expect(decodeDataUriToArrayBuffer('https://example.com/a.mp3')).toBeNull()
    expect(decodeDataUriToArrayBuffer('file:///tmp/a.mp3')).toBeNull()
    expect(decodeDataUriToArrayBuffer('./assets/a.mp3')).toBeNull()
  })

  test('Given 无逗号的畸形 data: URI，When 解码，Then 返回 null', () => {
    expect(decodeDataUriToArrayBuffer('data:audio/mpeg;base64')).toBeNull()
  })

  test('Given 非法 base64 载荷，When 解码，Then 捕获异常返回 null 不抛出', () => {
    expect(decodeDataUriToArrayBuffer('data:audio/mpeg;base64,@@@@')).toBeNull()
  })

  test('Given percent-encoding 文本载荷（无 base64 标记），When 解码，Then 得到 UTF-8 字节', () => {
    const result = decodeDataUriToArrayBuffer('data:text/plain,hi%20there')
    expect(result).not.toBeNull()
    expect(new TextDecoder().decode(result!)).toBe('hi there')
  })

  test('Given 空载荷的 data: URI，When 解码，Then 返回空 ArrayBuffer 而非 null', () => {
    const result = decodeDataUriToArrayBuffer('data:audio/mpeg;base64,')
    expect(result).not.toBeNull()
    expect(result!.byteLength).toBe(0)
  })
})
