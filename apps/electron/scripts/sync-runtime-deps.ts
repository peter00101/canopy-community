#!/usr/bin/env bun
/**
 * 同步 Electron 打包时需要保留为 external 的主进程运行时依赖。
 *
 * Bun workspace 会把依赖 hoist 到仓库根 node_modules；electron-builder 的 files
 * 规则以 apps/electron 为 appDir，因此打包前需要把 external 依赖闭包复制到
 * apps/electron/node_modules，保证 packaged app 中 Node 模块解析可用。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface RuntimeDependency {
  name: string
  optional: boolean
  /** 父包 manifest 里声明的版本范围；解析时必须匹配（0.17.26 mac 包 highlight.js 10↔11 撞版事故） */
  range: string
}

interface SyncContext {
  sourceNodeModules: string
  targetNodeModules: string
  copiedPackages: Map<string, string>
  topLevelPackageSources: Map<string, string>
  skippedOptionalPackages: string[]
}

export interface SyncRuntimeDepsOptions {
  sourceNodeModules?: string
  targetNodeModules?: string
  externalRuntimePackages?: readonly string[]
  /** 是否在同步前清空目标 node_modules；打包需要 true，开发启动使用 false 避免破坏本地调试内容。 */
  cleanTarget?: boolean
}

export interface SyncRuntimeDepsResult {
  copiedPackageCount: number
  copiedPackages: string[]
  skippedOptionalPackages: string[]
}

export const EXTERNAL_RUNTIME_PACKAGES: readonly string[] = [
  '@earendil-works/pi-coding-agent',
  // 0.85.0 曾因误发布的 experimental 层 import @earendil-works/pi-server 而必须手工补列它；
  // 0.85.1 起该层已从发布包移除、dist 里零引用，不再随包分发。
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'pdfjs-dist',
  'sharp',
  // 独立 Terminal utility process 通过 require 加载其 native PTY binding。
  'node-pty',
]

const appDir = resolve(import.meta.dir, '..')
const repoRoot = resolve(appDir, '../..')
const repoNodeModules = join(repoRoot, 'node_modules')
const bunVirtualNodeModules = join(repoNodeModules, '.bun', 'node_modules')
const defaultSourceNodeModules = existsSync(bunVirtualNodeModules) ? bunVirtualNodeModules : repoNodeModules
const defaultTargetNodeModules = join(appDir, 'node_modules')

function getPackageDir(nodeModulesDir: string, packageName: string): string {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/')
    const scope = parts[0]
    const name = parts[1]
    if (!scope || !name) throw new Error(`非法 scoped package 名称: ${packageName}`)
    return join(nodeModulesDir, scope, name)
  }
  return join(nodeModulesDir, packageName)
}

function resolvePackageFromNodeModules(nodeModulesDir: string, packageName: string): string | undefined {
  const packageDir = getPackageDir(nodeModulesDir, packageName)
  if (existsSync(join(packageDir, 'package.json'))) {
    return realpathSync(packageDir)
  }
  return undefined
}

function resolvePackageUpwards(startDir: string, packageName: string): string | undefined {
  let currentDir = resolve(startDir)

  while (true) {
    const resolvedPackageDir = resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName)
    if (resolvedPackageDir) return resolvedPackageDir

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return undefined
    currentDir = parentDir
  }
}

function resolvePackageSourceDir(ctx: SyncContext, packageName: string, resolveFromDir?: string): string | undefined {
  if (resolveFromDir) {
    const parentResolvedDir = resolvePackageUpwards(resolveFromDir, packageName)
    if (parentResolvedDir) return parentResolvedDir
  }

  for (const nodeModulesDir of [ctx.sourceNodeModules, bunVirtualNodeModules, repoNodeModules]) {
    const resolvedPackageDir = resolvePackageFromNodeModules(nodeModulesDir, packageName)
    if (resolvedPackageDir) return resolvedPackageDir
  }

  return undefined
}

/**
 * 收集一个依赖名的全部候选来源（按解析优先级排序、按 realpath 去重）：
 * ① 从父包目录逐级向上的每个 node_modules；② 三个根来源；③ bun isolated store 的按版本目录
 * （`node_modules/.bun/<name>@<version>/node_modules/<name>`，scoped 包的 `/` 记作 `+`）。
 *
 * 为什么要收集全部而不是取第一个：bun 在不同版本/平台上的物理铺平不同（Windows bun 1.3.9 会给
 * pi-coding-agent 落嵌套的 highlight.js@10.7.3，mac bun 1.3.14 走 .bun 虚拟目录），
 * 「就近第一个」在 mac 上解析到被 hoist 的 11.11.1——11 的 exports 映射没有 `./lib/index.js`，
 * pi-coding-agent 的 `import "highlight.js/lib/index.js"` 在打好的包里直接
 * ERR_PACKAGE_PATH_NOT_EXPORTED，Agent 每条消息都在发送前中止（0.17.26 mac 事故）。
 */
