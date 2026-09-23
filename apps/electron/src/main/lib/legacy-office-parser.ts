/**
 * 在后台线程里执行旧版 Office 解析任务（`legacy-office-text.ts`）。
 *
 * Agent 工具与 Chat 附件解析都跑在主进程：8MB 的 .xls 解析要 1 秒左右、50MB 的要数秒，
 * 直接在主进程做会让整个应用的 IPC 停摆。这里每个任务起一个 worker_threads 线程，做完即退出。
 *
 * 线程代码是 build:main 打出的 dist/legacy-office-worker.cjs。打包后它在 app.asar 里：按源码字符串以 eval 方式启动，
 * 只依赖主进程 fs 能读 asar（实测 Electron 43 直接传 asar 内路径也能起线程，但那依赖 Electron 对线程加载器的补丁）。
 * 找不到产物（单测 / 未构建的源码环境）时退回当前线程执行并告警。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LegacyInspectResult, LegacyOfficeTask } from './legacy-office-text'

const WORKER_BUNDLE = 'legacy-office-worker.cjs'
/** 解析最慢的是接近 50MB 上限的表格，留足余量 */
const TASK_TIMEOUT_MS = 60_000
/** 线程堆上限：超出时只结束这个线程并报错，不拖垮主进程 */
const WORKER_HEAP_LIMIT_MB = 1536

let cachedWorkerSource: string | null | undefined

function loadWorkerSource(): string | null {
  if (cachedWorkerSource !== undefined) return cachedWorkerSource
  const bundlePath = join(__dirname, WORKER_BUNDLE)
  cachedWorkerSource = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf-8') : null
  if (cachedWorkerSource === null) {
    console.warn(`[旧版 Office] 未找到后台解析线程 ${bundlePath}，改在当前线程解析（只应出现在单测或未构建的源码环境）`)
  }
  return cachedWorkerSource
}

export function runLegacyOfficeTaskOffThread(task: Extract<LegacyOfficeTask, { type: 'inspect' }>): Promise<LegacyInspectResult>
export function runLegacyOfficeTaskOffThread(task: Extract<LegacyOfficeTask, { type: 'plain-text' }>): Promise<string>
export async function runLegacyOfficeTaskOffThread(task: LegacyOfficeTask): Promise<LegacyInspectResult | string> {
  const source = loadWorkerSource()
  if (source === null) {
    const { runLegacyOfficeTask } = await import('./legacy-office-text')
    return runLegacyOfficeTask(task)
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: task, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_LIMIT_MB } })
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
      void worker.terminate()
    }
    const timer = setTimeout(() => finish(() => reject(new Error(`解析超过 ${TASK_TIMEOUT_MS / 1000} 秒未完成，已放弃`))), TASK_TIMEOUT_MS)
    worker.on('message', (message: { ok: true; result: LegacyInspectResult | string } | { ok: false; error: string }) => {
      finish(() => (message.ok ? resolve(message.result) : reject(new Error(message.error))))
    })
    worker.on('error', (error) => {
      const outOfMemory = (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
      finish(() => reject(outOfMemory ? new Error('文件内容过大，解析时超出内存上限') : error))
    })
    worker.on('exit', (code) => {
      finish(() => reject(new Error(`解析线程意外退出（代码 ${code}）`)))
    })
  })
}
