/**
 * Git 运行时检测模块
 *
 * 负责检测系统中 Git 的可用性和获取 Git 仓库状态
 */

import { execFileAsync } from './async-command'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GitRuntimeStatus, GitRepoStatus } from '@canopy/shared'
import { getGitForWindowsInstallPath } from './windows-env'

async function findGitPath(): Promise<string | null> {
  try {
    const command = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(command, ['git'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const result = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    const gitPath = result.trim().split('\n')[0]

    if (gitPath && existsSync(gitPath)) {
      return gitPath
    }
  } catch {
    // Git 未安装
  }

  if (process.platform === 'win32') {
    const commonPaths: string[] = []
    const regInstallPath = await getGitForWindowsInstallPath()
    if (regInstallPath) {
      commonPaths.push(
        join(regInstallPath, 'cmd', 'git.exe'),
        join(regInstallPath, 'bin', 'git.exe'),
      )
    }

    const scoop = process.env.SCOOP
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'

    if (scoop) {
      commonPaths.push(
        join(scoop, 'apps', 'git', 'current', 'cmd', 'git.exe'),
        join(scoop, 'apps', 'git', 'current', 'bin', 'git.exe'),
        join(scoop, 'shims', 'git.exe'),
      )
    }
    if (localAppData) {
      commonPaths.push(
        join(localAppData, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
        join(localAppData, 'scoop', 'apps', 'git', 'current', 'bin', 'git.exe'),
      )
    }

    commonPaths.push(
      'C:\\ProgramData\\chocolatey\\bin\\git.exe',
      join(programFiles, 'Git', 'cmd', 'git.exe'),
      join(programFiles, 'Git', 'bin', 'git.exe'),
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    )

    for (const path of commonPaths) {
      if (existsSync(path)) return path
    }
  }

  return null
}

async function getGitVersion(gitPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(gitPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const result = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    if (result) {
      const match = result.match(/git version (\d+\.\d+\.\d+)/)
      return match ? match[1]! : result.trim()
    }
  } catch {
    // 执行失败
  }
  return null
}

export async function detectGitRuntime(): Promise<GitRuntimeStatus> {
  console.log('[Git 检测] 开始检测 Git 运行时...')
  const gitPath = await findGitPath()
  if (!gitPath) {
    console.warn('[Git 检测] 未找到 Git')
    return { available: false, version: null, path: null, error: '未找到 Git。请安装 Git 后重试。' }
  }

  const version = await getGitVersion(gitPath)
  if (!version) {
    console.warn(`[Git 检测] Git 无法执行: ${gitPath}`)
    return { available: false, version: null, path: gitPath, error: 'Git 已找到但无法执行' }
  }

  console.log(`[Git 检测] 找到 Git: ${gitPath} (${version})`)
  return { available: true, version, path: gitPath, error: null }
}

async function runGitCommand(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const output = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    return output.trim()
  } catch {
    // 命令执行失败
  }
  return null
}

/**
 * 获取指定目录的 Git 仓库状态
 *
 * @param dirPath - 目录路径
 * @returns Git 仓库状态，如果不是 Git 仓库或出错返回 null
 */
/**
 * getGitRepoStatus 的短期缓存。
 *
 * 一次调用要跑 4 条 git 命令。上游 v0.19.26（#1949）已把 runGitCommand 从
 * spawnSync 换成 execFileAsync，主进程不再被同步阻塞；
 * 但调用方是文件变化处理器，Agent 跑批量脚本写几千个文件时会被逐文件调用，
 * 而这几千个文件通常只落在个位数的目录里——按目录缓存仍能把几千次调用塌缩
 * 成几次，故保留。
 *
 * TTL 取短值：只用于消化同一批文件事件的突发调用，不影响用户切分支等真实变更
 * 的可见性。
 */
const REPO_STATUS_CACHE_TTL_MS = 3000
const repoStatusCache = new Map<string, { at: number; value: GitRepoStatus | null }>()
/** 同一目录的并发调用共享同一次执行，避免 await 间隙里重复起 git 进程。 */
const inFlightRepoStatus = new Map<string, Promise<GitRepoStatus | null>>()

/** 缓存项上限，防止长时间运行后 Map 无界增长。 */
const REPO_STATUS_CACHE_MAX = 200

function readRepoStatusCache(dirPath: string): { value: GitRepoStatus | null } | null {
  const hit = repoStatusCache.get(dirPath)
  if (!hit) return null
  if (Date.now() - hit.at > REPO_STATUS_CACHE_TTL_MS) {
    repoStatusCache.delete(dirPath)
    return null
  }
  return { value: hit.value }
}

function writeRepoStatusCache(dirPath: string, value: GitRepoStatus | null): void {
  if (repoStatusCache.size >= REPO_STATUS_CACHE_MAX) {
    // 简单 FIFO 淘汰：Map 迭代顺序即插入顺序。
    const oldest = repoStatusCache.keys().next()
    if (!oldest.done) repoStatusCache.delete(oldest.value)
  }
  repoStatusCache.set(dirPath, { at: Date.now(), value })
}

export interface GetGitRepoStatusOptions {
  /**
   * 是否额外查询 branch / hasChanges / remoteUrl。
   *
   * 默认 **false**：这三个字段各需一次额外的同步 git 调用，其中
   * `git status --porcelain` 的开销与整个工作树大小成正比——Agent 刚写完几千个
   * 文件时尤其慢，而它们目前**全仓无人读取**（唯一调用方只看 isRepo）。
   * 未来确有消费方时显式传 true，不要改默认值。
   */
  includeDetails?: boolean
}

export async function getGitRepoStatus(
  dirPath: string,
  options: GetGitRepoStatusOptions = {},
): Promise<GitRepoStatus | null> {
  // 明细查询绕开缓存：它不在文件事件热路径上，且调用方要的是即时值。
  if (options.includeDetails) return getGitRepoStatusUncached(dirPath, true)

  const cached = readRepoStatusCache(dirPath)
  if (cached) return cached.value

  const inFlight = inFlightRepoStatus.get(dirPath)
  if (inFlight) return inFlight

  const task = (async () => getGitRepoStatusUncached(dirPath, false))()
    .then((value) => {
      writeRepoStatusCache(dirPath, value)
      return value
    })
    .finally(() => {
      inFlightRepoStatus.delete(dirPath)
    })

  inFlightRepoStatus.set(dirPath, task)
  return task
}

async function getGitRepoStatusUncached(dirPath: string, includeDetails: boolean): Promise<GitRepoStatus | null> {
  // 检查目录是否存在
  if (!existsSync(dirPath)) {
    return null
  }

  // 检查是否为 Git 仓库
  const isRepo = await runGitCommand(['rev-parse', '--is-inside-work-tree'], dirPath)
  if (isRepo !== 'true') {
    return { isRepo: false, branch: null, hasChanges: false, remoteUrl: null }
  }

  // 默认只回答“是不是仓库”，省掉另外三次 git 调用（见 GetGitRepoStatusOptions）
  if (!includeDetails) {
    return {
      isRepo: true,
      branch: null,
      hasChanges: false,
      remoteUrl: null,
    }
  }

  // 获取当前分支
  const branch = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath)

  // 检查是否有未提交的更改
  const status = await runGitCommand(['status', '--porcelain'], dirPath)
  const hasChanges = status !== null && status.length > 0
  const remoteUrl = await runGitCommand(['config', '--get', 'remote.origin.url'], dirPath)

  return { isRepo: true, branch: branch || null, hasChanges, remoteUrl: remoteUrl || null }
}

export async function detectGitBashWindows(): Promise<string | null> {
  if (process.platform !== 'win32') return null

  const commonPaths: string[] = []
  const regInstallPath = await getGitForWindowsInstallPath()
  if (regInstallPath) {
    commonPaths.push(join(regInstallPath, 'bin', 'bash.exe'), join(regInstallPath, 'usr', 'bin', 'bash.exe'))
  }

  const scoop = process.env.SCOOP
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  if (scoop) {
    commonPaths.push(
      join(scoop, 'apps', 'git', 'current', 'bin', 'bash.exe'),
      join(scoop, 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    )
  }
  if (localAppData) {
    commonPaths.push(
      join(localAppData, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
      join(localAppData, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    )
  }
  commonPaths.push(
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
  )

  for (const path of commonPaths) {
    if (existsSync(path)) return path
  }

  try {
    const { stdout } = await execFileAsync('where', ['bash'], { encoding: 'utf-8', timeout: 5000 })
    const result = typeof stdout === 'string' ? stdout : stdout.toString('utf-8')
    const bashPath = result.trim().split('\n')[0]
    if (bashPath && existsSync(bashPath)) return bashPath
  } catch {
    // 未找到
  }
  return null
}
