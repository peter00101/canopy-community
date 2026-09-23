/**
 * 视频助手纯逻辑测试：端点派生（video-relay-service）与
 * 视频描述填充/注入（chat-vision-augment）。
 */

import { describe, expect, test } from 'bun:test'
import { deriveVideoRelayEndpoints } from './video-relay-endpoints'
import {
  appendVideoDescriptionBlocks,
  fillVideoDescriptions,
  MAX_VIDEO_ATTACHMENTS,
  VIDEO_PLACEHOLDER,
} from './chat-vision-augment'
import type { FileAttachment } from '@canopy/shared'

function videoAttachment(id: string, overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id,
    filename: `${id}.mp4`,
    mediaType: 'video/mp4',
    localPath: `conv/${id}.mp4`,
    size: 1024,
    ...overrides,
  }
}

describe('deriveVideoRelayEndpoints', () => {
  test('Given kimi-api 渠道的 anthropic base URL，When 派生端点，Then 消息端点挂 baseUrl、文件端点挂源站根', () => {
    const endpoints = deriveVideoRelayEndpoints('https://api.moonshot.cn/anthropic')
    expect(endpoints).toBeDefined()
    expect(endpoints!.messagesUrl).toBe('https://api.moonshot.cn/anthropic/v1/messages')
    expect(endpoints!.uploadUrl).toBe('https://api.moonshot.cn/v1/files')
    expect(endpoints!.deleteUrl('abc123')).toBe('https://api.moonshot.cn/v1/files/abc123')
  })

  test('Given 带尾斜杠的 base URL，When 派生端点，Then 不产生双斜杠', () => {
    const endpoints = deriveVideoRelayEndpoints('https://api.moonshot.cn/anthropic/')
    expect(endpoints!.messagesUrl).toBe('https://api.moonshot.cn/anthropic/v1/messages')
    expect(endpoints!.uploadUrl).toBe('https://api.moonshot.cn/v1/files')
  })

  test('Given 文件 ID 含特殊字符，When 构造删除端点，Then 做 URL 编码', () => {
    const endpoints = deriveVideoRelayEndpoints('https://api.moonshot.cn/anthropic')
    expect(endpoints!.deleteUrl('a/b c')).toBe('https://api.moonshot.cn/v1/files/a%2Fb%20c')
  })

  test('Given 非法 URL，When 派生端点，Then 返回 undefined', () => {
    expect(deriveVideoRelayEndpoints('not-a-url')).toBeUndefined()
    expect(deriveVideoRelayEndpoints('')).toBeUndefined()
  })
})

describe('fillVideoDescriptions', () => {
  test('Given 无缓存的视频附件，When 填充描述，Then 生成并写入新数组且不修改入参', async () => {
    const input = [videoAttachment('v1')]
    const result = await fillVideoDescriptions(input, async () => '一段红蓝渐变视频', undefined)
    expect(result).not.toBe(input)
    expect(result?.[0]?.visionDescription).toBe('一段红蓝渐变视频')
    expect(input[0]?.visionDescription).toBeUndefined()
  })

  test('Given 已有缓存的视频附件，When 填充描述，Then 原样返回入参引用不重复调用', async () => {
    let calls = 0
    const input = [videoAttachment('v1', { visionDescription: '已缓存' })]
    const result = await fillVideoDescriptions(input, async () => { calls++; return '新描述' }, undefined)
    expect(result).toBe(input)
    expect(calls).toBe(0)
  })

  test('Given 超过上限的视频数量，When 填充描述，Then 只处理前 MAX_VIDEO_ATTACHMENTS 个', async () => {
    let calls = 0
    const input = [videoAttachment('v1'), videoAttachment('v2'), videoAttachment('v3')]
    const result = await fillVideoDescriptions(input, async () => { calls++; return '描述' }, undefined)
    expect(calls).toBe(MAX_VIDEO_ATTACHMENTS)
    expect(result?.[0]?.visionDescription).toBe('描述')
    expect(result?.[1]?.visionDescription).toBe('描述')
    expect(result?.[2]?.visionDescription).toBeUndefined()
  })

  test('Given 描述生成失败，When 填充描述，Then 不写缓存原样返回', async () => {
    const input = [videoAttachment('v1')]
    const result = await fillVideoDescriptions(input, async () => { throw new Error('boom') }, undefined)
    expect(result).toBe(input)
    expect(result?.[0]?.visionDescription).toBeUndefined()
  })

  test('Given 图片与视频混合，When 填充视频描述，Then 只处理视频附件', async () => {
    const image: FileAttachment = { id: 'img', filename: 'a.png', mediaType: 'image/png', localPath: 'conv/a.png', size: 10 }
    let described: string[] = []
    await fillVideoDescriptions([image, videoAttachment('v1')], async (att) => { described.push(att.id); return 'ok' }, undefined)
    expect(described).toEqual(['v1'])
  })
})

describe('appendVideoDescriptionBlocks', () => {
  test('Given 有缓存描述的视频，When 注入，Then 以 <video index name> 块追加', () => {
    const text = appendVideoDescriptionBlocks('看看这个', [videoAttachment('v1', { visionDescription: '红蓝两色' })])
    expect(text).toContain('看看这个')
    expect(text).toContain('<video index="1" name="v1.mp4">')
    expect(text).toContain('红蓝两色')
    expect(text).toContain('</video>')
  })

  test('Given 无缓存描述的视频，When 注入，Then 使用占位文本', () => {
    const text = appendVideoDescriptionBlocks('msg', [videoAttachment('v1')])
    expect(text).toContain(VIDEO_PLACEHOLDER)
  })

  test('Given 没有视频附件，When 注入，Then 原样返回消息文本', () => {
    const image: FileAttachment = { id: 'img', filename: 'a.png', mediaType: 'image/png', localPath: 'conv/a.png', size: 10 }
    expect(appendVideoDescriptionBlocks('msg', [image])).toBe('msg')
    expect(appendVideoDescriptionBlocks('msg', [])).toBe('msg')
    expect(appendVideoDescriptionBlocks('msg', undefined)).toBe('msg')
  })
})
