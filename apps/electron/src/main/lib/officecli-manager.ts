/**
 * OfficeCLI 内嵌资源：路径解析、子进程执行、完整性自检。
 *
 * OfficeCLI 由构建脚本下载、校验并交给 electron-builder 随应用分发；运行时不读取
 * 用户 PATH，也不提供下载/安装设置。若资源因构建或签名问题不可用，调用方回退到
 * Canopy 原有的内置 OOXML 解析器。
 *
 * ⚠️ **执行它必须经 runBundledOfficeCli()，不要自己 execFile。** 该二进制内建自动更新：
 * 裸执行会让它联网把自身替换成未经我方校验的版本（Windows 留下 `<产物名>.old`，
 * macOS/Linux 后台原地替换），构建期钉死的 SHA-256 在运行期就此失守。
 * 这里把三个抑制开关收敛成唯一常量，并有一条静态测试钉住「只有本文件执行它」。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OFFICECLI_VERSION, getOfficeCliAsset, getOfficeCliOutputName } from './officecli-manifest'

const OFFICECLI_COMMAND = getOfficeCliOutputName(process.platform)

/**
 * 交给 OfficeCLI 子进程的抑制开关，三个都必须带：
 * - `OFFICECLI_SKIP_UPDATE=1`：跳过整个后台更新检查，也不应用上次留下的待交换版本。
 * - `OFFICECLI_NO_AUTO_INSTALL=1`：禁止它把自己装进用户目录、改用户 PATH 注册表、
 *   往 `~/.claude` 之类的 agent 配置里写文件（该变量上游无文档，只在源码里）。
 * - `OFFICECLI_NO_AUTO_RESIDENT=1`：禁止派生常驻进程。不只是卫生问题——有常驻时
 *   写盘会延迟数秒，外部读者会读到旧内容。
 *
 * 注意上游的 `mcp` 子命令**不受 SKIP_UPDATE 约束**（上游 issue #303），所以我方一律
 * 用子进程调普通 CLI，不使用它的 MCP 模式。
 */
export const OFFICECLI_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_INSTALL: '1',
  OFFICECLI_NO_AUTO_RESIDENT: '1',
})

export function getBundledOfficeCliPath(): string {
  const { app } = require('electron') as { app: { isPackaged: boolean } }
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, 'resources')
  return join(resourcesDir, 'officecli', OFFICECLI_COMMAND)
}

export interface RunOfficeCliOptions {
  timeoutMs: number
  maxBuffer: number
  cwd?: string
  /**
   * 经 stdin 传给子进程的内容。批量编辑的 JSON 必须走这里而不是命令行——
   * Windows 的 CreateProcess 命令行上限约 32767 字符，实测 150 行 × 5 列的
   * batch 载荷就有 5 万字符，拼进 argv 会直接 spawn ENAMETOOLONG。
   */
  stdin?: string
}

export interface RunOfficeCliResult {
  stdout: string
  stderr: string
  code: number | null
  /** 因超时被杀。调用方据此给出「超时」而不是把半截输出当错误文本。 */
  timedOut: boolean
}

/**
 * 执行内嵌 OfficeCLI 的唯一入口。参数走数组不过 shell。
 *
 * 用 spawn 而非 execFile：既要支持 stdin，也要在超时/溢出时仍拿得到已收到的
 * stdout（OfficeCLI 失败时同样打印 JSON 信封，丢了它模型就无从纠错）。
 */
export async function runBundledOfficeCli(
  executablePath: string,
  args: readonly string[],
  options: RunOfficeCliOptions,
): Promise<RunOfficeCliResult> {
  return new Promise<RunOfficeCliResult>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, ...OFFICECLI_CHILD_ENV },
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)

    const finish = (result: RunOfficeCliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk)
      // 超过上限就停止累积，但不杀进程——让它自己收尾，已收到的部分仍可解析。
      if (stdoutBytes <= options.maxBuffer) stdout += chunk
    })
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => finish({ stdout, stderr, code, timedOut }))

    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ })
      child.stdin?.end(options.stdin, 'utf-8')
    } else {
      child.stdin?.end()
    }
  })
}

// ─── 运行期完整性自检 ───

type TrustState = 'unknown' | 'trusted' | 'untrusted'
let trustState: TrustState = 'unknown'
let inFlight: Promise<boolean> | undefined

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve())
  })
  return hash.digest('hex').toLowerCase()
}

/**
 * 校验磁盘上的二进制仍是清单里钉死的那一份，**进程内只做一次**。
 *
 * 为什么运行期还要再验一遍：三个抑制开关是靠字符串比较生效的，上游哪天改了变量名
 * 我方会静默失守；per-user 安装时程序目录用户自己可写，二进制也可能被外部换掉。
 * 先比字节数（零成本），只有大小一致才做 33MB 的哈希，所以正常路径开销可忽略。
 * 校验不过不抛错——只是让调用方回退到内置解析器，功能降级但不炸。
 */
export async function isBundledOfficeCliTrusted(executablePath: string): Promise<boolean> {
  if (trustState !== 'unknown') return trustState === 'trusted'
  if (inFlight) return inFlight

  // 只有「确实对不上」才是可缓存的结论。读文件时的瞬时失败（杀软正在扫这个 33MB 的
  // exe、磁盘忙、EBUSY）不能永久记成不可信——否则整个会话期 Office 能力都废掉，
  // 只能重启才恢复。这类情况保持 unknown，下次调用重试。
  let conclusive = true

  inFlight = (async () => {
    const asset = getOfficeCliAsset(process.platform, process.arch)
    if (!asset) {
      console.warn(`[officecli] 当前平台无钉死记录：${process.platform}-${process.arch}，不启用 OfficeCLI`)
      return false
    }
    try {
      if (!existsSync(executablePath)) {
        conclusive = false // 可能是还没准备好（dev 首启竞态），下次再看
        return false
      }
      const size = statSync(executablePath).size
      if (size !== asset.sizeBytes) {
        console.warn(`[officecli] 体积与 ${OFFICECLI_VERSION} 不符（期望 ${asset.sizeBytes}，实际 ${size}），已停用并回退内置解析器`)
        return false
      }
      const actual = await hashFile(executablePath)
      if (actual !== asset.sha256) {
        console.warn(`[officecli] SHA-256 与 ${OFFICECLI_VERSION} 不符，已停用并回退内置解析器`)
        return false
      }
      return true
    } catch (error) {
      conclusive = false
      console.warn('[officecli] 完整性校验读取失败，本次跳过 OfficeCLI（下次调用会重试）:', error)
      return false
    }
  })()

  const trusted = await inFlight
  // 结论不确定时保持 unknown，让下一次调用重新校验。
  trustState = trusted ? 'trusted' : (conclusive ? 'untrusted' : 'unknown')
  inFlight = undefined
  return trusted
}

/** 仅供测试：重置进程内的一次性校验结果。 */
export function __resetOfficeCliTrustStateForTest(): void {
  trustState = 'unknown'
  inFlight = undefined
}