function collectPackageSourceCandidates(ctx: SyncContext, packageName: string, resolveFromDir?: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (dir: string | undefined): void => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    candidates.push(dir)
  }

  if (resolveFromDir) {
    let currentDir = resolve(resolveFromDir)
    while (true) {
      push(resolvePackageFromNodeModules(join(currentDir, 'node_modules'), packageName))
      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
    }
  }

  for (const nodeModulesDir of [ctx.sourceNodeModules, bunVirtualNodeModules, repoNodeModules]) {
    push(resolvePackageFromNodeModules(nodeModulesDir, packageName))
  }

  // bun isolated store：目录名形如 highlight.js@10.7.3 / @scope+name@1.2.3（可能带 peer hash 后缀）
  const bunStoreDir = join(repoNodeModules, '.bun')
  if (existsSync(bunStoreDir)) {
    const storeKeyPrefix = `${packageName.replace('/', '+')}@`
    let entries: string[] = []
    try { entries = readdirSync(bunStoreDir) } catch { entries = [] }
    for (const entry of entries) {
      if (!entry.startsWith(storeKeyPrefix)) continue
      push(resolvePackageFromNodeModules(join(bunStoreDir, entry, 'node_modules'), packageName))
    }
  }

  return candidates
}

/** range 无法按 semver 处理（workspace:/npm:/git 等）时回退到首个候选，与旧行为一致 */
function pickVersionMatchedSourceDir(candidates: string[], range: string): { dir?: string; found: string[] } {
  const found: string[] = []
  let rangeIsUsable = true
  try { Bun.semver.satisfies('1.0.0', range) } catch { rangeIsUsable = false }
  if (!rangeIsUsable || range.startsWith('workspace:') || range.startsWith('npm:')) {
    return { dir: candidates[0], found }
  }
  for (const dir of candidates) {
    let version = ''
    try { version = readPackageManifest(dir).version ?? '' } catch { /* 损坏的候选跳过 */ }
    found.push(`${version || '?'} (${dir})`)
    if (version && Bun.semver.satisfies(version, range)) return { dir, found }
  }
  return { dir: undefined, found }
}

function readPackageManifest(sourceDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as PackageManifest
}

function listRuntimeDependencies(manifest: PackageManifest): RuntimeDependency[] {
  const dependencies = Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({ name, optional: false, range }))
  const optionalDependencies = Object.entries(manifest.optionalDependencies ?? {}).map(([name, range]) => ({ name, optional: true, range }))
  return [...dependencies, ...optionalDependencies]
}

function copyPackage(
  ctx: SyncContext,
  packageName: string,
  optional = false,
  resolveFromDir?: string,
  targetNodeModules = ctx.targetNodeModules,
  sourceAncestors = new Set<string>(),
  preResolvedSourceDir?: string,
): void {
  const sourceDir = preResolvedSourceDir ?? resolvePackageSourceDir(ctx, packageName, resolveFromDir)
  if (!sourceDir) {
    if (optional) {
      ctx.skippedOptionalPackages.push(packageName)
      return
    }
    throw new Error(`缺少运行时依赖: ${packageName} (${getPackageDir(ctx.sourceNodeModules, packageName)})`)
  }
  const manifest = readPackageManifest(sourceDir)
  const isTopLevel = targetNodeModules === ctx.targetNodeModules

  const targetDir = getPackageDir(targetNodeModules, packageName)
  const targetKey = resolve(targetDir)
  const existingSourceDir = ctx.copiedPackages.get(targetKey)
  if (existingSourceDir) {
    if (existingSourceDir === sourceDir) return
    throw new Error(`运行时依赖版本冲突: ${packageName} 已复制自 ${existingSourceDir}，又解析到 ${sourceDir}`)
  }

  ctx.copiedPackages.set(targetKey, sourceDir)
  if (isTopLevel) ctx.topLevelPackageSources.set(packageName, sourceDir)

  mkdirSync(dirname(targetDir), { recursive: true })
  rmSync(targetDir, { recursive: true, force: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    force: true,
    preserveTimestamps: true,
  })

  const nextAncestors = new Set(sourceAncestors)
  nextAncestors.add(sourceDir)
  for (const dependency of listRuntimeDependencies(manifest)) {
    copyDependency(ctx, dependency, sourceDir, targetDir, nextAncestors)
  }
}

