/** 页面 ↔ Office 预览后台线程的消息约定 */

import type { PreviewFindOptions } from './preview-find-matcher'
import type { LegacyPptSlide } from './legacy-ppt-text'
import type { SpreadsheetBlock, SpreadsheetMatch, SpreadsheetSheetMeta } from './spreadsheet-worker-core'

export type OfficePreviewWorkerRequest =
  | { id: number; type: 'open-workbook'; bytes: ArrayBuffer }
  | { id: number; type: 'read-block'; sheet: number; rowStart: number; rowEnd: number; colStart: number; colEnd: number }
  | { id: number; type: 'search'; query: string; options: PreviewFindOptions; limit: number }
  | { id: number; type: 'read-ppt'; bytes: ArrayBuffer }

export type OfficePreviewWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface OfficePreviewWorkerResults {
  'open-workbook': SpreadsheetSheetMeta[]
  'read-block': SpreadsheetBlock
  search: { matches: SpreadsheetMatch[]; capped: boolean }
  'read-ppt': LegacyPptSlide[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type OfficePreviewWorkerCall = DistributiveOmit<OfficePreviewWorkerRequest, 'id'>

/**
 * 每个预览标签一个后台线程：标签关掉就 terminate，解析出的整本工作簿随线程一起释放。
 * 文件字节以 transfer 方式交给线程（零拷贝，页面这边的 ArrayBuffer 随即失效）。
 */
export class OfficePreviewWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private terminated = false

  constructor(worker: Worker) {
    this.worker = worker
    this.worker.onmessage = (event: MessageEvent<OfficePreviewWorkerResponse>) => {
      const handler = this.pending.get(event.data.id)
      if (!handler) return
      this.pending.delete(event.data.id)
      if (event.data.ok) handler.resolve(event.data.result)
      else handler.reject(new Error(event.data.error))
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || '预览后台线程出错')
      for (const handler of this.pending.values()) handler.reject(error)
      this.pending.clear()
    }
  }

  call<T extends OfficePreviewWorkerCall>(message: T): Promise<OfficePreviewWorkerResults[T['type']]> {
    if (this.terminated) return Promise.reject(new Error('预览后台线程已关闭'))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const transfer = 'bytes' in message ? [message.bytes] : []
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.worker.terminate()
    const error = new Error('预览后台线程已关闭')
    for (const handler of this.pending.values()) handler.reject(error)
    this.pending.clear()
  }
}

export function createOfficePreviewWorker(): OfficePreviewWorkerClient {
  return new OfficePreviewWorkerClient(new Worker(new URL('../workers/office-preview.worker.ts', import.meta.url), { type: 'module' }))
}

/** IPC 回来的 Uint8Array 可能是更大缓冲区上的视图：拷出独立的 ArrayBuffer 再 transfer，避免把别的数据一起送走 */
export function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer
  return bytes.slice().buffer as ArrayBuffer
}
