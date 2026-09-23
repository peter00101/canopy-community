import { isPythonEnvironmentDirName, isTransientFileName } from './file-visibility'

// 高频变动目录：跳过依赖、缓存和构建中间物，防止产生 IPC 事件风暴。
const HIGH_NOISE_SEGMENTS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.turbo', '.parcel-cache', '.svelte-kit',
  '.venv', 'venv', '.tox', '.nox', '__pypackages__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  '.gradle',
])

const GIT_DIFF_STATE_FILES = new Set([
  'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index',
])

export function isHighNoisePath(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/')
  if (segments.some((seg) => HIGH_NOISE_SEGMENTS.has(seg))) return true
  // 带后缀的虚拟环境（.venv-train、venv310）与 site-packages 同样是装包 / 编译时的写入风暴源。
  // 只看目录段：末段可能是 venv.py 这类普通文件，不能误判。
  if (segments.slice(0, -1).some(isPythonEnvironmentDirName)) return true
  // 临时 / 锁文件在文件面板中不展示，它们的出现与消失不必触发整树刷新。
  const last = segments[segments.length - 1]
  return last !== undefined && isTransientFileName(last)
}

/** fs.watch 在部分平台/事件上可能返回 Buffer 或 null。未知路径不触发刷新，避免绕过噪声过滤。 */
export function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (typeof filename === 'string') return filename.replace(/\\/g, '/')
  if (Buffer.isBuffer(filename)) return filename.toString('utf8').replace(/\\/g, '/')
  return null
}

/**
 * 只有直接影响 `git diff HEAD` 结果的 Git 元数据才触发刷新。
 * 远端 fetch 产生的 FETCH_HEAD、refs/remotes 与 objects 均不在范围内，避免重现刷新循环。
 */
export function isGitDiffStatePath(normalizedPath: string): boolean {
  const segments = normalizedPath.split('/').filter(Boolean)
  const gitIndex = segments.lastIndexOf('.git')
  if (gitIndex < 0) return false
  const gitRelativePath = segments.slice(gitIndex + 1)
  return gitRelativePath.length === 1 && GIT_DIFF_STATE_FILES.has(gitRelativePath[0]!)
}

export function shouldNotifyForWatchFilename(filename: string | Buffer | null): boolean {
  const normalizedFilename = normalizeWatchFilename(filename)
  return normalizedFilename !== null && (!isHighNoisePath(normalizedFilename) || isGitDiffStatePath(normalizedFilename))
}

export interface PendingWatchFlushInput {
  /** 当前已累积待发的路径数量 */
  pendingCount: number
  /** 本批第一个待发事件的时间戳 */
  firstPendingAt: number
  /** 当前时间戳 */
  now: number
  /** 单批路径数上限，达到即刻发送 */
  maxPending: number
  /** 从第一个待发事件起的最长等待时间 */
  maxWaitMs: number
}

/**
 * 判断待发的文件变更是否必须立即发送，而不是继续 debounce。
 *
 * 纯 debounce 有饥饿缺陷：每个事件都重置定时器，只要写入间隔一直小于 debounce
 * 窗口就永远不会 flush。Agent 跑批量脚本连续写几千个文件时，待发集合会无界增长，
 * 直到写入停止才一次性倾泻给渲染层。这里给出两个逃生阀：攒够 maxPending 条，
 * 或从第一条起已等满 maxWaitMs。
 */
export function shouldFlushPendingWatchEvents(input: PendingWatchFlushInput): boolean {
  if (input.pendingCount <= 0) return false
  if (input.pendingCount >= input.maxPending) return true
  return input.now - input.firstPendingAt >= input.maxWaitMs
}

/** 输入相对 agent-workspaces 根目录；仅工作区顶层能力目录触发能力通知。 */
export function classifyWorkspaceWatchFilename(filename: string | Buffer | null): 'capabilities' | 'files' | null {
  const normalized = normalizeWatchFilename(filename)
  if (!normalized || !shouldNotifyForWatchFilename(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 2 && parts[1] === 'config.json') return null
  if ((parts.length === 2 && parts[1] === 'mcp.json')
    || parts[1] === 'skills' || parts[1] === 'skills-inactive') return 'capabilities'
  return 'files'
}
