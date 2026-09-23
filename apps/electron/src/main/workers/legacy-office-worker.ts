/**
 * 旧版 Office（.doc / .xls / .ppt）解析后台线程入口。
 *
 * 由 build:main 作为第二个入口单独打包成 dist/legacy-office-worker.cjs（SheetJS / word-extractor 全部打进去），
 * 主进程 `legacy-office-parser.ts` 读出源码后以 eval Worker 启动：一次任务一个线程，做完即退出。
 */

import { parentPort, workerData } from 'node:worker_threads'
import { runLegacyOfficeTask, type LegacyOfficeTask } from '../lib/legacy-office-text'

runLegacyOfficeTask(workerData as LegacyOfficeTask)
  .then((result) => parentPort?.postMessage({ ok: true, result }))
  .catch((error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }))
