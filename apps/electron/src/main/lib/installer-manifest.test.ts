import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_INSTALLER_MANIFEST,
  fetchInstallerManifest,
  findInstallerSource,
  isRemoteInstallerManifestConfigured,
} from './installer-manifest'

const SHA256_HEX = /^[0-9a-f]{64}$/

describe('安装包清单：未配置远程服务', () => {
  test('Given CANOPY_API_BASE 为空 When 拉取清单 Then 不发任何网络请求，直接返回内置清单', async () => {
    let fetchCalls = 0
    const spyFetch = (async () => { fetchCalls++; throw new Error('不应被调用') }) as unknown as typeof fetch

    const manifest = await fetchInstallerManifest(true, spyFetch)

    expect(fetchCalls).toBe(0)
    expect(manifest).toBe(BUILTIN_INSTALLER_MANIFEST)
  })

  test('Given 默认常量 When 判定 Then 远程清单视为未配置', () => {
    expect(isRemoteInstallerManifestConfigured()).toBe(false)
    expect(isRemoteInstallerManifestConfigured('   ')).toBe(false)
    expect(isRemoteInstallerManifestConfigured('https://api.example.com')).toBe(true)
  })
})

describe('内置清单的完整性校验值', () => {
  test('Given 内置清单 When 逐条检查 Then 每个条目都有 64 位十六进制 sha256、真实文件大小与官方直链', () => {
    expect(BUILTIN_INSTALLER_MANIFEST.installers.length).toBe(4)
    for (const source of BUILTIN_INSTALLER_MANIFEST.installers) {
      expect(source.sha256).toMatch(SHA256_HEX)
      expect(source.sizeBytes).toBeGreaterThan(20 * 1024 * 1024)
      expect(source.fallbackUrl).toMatch(/^https:\/\/(github\.com|nodejs\.org)\//)
      expect(source.fallbackUrl.endsWith(source.filename)).toBe(true)
    }
  })

  test('Given Git for Windows 2.47.1 When 取 x64/arm64 Then sha256 与 GitHub 官方 Release 正文一致', () => {
    // 来源：https://github.com/git-for-windows/git/releases/tag/v2.47.1.windows.1 正文的 SHA-256 表；
    // 2026-08-16 另从 npmmirror 下载真实二进制实算比对一致
    expect(findInstallerSource(BUILTIN_INSTALLER_MANIFEST, 'git-for-windows', 'x64')?.sha256)
      .toBe('25527923debc06515b3016f2d6bca0820656e8281a23be2f43bfb658bd5dda70')
    expect(findInstallerSource(BUILTIN_INSTALLER_MANIFEST, 'git-for-windows', 'arm64')?.sha256)
      .toBe('63950d69998ca184b0ade0389a0e0b50e62f4a1ea8da9752449193c9dcda569f')
  })

  test('Given Node.js 22.13.1 When 取 x64/arm64 Then sha256 与 nodejs.org SHASUMS256.txt 一致', () => {
    // 来源：https://nodejs.org/dist/v22.13.1/SHASUMS256.txt；npmmirror 同名文件交叉一致
    expect(findInstallerSource(BUILTIN_INSTALLER_MANIFEST, 'nodejs', 'x64')?.sha256)
      .toBe('821566022dc3b262ac2f76598ee4f46003a6edafe5dadb84e5fbc7daaa1a78c7')
    expect(findInstallerSource(BUILTIN_INSTALLER_MANIFEST, 'nodejs', 'arm64')?.sha256)
      .toBe('be127be1d98cad94c56f46245d0f2de89934d300028694456861a6d5ac558bf3')
  })
})

describe('findInstallerSource', () => {
  test('Given 不存在的 id 或架构 When 查找 Then 返回 undefined 而不是抛错', () => {
    expect(findInstallerSource(BUILTIN_INSTALLER_MANIFEST, 'python', 'x64')).toBeUndefined()
    expect(findInstallerSource({ installers: [] }, 'nodejs', 'arm64')).toBeUndefined()
  })
})
