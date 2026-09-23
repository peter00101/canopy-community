import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { isPathWithinRoots, isUnderRoot, realpathOrResolve, resolveExistingRealPath } from './file-access-policy'

const isWindows = process.platform === 'win32'

let base: string      // 临时沙箱根（已 realpath，macOS 上 /tmp 是 /private/tmp 的符号链接）
let root: string      // 授权根：<base>/workspace
let outside: string   // 未授权：<base>/outside

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-file-access-')))
  root = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'ok.txt'), 'ok', 'utf-8')
  writeFileSync(join(root, 'sub', 'deep', 'nested.txt'), 'nested', 'utf-8')
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf-8')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** 一次判定，根集合固定为 [root]，同时统计根集合是否被真正取用（惰性验证用） */
function allowed(target: string, extraRoots: string[] = []): boolean {
  return isPathWithinRoots(target, () => [root, ...extraRoots])
}

describe('文件访问授权链：正常路径', () => {
  test('Given 授权根内的文件 / 深层文件 / 根本身 When 判定 Then 全部放行', () => {
    expect(allowed(join(root, 'ok.txt'))).toBe(true)
    expect(allowed(join(root, 'sub', 'deep', 'nested.txt'))).toBe(true)
    expect(allowed(root)).toBe(true)
  })

  test('Given 路径中带 ./ 与冗余分隔符 When 判定 Then 归一化后仍按真实落点放行', () => {
    expect(allowed(join(root, '.', 'sub', '.', 'deep', 'nested.txt'))).toBe(true)
    expect(allowed(root + sep + sep + 'ok.txt')).toBe(true)
  })

  test('Given 多个授权根 When 目标只在第二个根下 Then 放行', () => {
    expect(isPathWithinRoots(join(outside, 'secret.txt'), () => [root, outside])).toBe(true)
  })

  test('Given 授权根本身是一个文件（附加文件） When 判定 Then 只放行该文件本身、不放行同目录邻居', () => {
    const fileRoot = join(outside, 'secret.txt')
    writeFileSync(join(outside, 'secret2.txt'), 'x', 'utf-8')
    expect(isPathWithinRoots(fileRoot, () => [fileRoot])).toBe(true)
    expect(isPathWithinRoots(join(outside, 'secret2.txt'), () => [fileRoot])).toBe(false)
    expect(isPathWithinRoots(outside, () => [fileRoot])).toBe(false)
  })
})

describe('文件访问授权链：穿越与逃逸（必须全部拒绝）', () => {
  test('Given .. 上跳到根外的真实文件 When 判定 Then 拒绝', () => {
    expect(allowed(join(root, '..', 'outside', 'secret.txt'))).toBe(false)
    expect(allowed(join(root, 'sub', '..', '..', 'outside', 'secret.txt'))).toBe(false)
  })

  test('Given 与根同前缀的邻居目录（workspace-evil） When 判定 Then 拒绝（前缀陷阱）', () => {
    const evil = join(base, 'workspace-evil')
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, 'x.txt'), 'x', 'utf-8')
    expect(allowed(join(evil, 'x.txt'))).toBe(false)
    expect(isUnderRoot(join(evil, 'x.txt'), root)).toBe(false)
  })

  test('Given 根内的符号链接指向根外目录 When 判定链接内文件 Then 按真实落点拒绝', () => {
    const link = join(root, 'escape-link')
    try {
      // Windows 上目录 junction 无需管理员权限；其它平台用普通目录符号链接
      symlinkSync(outside, link, isWindows ? 'junction' : 'dir')
    } catch (error) {
      console.warn('[测试] 无法创建符号链接，跳过本用例:', (error as Error).message)
      return
    }
    expect(allowed(join(link, 'secret.txt'))).toBe(false)
    // 反向：根外的链接指回根内 → 真实落点在根内，放行
    const inboundLink = join(outside, 'into-workspace')
    symlinkSync(root, inboundLink, isWindows ? 'junction' : 'dir')
    expect(allowed(join(inboundLink, 'ok.txt'))).toBe(true)
  })

  test('Given 不存在的路径 When 判定 Then 拒绝（即使字面上在根内）', () => {
    expect(allowed(join(root, 'ghost.txt'))).toBe(false)
    expect(resolveExistingRealPath(join(root, 'ghost.txt'))).toBeNull()
  })

  test('Given 根集合为空 When 判定存在的文件 Then 拒绝', () => {
    expect(isPathWithinRoots(join(root, 'ok.txt'), () => [])).toBe(false)
  })

  test('Given 相对路径 When 判定 Then 按进程 cwd 解析后比对，不会因为「看起来相对」就放行', () => {
    // 相对路径解析到 cwd（仓库目录），不在临时根之下 → 拒绝
    expect(allowed('package.json')).toBe(false)
  })
})

describe('文件访问授权链：跨盘 / UNC / 大小写（isUnderRoot 直接判定）', () => {
  test('Given 目标在另一个盘符或 UNC 共享上 When 判定 Then relative() 结果为绝对路径 → 拒绝', () => {
    if (isWindows) {
      expect(isUnderRoot('D:\elsewhere\file.txt', 'C:\workspace')).toBe(false)
      expect(isUnderRoot('\\server\share\dir\file.txt', 'C:\workspace')).toBe(false)
      expect(isUnderRoot('C:\workspace\file.txt', '\\server\share\workspace')).toBe(false)
    } else {
      // POSIX 没有盘符，退化验证：完全不相干的绝对路径被拒绝
      expect(isUnderRoot('/etc/passwd', root)).toBe(false)
    }
  })

  test('Given Windows 上大小写不同的同一路径 When 判定 Then 放行（NTFS 不区分大小写，path.relative 也按此比较）', () => {
    if (!isWindows) return
    const upperRoot = root.toUpperCase()
    const lowerFile = join(root, 'ok.txt').toLowerCase()
    expect(isPathWithinRoots(lowerFile, () => [upperRoot])).toBe(true)
  })
})

describe('文件访问授权链：unrestricted 与惰性', () => {
  test('Given unrestricted When 目标存在 Then 放行且根本不去收集根集合', () => {
    let rootsAsked = 0
    const ok = isPathWithinRoots(join(outside, 'secret.txt'), () => { rootsAsked++; return [root] }, true)
    expect(ok).toBe(true)
    expect(rootsAsked).toBe(0)
  })

  test('Given unrestricted When 目标不存在 Then 仍然拒绝（保留「必须存在」校验）', () => {
    expect(isPathWithinRoots(join(root, 'ghost.txt'), () => [root], true)).toBe(false)
  })

  test('Given 目标不存在 When 判定 Then 不收集根集合（省一次会话索引读取）', () => {
    let rootsAsked = 0
    expect(isPathWithinRoots(join(root, 'ghost.txt'), () => { rootsAsked++; return [root] })).toBe(false)
    expect(rootsAsked).toBe(0)
  })
})

describe('realpathOrResolve', () => {
  test('Given 存在的符号链接 When 解析 Then 得到真实落点；不存在的路径退化为 resolve', () => {
    expect(realpathOrResolve(join(root, 'sub', '..', 'ok.txt'))).toBe(join(root, 'ok.txt'))
    expect(realpathOrResolve(join(root, 'nope', '..', 'nope2'))).toBe(join(root, 'nope2'))
  })
})
