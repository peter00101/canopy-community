import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OFFICECLI_CHILD_ENV } from './officecli-manager'
import { OFFICECLI_ASSETS, OFFICECLI_VERSION, getOfficeCliAsset, getOfficeCliOutputName } from './officecli-manifest'

describe('OFFICECLI_CHILD_ENV — 自更新抑制开关', () => {
  it('Given 子进程环境常量，When 读取，Then 三个开关齐全且都是字符串 "1"', () => {
    // 上游是 `!== "1"` 的字符串比较，写成布尔或数字都不生效。
    expect(OFFICECLI_CHILD_ENV).toEqual({
      OFFICECLI_SKIP_UPDATE: '1',
      OFFICECLI_NO_AUTO_INSTALL: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1',
    })
  })

  it('Given 该常量，When 尝试改写，Then 被冻结改不动（防调用方就地删键）', () => {
    expect(Object.isFrozen(OFFICECLI_CHILD_ENV)).toBe(true)
  })
})

describe('officecli-manifest — 钉死清单自洽性', () => {
  it('Given 清单，When 检查，Then 六个平台齐全且键名与 process.platform-arch 同构', () => {
    expect(Object.keys(OFFICECLI_ASSETS).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ])
  })

  it('Given 每个资产，When 检查，Then sha256 是 64 位十六进制、体积在合理量级', () => {
    for (const [key, asset] of Object.entries(OFFICECLI_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.sizeBytes, key).toBeGreaterThan(20_000_000)
      expect(asset.sizeBytes, key).toBeLessThan(50 * 1024 * 1024) // prepare 脚本的下载上限
    }
  })

  it('Given 六个资产，When 比对哈希，Then 互不相同（防复制粘贴时漏改一处）', () => {
    const hashes = Object.values(OFFICECLI_ASSETS).map((a) => a.sha256)
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('Given 平台，When 求产物名，Then 只有 win32 带 .exe', () => {
    expect(getOfficeCliOutputName('win32')).toBe('officecli.exe')
    expect(getOfficeCliOutputName('darwin')).toBe('officecli')
    expect(getOfficeCliOutputName('linux')).toBe('officecli')
  })

  it('Given 不支持的平台组合，When 查资产，Then 返回 undefined 而不是抛错', () => {
    expect(getOfficeCliAsset('freebsd', 'x64')).toBeUndefined()
  })

  it('Given 版本号，When 检查，Then 是 v 前缀的三段式（下载地址直接靠它拼）', () => {
    expect(OFFICECLI_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
  })
})

/**
 * 静态调用点断言：officecli 二进制的执行必须只发生在 officecli-manager.ts 里。
 *
 * 这是仓库既有「残留三查」习惯的自动化版本。漏带 OFFICECLI_CHILD_ENV 的后果是
 * 二进制在**用户机器上**联网自我替换，绕过构建期钉死的哈希——typecheck 抓不到，
 * 混跑测试也抓不到，只能靠这条守着。
 */
describe('调用点收敛 — 只有 officecli-manager 能执行该二进制', () => {
  const libDir = __dirname

  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...listSourceFiles(full))
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        out.push(full)
      }
    }
    return out
  }

  it('Given src/main/lib 全部源码，When 搜 execFile/spawn 且同文件提到 officecli，Then 只允许 officecli-manager.ts', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(libDir)) {
      if (file.endsWith('officecli-manager.ts') || file.endsWith('.test.ts')) continue
      const source = readFileSync(file, 'utf-8')
      if (!/officecli/i.test(source)) continue
      // 只在同时出现「子进程执行」与「officecli」时判为违规；单纯 import 路径常量不算。
      if (/\b(execFile|execFileSync|spawn|spawnSync|exec)\s*\(/.test(source)) {
        offenders.push(file.slice(libDir.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('Given 全部源码，When 搜三个环境变量名，Then 只出现在 officecli-manager.ts（唯一真源）', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(libDir)) {
      if (file.endsWith('officecli-manager.ts') || file.endsWith('officecli-manager.test.ts')) continue
      if (/OFFICECLI_SKIP_UPDATE|OFFICECLI_NO_AUTO_INSTALL|OFFICECLI_NO_AUTO_RESIDENT/.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file.slice(libDir.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})
