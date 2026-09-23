/**
 * Installer Manifest 客户端
 *
 * 「第三方安装包清单」：Windows 用户缺 Git Bash / Node.js 时，Canopy 帮他下载官方安装包并打开
 * 安装器（入口：环境检测卡片 EnvironmentCheckCard、Agent 工具 InstallWindowsShell）。清单告诉
 * 客户端「从哪下 + sha256」。
 *
 * 上游用远程清单是为了走自家 OSS 国内加速镜像。我方目前没有这个服务端：
 * - `CANOPY_API_BASE` 为空 → **直接用内置清单，不发任何网络请求**（0.17.24 前会先白发一次必失败的
 *   `fetch('/api/v1/...')`、刷一条 warn 再回退，见审查报告 B-4）；
 * - 将来服务端真做了 `/api/v1/installers/manifest` + 安装包镜像，填上常量即可启用远程清单
 *   （5 分钟缓存 + 失败回退内置），客户端代码不用再改。
 *
 * 内置清单的 sha256 全部为**官方发布值**（Git：GitHub Release 正文；Node：nodejs.org SHASUMS256.txt），
 * 2026-08-16 另经 npmmirror 下载真实二进制实算交叉核对一致。升级版本时两处都要换。
 */

import type { InstallerManifest, InstallerSource } from '@canopy/shared'
import { CANOPY_BRAND } from '@canopy/brand'

/** 远程清单服务的根地址；留空 = 只用内置清单（不发请求）。 */
const CANOPY_API_BASE = ''
const MANIFEST_URL = `${CANOPY_API_BASE}/api/v1/installers/manifest`
const CACHE_TTL_MS = 5 * 60 * 1000

interface ManifestCache {
  data: InstallerManifest
  timestamp: number
}

let cache: ManifestCache | null = null

/**
 * 内置清单：官方上游直链 + 官方 sha256（下载器据此做完整性校验）。
 * `downloadUrl` 留空表示没有加速镜像，下载器走 `fallbackUrl`。
 */
export const BUILTIN_INSTALLER_MANIFEST: InstallerManifest = {
  installers: [
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'x64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe',
      sha256: '25527923debc06515b3016f2d6bca0820656e8281a23be2f43bfb658bd5dda70',
      sizeBytes: 69109976,
      filename: 'Git-2.47.1-64-bit.exe',
    },
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'arm64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-arm64.exe',
      sha256: '63950d69998ca184b0ade0389a0e0b50e62f4a1ea8da9752449193c9dcda569f',
      sizeBytes: 67168280,
      filename: 'Git-2.47.1-arm64.exe',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'x64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi',
      sha256: '821566022dc3b262ac2f76598ee4f46003a6edafe5dadb84e5fbc7daaa1a78c7',
      sizeBytes: 30867456,
      filename: 'node-v22.13.1-x64.msi',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'arm64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-arm64.msi',
      sha256: 'be127be1d98cad94c56f46245d0f2de89934d300028694456861a6d5ac558bf3',
      sizeBytes: 27312128,
      filename: 'node-v22.13.1-arm64.msi',
    },
  ],
}

/** 是否配置了远程清单服务（纯判定，便于测试）。 */
export function isRemoteInstallerManifestConfigured(apiBase: string = CANOPY_API_BASE): boolean {
  return apiBase.trim().length > 0
}

/**
 * 拉取安装包清单：未配置远程服务时直接返回内置清单；配置了则优先远程（5 分钟缓存），失败回退内置。
 * `fetchImpl` 仅供测试注入。
 */
export async function fetchInstallerManifest(
  force = false,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallerManifest> {
  if (!isRemoteInstallerManifestConfigured()) {
    return BUILTIN_INSTALLER_MANIFEST
  }

  if (!force && cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  try {
    const response = await fetchImpl(MANIFEST_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': `${CANOPY_BRAND.userAgentProduct}-Desktop`,
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as InstallerManifest
    if (!data || !Array.isArray(data.installers)) {
      throw new Error('Manifest format invalid')
    }

    cache = { data, timestamp: Date.now() }
    console.log(`[Installer Manifest] 远程清单获取成功，共 ${data.installers.length} 项`)
    return data
  } catch (error) {
    console.warn(
      `[Installer Manifest] 远程清单获取失败，降级到内置清单:`,
      error,
    )
    // 不缓存内置清单，下一次仍然先试远程
    return BUILTIN_INSTALLER_MANIFEST
  }
}

/**
 * 从清单中挑出匹配指定 (id, arch) 的条目
 */
export function findInstallerSource(
  manifest: InstallerManifest,
  id: string,
  arch: 'x64' | 'arm64',
): InstallerSource | undefined {
  return manifest.installers.find((s) => s.id === id && s.arch === arch)
}
