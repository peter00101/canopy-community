import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PSD_EXTENSIONS,
  PsdAccessError,
  defaultPreviewPngPath,
  resolveReadableAssetPath,
  resolveReadablePsdPath,
  resolveWritablePath,
} from './psd-paths'

let root = ''
let outside = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'canopy-psd-paths-'))
  outside = mkdtempSync(join(tmpdir(), 'canopy-psd-outside-'))
  writeFileSync(join(root, 'a.psd'), '8BPS')
  writeFileSync(join(root, 'big.psb'), '8BPB')
  writeFileSync(join(root, 'photo.png'), 'png')
  writeFileSync(join(outside, 'leak.psd'), '8BPS')
  mkdirSync(join(root, 'sub'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('PSD 路径授权：读取', () => {
  it('Given 授权根内的 .psd，When 解析，Then 返回真实绝对路径；相对路径按工作目录解析', () => {
    expect(resolveReadablePsdPath('a.psd', [root], root).toLowerCase()).toBe(join(root, 'a.psd').toLowerCase())
  })

  it('Given .psb / 非 psd / 根外 / 不存在 / 无授权根，When 解析，Then 各自被拒且信息可读', () => {
    expect(() => resolveReadablePsdPath('big.psb', [root], root)).toThrow(/psb/)
    expect(() => resolveReadablePsdPath('photo.png', [root], root)).toThrow(/只支持 \.psd/)
    expect(() => resolveReadablePsdPath(join(outside, 'leak.psd'), [root], root)).toThrow(/不在本次会话已授权/)
    expect(() => resolveReadablePsdPath('missing.psd', [root], root)).toThrow(/文件不存在/)
    expect(() => resolveReadablePsdPath('a.psd', [], root)).toThrow(PsdAccessError)
  })

  it('Given 素材路径，When 解析，Then 只放行图片扩展名', () => {
    expect(resolveReadableAssetPath('photo.png', [root], root)).toContain('photo.png')
    expect(() => resolveReadableAssetPath('a.psd', [root], root)).toThrow(/素材只支持/)
  })
})

describe('PSD 路径授权：写入', () => {
  it('Given 授权根内不存在的 .psd，When 解析输出路径，Then 通过；已存在的默认拒绝、overwrite 放行', () => {
    expect(resolveWritablePath('sub/new.psd', [root], root, { extensions: PSD_EXTENSIONS })).toContain('new.psd')
    expect(() => resolveWritablePath('a.psd', [root], root, { extensions: PSD_EXTENSIONS })).toThrow(/已存在/)
    expect(resolveWritablePath('a.psd', [root], root, { extensions: PSD_EXTENSIONS, allowOverwrite: true })).toContain('a.psd')
  })

  it('Given 错误扩展名 / 父目录不存在 / 父目录在根外，When 解析输出路径，Then 拒绝', () => {
    expect(() => resolveWritablePath('x.jpg', [root], root, { extensions: PSD_EXTENSIONS })).toThrow(/输出只支持/)
    expect(() => resolveWritablePath('nope/x.psd', [root], root, { extensions: PSD_EXTENSIONS })).toThrow(/目录不存在/)
    expect(() => resolveWritablePath(join(outside, 'x.psd'), [root], root, { extensions: PSD_EXTENSIONS })).toThrow(/不在本次会话已授权/)
  })

  it('Given PSD 路径，When 求默认预览路径，Then 同目录同名 -preview.png', () => {
    expect(defaultPreviewPngPath('C:/x/poster.psd')).toBe('C:/x/poster-preview.png')
  })
})
