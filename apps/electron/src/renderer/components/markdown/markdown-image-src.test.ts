import { describe, expect, test } from 'bun:test'
import { getLocalImagePathCandidates, isDirectRenderableImageSrc } from './markdown-image-src'

describe('isDirectRenderableImageSrc：判定无需本地解析、可直接交给 <img> 的 src', () => {
  test('Given http/https/data/blob/canopy-file 协议 When 判定 Then 均为直接可加载', () => {
    expect(isDirectRenderableImageSrc('https://example.com/a.png')).toBe(true)
    expect(isDirectRenderableImageSrc('http://example.com/a.png')).toBe(true)
    expect(isDirectRenderableImageSrc('data:image/png;base64,AAAA')).toBe(true)
    expect(isDirectRenderableImageSrc('blob:http://localhost/xxx')).toBe(true)
    expect(isDirectRenderableImageSrc('canopy-file://token/a.png')).toBe(true)
    expect(isDirectRenderableImageSrc('HTTPS://EXAMPLE.COM/A.PNG')).toBe(true)
  })

  test('Given 本地相对/绝对路径与 file: URL When 判定 Then 不属于直接可加载', () => {
    expect(isDirectRenderableImageSrc('red.png')).toBe(false)
    expect(isDirectRenderableImageSrc('./red.png')).toBe(false)
    expect(isDirectRenderableImageSrc('/abs/red.png')).toBe(false)
    expect(isDirectRenderableImageSrc('file:///abs/red.png')).toBe(false)
  })
})

describe('getLocalImagePathCandidates：把 Markdown 图片 src 归一成本地路径候选', () => {
  test('Given 同目录/带 ./ 前缀/子目录相对路径 When 归一 Then 原样作为唯一候选', () => {
    expect(getLocalImagePathCandidates('red.png')).toEqual(['red.png'])
    expect(getLocalImagePathCandidates('./red.png')).toEqual(['./red.png'])
    expect(getLocalImagePathCandidates('sub/blue.png')).toEqual(['sub/blue.png'])
  })

  test('Given POSIX 绝对路径与 Windows 盘符路径 When 归一 Then 识别为本地候选而非 URL scheme', () => {
    expect(getLocalImagePathCandidates('/Users/x/red.png')).toEqual(['/Users/x/red.png'])
    expect(getLocalImagePathCandidates('C:/imgs/red.png')).toEqual(['C:/imgs/red.png'])
    expect(getLocalImagePathCandidates('C:\\imgs\\red.png')).toEqual(['C:\\imgs\\red.png'])
  })

  test('Given 带百分号编码的裸路径 When 归一 Then 原样与解码后两个候选按序给出', () => {
    expect(getLocalImagePathCandidates('img%20a.png')).toEqual(['img%20a.png', 'img a.png'])
  })

  test('Given 非法百分号序列 When 解码失败 Then 回落为原样唯一候选而不抛异常', () => {
    expect(getLocalImagePathCandidates('bad%zz.png')).toEqual(['bad%zz.png'])
  })

  test('Given file: URL When 归一 Then 取解码后的 pathname 作为唯一候选', () => {
    expect(getLocalImagePathCandidates('file:///Users/x/img%20a.png')).toEqual(['/Users/x/img a.png'])
  })

  test('Given 直接可加载协议 When 归一 Then 无本地候选', () => {
    expect(getLocalImagePathCandidates('https://example.com/a.png')).toEqual([])
    expect(getLocalImagePathCandidates('data:image/gif;base64,AA')).toEqual([])
    expect(getLocalImagePathCandidates('canopy-file://token/a.png')).toEqual([])
  })

  test('Given 其他 scheme 与协议相对 URL When 归一 Then 不当作本地路径', () => {
    expect(getLocalImagePathCandidates('mailto:a@b.c')).toEqual([])
    expect(getLocalImagePathCandidates('obsidian://open?vault=x')).toEqual([])
    expect(getLocalImagePathCandidates('//cdn.example.com/a.png')).toEqual([])
  })

  test('Given 空串或纯空白 When 归一 Then 无候选', () => {
    expect(getLocalImagePathCandidates('')).toEqual([])
    expect(getLocalImagePathCandidates('   ')).toEqual([])
  })

  test('Given 前后带空白的路径 When 归一 Then 先裁剪再作候选', () => {
    expect(getLocalImagePathCandidates(' red.png ')).toEqual(['red.png'])
  })
})
