import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canRegisterPreviewDirectory,
  filterExplicitPreviewBasePaths,
  isExplicitPreviewDirectoryPath,
  isExplicitPreviewFilePath,
  resolveAuthorizedPreviewPath,
  type PreviewAccessScope,
} from './preview-access-policy'

/**
 * 预览家族授权判定（上游 #2020）的 BDD 覆盖。
 *
 * 目录布局：
 *   workspace/            —— 唯一的显式目录根
 *     inside.md
 *     sub/deep.md
 *     escape.md           —— 指向 outside/secret.md 的符号链接（Windows 无权限时跳过）
 *   outside/
 *     secret.md           —— 根外文件，任何情况下都不该放行
 *     attached.md         —— 单文件授权（会话/工作区附加的单个文件）
 *     sibling.md          —— attached.md 的同目录兄弟，单文件授权不得连带放行
 */
let root: string
let workspaceDir: string
let outsideDir: string
let insideFile: string
let deepFile: string
let secretFile: string
let attachedFile: string
let siblingFile: string
let escapeLink: string
let symlinkAvailable = false

let scope: PreviewAccessScope
let unrestrictedScope: PreviewAccessScope

beforeAll(() => {
  // realpath 一次：macOS 的 /var → /private/var 等软链接会让根与目标的比较失真
  root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-preview-policy-')))
  workspaceDir = join(root, 'workspace')
  outsideDir = join(root, 'outside')
  mkdirSync(join(workspaceDir, 'sub'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  insideFile = join(workspaceDir, 'inside.md')
  deepFile = join(workspaceDir, 'sub', 'deep.md')
  secretFile = join(outsideDir, 'secret.md')
  attachedFile = join(outsideDir, 'attached.md')
  siblingFile = join(outsideDir, 'sibling.md')
  escapeLink = join(workspaceDir, 'escape.md')

  writeFileSync(insideFile, '# 根内', 'utf-8')
  writeFileSync(deepFile, '# 子目录', 'utf-8')
  writeFileSync(secretFile, '# 根外机密', 'utf-8')
  writeFileSync(attachedFile, '# 单文件授权', 'utf-8')
  writeFileSync(siblingFile, '# 同目录兄弟', 'utf-8')

  try {
    symlinkSync(secretFile, escapeLink, 'file')
    symlinkAvailable = true
  } catch {
    // Windows 未开启开发者模式时无权建符号链接；相关断言整体跳过
    symlinkAvailable = false
  }

  scope = { directoryRoots: [workspaceDir], filePaths: [attachedFile], unrestricted: false }
  unrestrictedScope = { directoryRoots: [], filePaths: [], unrestricted: true }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isExplicitPreviewDirectoryPath —— 目录是否落在显式根内', () => {
  test('Given 目录就是显式根本身 When 判定 Then 放行', () => {
    expect(isExplicitPreviewDirectoryPath(workspaceDir, scope)).toBe(true)
  })

  test('Given 显式根下的子目录 When 判定 Then 放行', () => {
    expect(isExplicitPreviewDirectoryPath(join(workspaceDir, 'sub'), scope)).toBe(true)
  })

  test('Given 根外目录 When 判定 Then 拒绝', () => {
    expect(isExplicitPreviewDirectoryPath(outsideDir, scope)).toBe(false)
  })

  test('Given 可信 UI 入口标记 unrestricted When 判定根外目录 Then 放行', () => {
    expect(isExplicitPreviewDirectoryPath(outsideDir, unrestrictedScope)).toBe(true)
  })
})

describe('isExplicitPreviewFilePath —— 文件授权：目录根 + 单文件附加', () => {
  test('Given 显式根内的文件 When 判定 Then 放行', () => {
    expect(isExplicitPreviewFilePath(insideFile, scope)).toBe(true)
    expect(isExplicitPreviewFilePath(deepFile, scope)).toBe(true)
  })

  test('Given 根外且未被附加的文件 When 判定 Then 拒绝', () => {
    expect(isExplicitPreviewFilePath(secretFile, scope)).toBe(false)
  })

  test('Given 单文件授权本身 When 判定 Then 放行', () => {
    expect(isExplicitPreviewFilePath(attachedFile, scope)).toBe(true)
  })

  test('Given 单文件授权的同目录兄弟文件 When 判定 Then 仍然拒绝（单文件授权不外溢到整目录）', () => {
    expect(isExplicitPreviewFilePath(siblingFile, scope)).toBe(false)
  })

  test('Given 显式根内一个指向根外的符号链接 When 判定 Then 按 realpath 拒绝', () => {
    if (!symlinkAvailable) return
    expect(isExplicitPreviewFilePath(escapeLink, scope)).toBe(false)
  })

  test('Given unrestricted When 判定根外文件 Then 放行', () => {
    expect(isExplicitPreviewFilePath(secretFile, unrestrictedScope)).toBe(true)
  })
})

describe('filterExplicitPreviewBasePaths —— 渲染层给的候选目录不能凭空变成授权根', () => {
  test('Given 候选里混了根外目录 When 过滤 Then 只留显式根内的候选', () => {
    expect(filterExplicitPreviewBasePaths([workspaceDir, outsideDir], scope)).toEqual([workspaceDir])
  })

  test('Given 候选为 undefined When 过滤 Then 返回空数组', () => {
    expect(filterExplicitPreviewBasePaths(undefined, scope)).toEqual([])
  })

  test('Given unrestricted When 过滤 Then 候选原样保留', () => {
    expect(filterExplicitPreviewBasePaths([outsideDir], unrestrictedScope)).toEqual([outsideDir])
  })
})

describe('resolveAuthorizedPreviewPath —— 预览家族六通道的统一入口', () => {
  test('Given 相对路径落在显式候选根内 When 解析 Then 返回真实路径', () => {
    expect(resolveAuthorizedPreviewPath('sub/deep.md', [workspaceDir], scope)).toBe(deepFile)
  })

  test('Given 相对路径用 .. 逃出候选根 When 解析 Then 返回 null', () => {
    expect(resolveAuthorizedPreviewPath('../outside/secret.md', [workspaceDir], scope)).toBeNull()
  })

  test('Given 候选根本身不在显式根内 When 解析其中的相对路径 Then 返回 null（候选被先过滤掉）', () => {
    expect(resolveAuthorizedPreviewPath('secret.md', [outsideDir], scope)).toBeNull()
  })

  test('Given 显式根内的绝对路径 When 解析 Then 返回该路径', () => {
    expect(resolveAuthorizedPreviewPath(insideFile, [workspaceDir], scope)).toBe(insideFile)
  })

  test('Given 根外的绝对路径（S-1 复现形态）When 解析 Then 返回 null', () => {
    expect(resolveAuthorizedPreviewPath(secretFile, [workspaceDir], scope)).toBeNull()
  })

  test('Given 单文件授权的绝对路径 When 解析 Then 放行；其同目录兄弟仍被拒', () => {
    expect(resolveAuthorizedPreviewPath(attachedFile, [workspaceDir], scope)).toBe(attachedFile)
    expect(resolveAuthorizedPreviewPath(siblingFile, [workspaceDir], scope)).toBeNull()
  })

  test('Given 相对路径经符号链接落到根外 When 解析 Then 按 realpath 拒绝', () => {
    if (!symlinkAvailable) return
    expect(resolveAuthorizedPreviewPath('escape.md', [workspaceDir], scope)).toBeNull()
  })

  test('Given unrestricted 的可信 UI 入口 When 解析根外绝对路径 Then 放行', () => {
    expect(resolveAuthorizedPreviewPath(secretFile, [outsideDir], unrestrictedScope)).toBe(secretFile)
  })

  test('Given 文件不存在 When 解析 Then 返回 null', () => {
    expect(resolveAuthorizedPreviewPath('sub/missing.md', [workspaceDir], scope)).toBeNull()
  })

  test('Given 空路径 When 解析 Then 返回 null', () => {
    expect(resolveAuthorizedPreviewPath('', [workspaceDir], scope)).toBeNull()
  })
})

describe('canRegisterPreviewDirectory —— HTML 预览能否整目录注册为 URL 根', () => {
  test('Given HTML 所在目录本身已授权 When 判定 Then 允许整目录注册（相对 CSS/JS/图片可加载）', () => {
    expect(canRegisterPreviewDirectory(insideFile, scope)).toBe(true)
  })

  test('Given 只有单文件授权 When 判定 Then 不允许注册父目录（只注册 HTML 本体）', () => {
    expect(canRegisterPreviewDirectory(attachedFile, scope)).toBe(false)
  })
})