function copyDependency(
  ctx: SyncContext,
  dependency: RuntimeDependency,
  parentSourceDir: string,
  parentTargetDir: string,
  sourceAncestors: Set<string>,
): void {
  // 版本必须匹配父包声明的范围：同名不同版本的包在仓库里可能并存（highlight.js 10.7.3 / 11.11.1），
  // 「就近第一个」会随 bun 版本/平台的铺平差异静默选错，打出一启动 Agent 就废的包（0.17.26 mac 事故）。
  const candidates = collectPackageSourceCandidates(ctx, dependency.name, parentSourceDir)
  const { dir: sourceDir, found } = pickVersionMatchedSourceDir(candidates, dependency.range)
  if (!sourceDir) {
    if (dependency.optional) {
      ctx.skippedOptionalPackages.push(dependency.name)
      return
    }
    const detail = found.length > 0 ? `；磁盘上找到的版本均不匹配: ${found.join(', ')}` : ''
    throw new Error(`缺少满足 "${dependency.range}" 的运行时依赖: ${dependency.name}（父包 ${parentSourceDir}）${detail}`)
  }

  if (sourceAncestors.has(sourceDir)) return

  const topLevelSourceDir = ctx.topLevelPackageSources.get(dependency.name)
  if (!topLevelSourceDir || topLevelSourceDir === sourceDir) {
    copyPackage(ctx, dependency.name, dependency.optional, parentSourceDir, ctx.targetNodeModules, sourceAncestors, sourceDir)
    return
  }

  copyPackage(
    ctx,
    dependency.name,
    dependency.optional,
    parentSourceDir,
    join(parentTargetDir, 'node_modules'),
    sourceAncestors,
    sourceDir,
  )
}

function assertNoAbsoluteSymlinks(dir: string): void {
  if (!existsSync(dir)) return
  const stack = [dir]
  const offenders: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        if (target.startsWith('/')) offenders.push(fullPath)
        continue
      }
      if (stat.isDirectory()) stack.push(fullPath)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`检测到绝对 symlink，会导致打包后模块解析失效: ${offenders.slice(0, 10).join(', ')}`)
  }
}

function prepareTargetNodeModules(sourceNodeModules: string, targetNodeModules: string): void {
  const source = resolve(sourceNodeModules)
  const target = resolve(targetNodeModules)
  if (source === target) {
    throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免误删源依赖')
  }
  if (basename(target) !== 'node_modules') {
    throw new Error(`拒绝清理非 node_modules 目录: ${target}`)
  }

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
}

export function syncRuntimeDeps(options: SyncRuntimeDepsOptions = {}): SyncRuntimeDepsResult {
  const ctx: SyncContext = {
    sourceNodeModules: options.sourceNodeModules ?? defaultSourceNodeModules,
    targetNodeModules: options.targetNodeModules ?? defaultTargetNodeModules,
    copiedPackages: new Map<string, string>(),
    topLevelPackageSources: new Map<string, string>(),
    skippedOptionalPackages: [],
  }
  const externalRuntimePackages = options.externalRuntimePackages ?? EXTERNAL_RUNTIME_PACKAGES

  if (options.cleanTarget ?? true) {
    prepareTargetNodeModules(ctx.sourceNodeModules, ctx.targetNodeModules)
  } else {
    const source = resolve(ctx.sourceNodeModules)
    const target = resolve(ctx.targetNodeModules)
    if (source === target) {
      throw new Error('sourceNodeModules 与 targetNodeModules 不能相同，避免覆盖源依赖')
    }
    if (basename(target) !== 'node_modules') {
      throw new Error(`拒绝同步到非 node_modules 目录: ${target}`)
    }
    mkdirSync(target, { recursive: true })
  }

  for (const packageName of externalRuntimePackages) {
    copyPackage(ctx, packageName)
  }

  assertNoAbsoluteSymlinks(ctx.targetNodeModules)

  return {
    copiedPackageCount: ctx.copiedPackages.size,
    copiedPackages: [...ctx.copiedPackages.keys()],
    skippedOptionalPackages: [...ctx.skippedOptionalPackages],
  }
}

function main(): void {
  const result = syncRuntimeDeps({ cleanTarget: !process.argv.includes('--no-clean') })
  const skipped = result.skippedOptionalPackages.length > 0
    ? `，跳过未安装 optional 依赖 ${result.skippedOptionalPackages.length} 个`
    : ''
  console.log(`[runtime-deps] 已同步 ${result.copiedPackageCount} 个主进程运行时依赖${skipped}`)
}

if (import.meta.main) {
  main()
}
