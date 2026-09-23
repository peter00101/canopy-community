#!/usr/bin/env bun
/**
 * 准备随 Canopy 安装包分发的 OfficeCLI 二进制。
 *
 * 每次 Electron build / dev 启动前按当前构建目标的平台与架构从 OfficeCLI 官方 GitHub
 * Release 取得固定版本，流式校验文件大小及 SHA-256，再原子写入 resources/officecli/。
 * 对交叉架构打包，可通过 OFFICECLI_PLATFORM / OFFICECLI_ARCH 指定安装包目标；默认使用宿主。
 * 该目录被 gitignore，避免将大体积第三方二进制提交进源码仓库。
 *
 * 版本与六平台哈希的唯一真源是 `src/main/lib/officecli-manifest.ts`（主进程运行期自检也读它）。
 *
 * 两种模式：
 *   - 默认：缺失或不匹配就下载，最后断言目录里恰好只剩产物本身。
 *   - `--verify-only`：**不联网、不下载**，只校验现状；供打包链在 electron-builder 之前
 *     兜最后一道——prepare 之后到打包之间还有一大段手工步骤，
 *     期间二进制可能被自更新换掉或混入残留。
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isOfficeCliDirectoryClean, pickUnexpectedOfficeCliEntries } from './stale-download-files'
import {
  OFFICECLI_VERSION,
  getOfficeCliAsset,
  getOfficeCliDownloadUrl,
  getOfficeCliOutputName,
  type OfficeCliAsset,
} from '../src/main/lib/officecli-manifest'

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024
const OUTPUT_DIR = join(resolve(import.meta.dir, '..'), 'resources', 'officecli')
const targetPlatform = process.env.OFFICECLI_PLATFORM || process.platform
const targetArch = process.env.OFFICECLI_ARCH || process.arch
const outputName = getOfficeCliOutputName(targetPlatform)
const verifyOnly = process.argv.includes('--verify-only')

function fail(message: string): never {
  console.error(`[${verifyOnly ? 'verify' : 'prepare'}:officecli] ${message}`)
  process.exit(1)
}

function isAllowedDownloadUrl(url: URL): boolean {
  return url.protocol === 'https:' && (
    url.hostname === 'github.com'
    || url.hostname === 'objects.githubusercontent.com'
    || url.hostname === 'release-assets.githubusercontent.com'
    || url.hostname === 'github-releases.githubusercontent.com'
    || url.hostname.endsWith('.githubusercontent.com')
  )
}

async function fetchOfficialAsset(url: string): Promise<Response> {
  let target = new URL(url)
  for (let redirectsLeft = 5; redirectsLeft >= 0; redirectsLeft--) {
    if (!isAllowedDownloadUrl(target)) fail(`下载地址不受信任：${target.hostname}`)
    const response = await fetch(target, { redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirectsLeft === 0) fail('下载重定向无效或次数过多')
      target = new URL(location, target)
      continue
    }
    if (!response.ok) fail(`下载失败：HTTP ${response.status}`)
    return response
  }
  fail('下载重定向次数过多')
}

async function verifyExisting(filePath: string, asset: OfficeCliAsset): Promise<boolean> {
  try {
    if (!existsSync(filePath) || statSync(filePath).size !== asset.sizeBytes) return false
    const hash = new Bun.CryptoHasher('sha256')
    hash.update(await Bun.file(filePath).arrayBuffer())
    return hash.digest('hex').toLowerCase() === asset.sha256
  } catch {
    return false
  }
}

async function downloadAndVerify(asset: OfficeCliAsset, destination: string): Promise<void> {
  const response = await fetchOfficialAsset(getOfficeCliDownloadUrl(asset))
  if (!response.body) fail('下载响应为空')
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_DOWNLOAD_SIZE) fail('下载文件超过安全大小上限')

  const file = await open(destination, 'w', 0o700)
  const hash = createHash('sha256')
  let downloaded = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      downloaded += value.byteLength
      if (downloaded > MAX_DOWNLOAD_SIZE) fail('下载文件超过安全大小上限')
      hash.update(value)
      await file.write(value)
    }
  } finally {
    await file.close()
  }

  if (downloaded !== asset.sizeBytes) fail(`下载文件大小不匹配：预期 ${asset.sizeBytes}，实际 ${downloaded}`)
  const actual = hash.digest('hex')
  if (actual.toLowerCase() !== asset.sha256) fail(`SHA-256 校验失败：预期 ${asset.sha256}，实际 ${actual}`)
}

const key = `${targetPlatform}-${targetArch}`
const asset = getOfficeCliAsset(targetPlatform, targetArch)
if (!asset) fail(`当前构建目标不受支持：${key}`)
const outputPath = join(OUTPUT_DIR, outputName)

if (targetPlatform !== process.platform) {
  fail(`OfficeCLI 资源必须在目标平台 Runner 上准备：目标 ${targetPlatform}，当前 ${process.platform}`)
}

if (verifyOnly) {
  if (!existsSync(OUTPUT_DIR)) fail(`资源目录不存在：${OUTPUT_DIR}（先跑 bun run prepare:officecli）`)
  const entries = await readdir(OUTPUT_DIR)
  if (!isOfficeCliDirectoryClean(entries, outputName)) {
    fail(`资源目录不干净，期望只有 ${outputName}，实际：${entries.join(', ') || '（空）'}`)
  }
  if (!await verifyExisting(outputPath, asset)) {
    fail(`${outputName} 与钉死的 ${OFFICECLI_VERSION}（${key}）不一致。交叉架构打包请确认带了 OFFICECLI_ARCH（如 OFFICECLI_ARCH=x64）；架构无误则是被自更新替换过，跑 bun run prepare:officecli 重取`)
  }
  console.log(`[verify:officecli] ${OFFICECLI_VERSION}（${key}）校验通过，目录干净`)
  process.exit(0)
}

await mkdir(OUTPUT_DIR, { recursive: true })
// 目录由本脚本独占、被 gitignore、完全可再生，所以口径是白名单：除产物本身外一律清掉。
// 见过两类残留：下载被外力打断的 .download-* 半成品（0.18.33 有 9.9MB 进了包）、
// 二进制自更新留下的 .old（Windows 删不掉运行中的映像，33MB）。
for (const stale of pickUnexpectedOfficeCliEntries(await readdir(OUTPUT_DIR), outputName)) {
  await rm(join(OUTPUT_DIR, stale), { recursive: true, force: true })
  console.warn(`[prepare:officecli] 已清理非预期文件 ${stale}`)
}
if (await verifyExisting(outputPath, asset)) {
  if (targetPlatform !== 'win32') await chmod(outputPath, 0o755)
  console.log(`[prepare:officecli] 已验证 ${OFFICECLI_VERSION}（${key}）`)
} else {
  const temporaryPath = `${outputPath}.download-${process.pid}-${Date.now()}`
  try {
    console.log(`[prepare:officecli] 下载并校验 ${OFFICECLI_VERSION}（${key}）`)
    await downloadAndVerify(asset, temporaryPath)
    if (targetPlatform !== 'win32') await chmod(temporaryPath, 0o755)
    await rename(temporaryPath, outputPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

// 收尾强断言：进包走的是 electron-builder 的 extraResources（from: resources/officecli，
// filter: **/*），目录里剩什么就打进包什么。下载过程本身也可能留下新的临时文件。
const finalEntries = await readdir(OUTPUT_DIR)
if (!isOfficeCliDirectoryClean(finalEntries, outputName)) {
  fail(`收尾检查失败：资源目录应只有 ${outputName}，实际：${finalEntries.join(', ')}`)
}

// dev 态读的是 build:resources 拷出来的 dist/resources 副本（officecli-manager 走
// __dirname/resources），而 `cp -R` 只合并不删除：升级版本后旧副本会留在那里，
// 触发运行期完整性自检把 OfficeCLI 整个停用（表现为 Agent 说「工具被环境停用」）。
// 这里顺手清掉陈旧副本，让下一次 build:resources 拷一份新的。
const DEV_MIRROR_DIR = join(resolve(import.meta.dir, '..'), 'dist', 'resources', 'officecli')
if (existsSync(DEV_MIRROR_DIR)) {
  for (const entry of await readdir(DEV_MIRROR_DIR)) {
    const mirrored = join(DEV_MIRROR_DIR, entry)
    if (entry !== outputName || statSync(mirrored).size !== asset.sizeBytes) {
      await rm(mirrored, { recursive: true, force: true })
      console.warn(`[prepare:officecli] 已清理 dev 副本中的陈旧文件 dist/resources/officecli/${entry}`)
    }
  }
}
