/**
 * OfficeCLI 分发清单：版本、六平台产物的 SHA-256 与字节数，**全项目唯一真源**。
 *
 * 构建脚本（`scripts/prepare-officecli.ts`）与主进程运行期校验都读这里，避免两处各钉一份
 * 而漂移。升级 OfficeCLI 只改本文件，然后跑 `bun run verify:officecli` 复核。
 *
 * 值的来源：GitHub Release 的官方 `SHA256SUMS` 与 Release API 的 asset size，
 * 二者都必须来自同一个 tag（`https://github.com/iOfficeAI/OfficeCLI/releases/tag/<版本>`）。
 *
 * ⚠️ 该二进制内建自动更新：不带 `OFFICECLI_CHILD_ENV`（见 officecli-manager.ts）直接运行它，
 * 它会联网把自己替换掉——Windows 上留下 `<产物名>.old`，macOS/Linux 后台原地替换。
 * 这会绕过下面这张表的校验，所以运行期还有一道惰性哈希自检。别删任一道。
 *
 * 本文件零依赖（不 import electron / node 内置模块），构建脚本才能直接 import。
 */

export const OFFICECLI_VERSION = 'v1.0.147'

export interface OfficeCliAsset {
  /** Release 资产文件名，用于拼下载地址与核对官方 SHA256SUMS */
  assetName: string
  sha256: string
  sizeBytes: number
}

/** key = `${platform}-${arch}`，与 `process.platform`/`process.arch` 同名 */
export const OFFICECLI_ASSETS: Readonly<Record<string, OfficeCliAsset>> = {
  'darwin-arm64': {
    assetName: 'officecli-mac-arm64',
    sha256: '55569d8a7430c1d8d7872c1661ff8cfea2eeef03ffc4fa8dbee437a4c91ee1ed',
    sizeBytes: 33_793_648,
  },
  'darwin-x64': {
    assetName: 'officecli-mac-x64',
    sha256: '9f957b9439b922916360189bedfb780defc471b95ab8670f2a5a9630e7c9c253',
    sizeBytes: 34_739_072,
  },
  'linux-arm64': {
    assetName: 'officecli-linux-arm64',
    sha256: 'f90c734722fd2f41ae76e72878329f033ed36c132aa741ec44dc3827066c55b9',
    sizeBytes: 34_766_343,
  },
  'linux-x64': {
    assetName: 'officecli-linux-x64',
    sha256: 'e8bfe04f670139f526fe4e81f11acc1bc8629e421a20c5ba7a6e25f7a54a31f7',
    sizeBytes: 35_349_925,
  },
  'win32-arm64': {
    assetName: 'officecli-win-arm64.exe',
    sha256: '7ff0195c32405bac9cf6a32589d984fa7a863adfabbc6e42dfef47a7839264cf',
    sizeBytes: 33_857_460,
  },
  'win32-x64': {
    assetName: 'officecli-win-x64.exe',
    sha256: '724056e5ff079c3585df79c8afc386f08ef7d5f956cf4e2723534e129aab6e80',
    sizeBytes: 33_419_176,
  },
}

export const OFFICECLI_RELEASE_BASE_URL = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${OFFICECLI_VERSION}`

/** 落盘产物名。Windows 带 .exe，其余不带——上游 Release 资产名与它无关，故分开表达。 */
export function getOfficeCliOutputName(platform: string): string {
  return platform === 'win32' ? 'officecli.exe' : 'officecli'
}

export function getOfficeCliAsset(platform: string, arch: string): OfficeCliAsset | undefined {
  return OFFICECLI_ASSETS[`${platform}-${arch}`]
}

export function getOfficeCliDownloadUrl(asset: OfficeCliAsset): string {
  return `${OFFICECLI_RELEASE_BASE_URL}/${asset.assetName}`
}
