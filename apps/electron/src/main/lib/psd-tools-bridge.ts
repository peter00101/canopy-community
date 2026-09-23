/**
 * psd-tools（Python）桥接：Canopy 的 PSD 能力以内置 ag-psd 为地板，用户机器上恰好有
 * Python + psd-tools 时自动启用它做高保真读取与合成（调整层、复杂混合、Photoshop 效果的渲染
 * 比我们的近似合成器准）。
 *
 * 原则：只探测、从不安装（Agent 不得替用户 pip install）；探测结果缓存到进程结束；
 * 找不到就返回 null，调用方走内置路径。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface PsdToolsAvailability {
  available: boolean
  python?: string
  version?: string
  /** psd-tools 的可选依赖里缺的（aggdraw 管矢量描边、scipy 管调整层 / 渐变、scikit-image 管部分滤镜）；缺了对应场景回退内置引擎 */
  missingOptionalDeps?: string[]
  reason?: string
}

export interface PsdToolsLayerNode {
  id: string
  name: string
  kind: string
  hidden: boolean
  opacity: number
  blendMode: string
  bounds: { left: number; top: number; right: number; bottom: number }
  hasMask: boolean
  clipping: boolean
  effects?: string[]
  text?: string
  children?: PsdToolsLayerNode[]
}

export interface PsdToolsInspectResult {
  width: number
  height: number
  colorMode: string
  depth: number
  layers: PsdToolsLayerNode[]
}

const PROBE_TIMEOUT_MS = 8_000
const RUN_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

let cachedAvailability: Promise<PsdToolsAvailability> | null = null

/**
 * 桥接脚本位置：打包后在 process.resourcesPath/psd（electron-builder extraResources），
 * dev 在 dist/resources/psd（build:resources 拷贝），单测直接用源码树 resources/psd。
 * 环境变量 CANOPY_PSD_BRIDGE_SCRIPT 可显式指定（测试用）。
 */
export function getPsdToolsBridgeScriptPath(): string {
  const explicit = process.env.CANOPY_PSD_BRIDGE_SCRIPT?.trim()
  if (explicit) return explicit
  const relative = join('psd', 'psd_tools_bridge.py')
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resourcesPath ? join(resourcesPath, relative) : '',
    join(__dirname, 'resources', relative),
    join(__dirname, '..', 'resources', relative),
    join(__dirname, '..', '..', '..', 'resources', relative),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `\n${String(stderr).slice(0, 500)}` : ''}`))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function parseEnvelope<T>(stdout: string): T {
  const trimmed = stdout.trim()
  const start = trimmed.lastIndexOf('\n{')
  const json = start >= 0 ? trimmed.slice(start + 1) : trimmed
  const parsed = JSON.parse(json) as { ok?: boolean; error?: string } & T
  if (!parsed.ok) throw new Error(parsed.error || 'psd-tools 返回失败')
  return parsed
}

/** 候选解释器：显式指定的 > PATH 里的 python / python3 > Windows 的 py 启动器 */
export function candidatePythonCommands(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Array<{ command: string; args: string[] }> {
  const out: Array<{ command: string; args: string[] }> = []
  const explicit = env.CANOPY_PSD_TOOLS_PYTHON?.trim()
  if (explicit) out.push({ command: explicit, args: [] })
  out.push({ command: 'python', args: [] }, { command: 'python3', args: [] })
  if (platform === 'win32') out.push({ command: 'py', args: ['-3'] })
  return out
}

async function probe(): Promise<PsdToolsAvailability> {
  const script = getPsdToolsBridgeScriptPath()
  if (!existsSync(script)) return { available: false, reason: `桥接脚本不存在：${script}` }
  const reasons: string[] = []
  for (const candidate of candidatePythonCommands()) {
    try {
      const { stdout } = await run(candidate.command, [...candidate.args, script, 'probe'], PROBE_TIMEOUT_MS)
      const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok?: boolean; version?: string; missingOptionalDeps?: string[]; error?: string }
      if (parsed.ok && parsed.version) {
        const python = [candidate.command, ...candidate.args].join(' ')
        const missingOptionalDeps = Array.isArray(parsed.missingOptionalDeps) ? parsed.missingOptionalDeps.filter((d): d is string => typeof d === 'string') : []
        console.log(`[PSD] psd-tools ${parsed.version} 可用（${python}），高保真读取与合成已启用${missingOptionalDeps.length ? `；缺可选依赖 ${missingOptionalDeps.join(' / ')}（矢量描边 / 调整层 / 渐变这些场景会回退内置引擎，pip install "psd-tools[composite]" 补齐）` : ''}`)
        return { available: true, python, version: parsed.version, missingOptionalDeps }
      }
      reasons.push(`${candidate.command}: ${parsed.error ?? '未返回版本'}`)
    } catch (error) {
      reasons.push(`${candidate.command}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  return { available: false, reason: reasons.join('；') }
}

/** 探测到「不可用」后多久允许再探一次：用户按 Skill 的问询装完 psd-tools，下一次调 PSD 工具就该生效，不必重启 */
export const PSD_TOOLS_NEGATIVE_PROBE_TTL_MS = 60_000

interface ProbeState {
  available: boolean
  probedAt: number
}

let cachedProbeState: ProbeState | null = null

/**
 * 是否该重新探测：没探过 → 探；探到可用 → 进程内不再探（子进程一次就够）；
 * 探到不可用 → 过了 ttl 再探（每次 PSD 工具调用最多多花一次约 200ms 的子进程，且一分钟一次）。
 */
export function shouldReprobePsdTools(state: ProbeState | null, now: number, ttlMs: number = PSD_TOOLS_NEGATIVE_PROBE_TTL_MS): boolean {
  if (!state) return true
  if (state.available) return false
  return now - state.probedAt >= ttlMs
}

/** 可用结果进程内只探一次；不可用结果每分钟最多重探一次（装完立即生效） */
export function getPsdToolsAvailability(): Promise<PsdToolsAvailability> {
  if (cachedAvailability && !shouldReprobePsdTools(cachedProbeState, Date.now())) return cachedAvailability
  // 上一次探测还在进行中（cachedProbeState 尚未写入）时复用同一个 Promise，不并发起子进程
  if (cachedAvailability && !cachedProbeState) return cachedAvailability
  cachedProbeState = null
  cachedAvailability = probe().then((result) => {
    cachedProbeState = { available: result.available, probedAt: Date.now() }
    return result
  })
  return cachedAvailability
}

/** 测试与设置页可用：清掉缓存重新探测 */
export function resetPsdToolsAvailabilityCache(): void {
  cachedAvailability = null
  cachedProbeState = null
}

async function runBridge<T>(args: string[]): Promise<T | null> {
  const availability = await getPsdToolsAvailability()
  if (!availability.available || !availability.python) return null
  const [command, ...prefix] = availability.python.split(' ')
  if (!command) return null
  const { stdout } = await run(command, [...prefix, getPsdToolsBridgeScriptPath(), ...args], RUN_TIMEOUT_MS)
  return parseEnvelope<T>(stdout)
}

export async function psdToolsInspect(psdPath: string): Promise<PsdToolsInspectResult | null> {
  return runBridge<PsdToolsInspectResult>(['inspect', psdPath])
}

export async function psdToolsComposite(
  psdPath: string,
  outPngPath: string,
  options: { hiddenIds?: readonly string[]; visibleIds?: readonly string[]; maxSide?: number } = {},
): Promise<{ width: number; height: number; renderedWidth: number; renderedHeight: number } | null> {
  const args = ['composite', psdPath, outPngPath]
  if (options.hiddenIds?.length) args.push('--hidden', options.hiddenIds.join(','))
  if (options.visibleIds?.length) args.push('--visible', options.visibleIds.join(','))
  if (options.maxSide) args.push('--max-side', String(options.maxSide))
  return runBridge(args)
}

export async function psdToolsLayerPng(psdPath: string, layerId: string, outPngPath: string): Promise<{ bounds: { left: number; top: number; right: number; bottom: number }; warning?: string } | null> {
  return runBridge(['layer', psdPath, layerId, outPngPath])
}
