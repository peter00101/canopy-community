/**
 * Office 高保真预览组件（Word / PPT / Excel）
 *
 * 与主进程旧转换链路（mammoth / 自研 OOXML）的关系：
 * - 本组件为主渲染路径：readBinaryBase64 拉原始字节，渲染层库解析出保真视图
 * - 旧链路产出的 HTML 作为 fallbackHtml 传入，高保真解析失败时回退展示
 * - 解析库全部动态 import，不进主 bundle
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import type { FileAccessOptions } from '@canopy/shared'
import {
  buildSheetModel,
  columnLabel,
  type ExcelSheetModel,
} from '@/lib/excel-preview-model'

/** Office 文件读取上限：25MB（与 Cherry Studio 同档） */
const MAX_OFFICE_BYTES = 25 * 1024 * 1024

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

interface OfficePreviewProps {
  filePath: string
  fileAccess: FileAccessOptions
  /** 旧转换链路的 HTML（已 DOMPurify），高保真渲染失败时回退 */
  fallbackHtml?: string
}

type PreviewPhase = 'loading' | 'ready' | 'fallback' | 'error'

function PreviewStatus({ text }: { text: string }): React.ReactElement {
  return <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">{text}</div>
}

function FallbackHtml({ html, className }: { html: string; className: string }): React.ReactElement {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

async function readOfficeBinary(filePath: string, fileAccess: FileAccessOptions): Promise<ArrayBuffer | null> {
  const base64 = await window.electronAPI.readBinaryBase64(filePath, fileAccess, MAX_OFFICE_BYTES)
  return base64 ? base64ToArrayBuffer(base64) : null
}

// ===== Word（docx-preview 分页真渲染） =====

export function WordDocxPreview({ filePath, fileAccess, fallbackHtml }: OfficePreviewProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [phase, setPhase] = React.useState<PreviewPhase>('loading')

  React.useEffect(() => {
    let cancelled = false
    setPhase('loading')

    async function render(): Promise<void> {
      const container = containerRef.current
      if (!container) return
      try {
        const buffer = await readOfficeBinary(filePath, fileAccess)
        if (cancelled) return
        if (!buffer) throw new Error('文件过大或读取失败')
        const { renderAsync } = await import('docx-preview')
        if (cancelled) return
        // 离屏 staging 渲染完成后一次性搬入，避免逐节点插入的闪烁
        const staging = document.createElement('div')
        await renderAsync(buffer, staging, undefined, {
          ignoreLastRenderedPageBreak: false,
        })
        if (cancelled) return
        container.replaceChildren(...Array.from(staging.childNodes))
        setPhase('ready')
      } catch (err) {
        console.warn('[office-preview] docx-preview 渲染失败，回退 mammoth HTML:', err)
        if (!cancelled) setPhase(fallbackHtml ? 'fallback' : 'error')
      }
    }
    void render()
    return () => {
      cancelled = true
      containerRef.current?.replaceChildren()
    }
    // fallbackHtml 变化不应重跑高保真渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileAccess])

  if (phase === 'fallback' && fallbackHtml) {
    return <FallbackHtml html={fallbackHtml} className="prose prose-sm dark:prose-invert max-w-none px-4 py-3" />
  }
  return (
    // 滚动交给外层预览容器；min-h-full 保证浅色纸面背景铺满
    <div className={cn(phase === 'ready' ? 'min-h-full w-full bg-neutral-200/60 dark:bg-neutral-800/60' : 'h-full')}>
      {phase === 'loading' && <PreviewStatus text="正在渲染文档..." />}
      {phase === 'error' && <PreviewStatus text="无法加载 DOCX 预览" />}
      <div
        ref={containerRef}
        className={cn('docx-preview-host mx-auto w-fit max-w-full py-4', phase !== 'ready' && 'hidden')}
      />
    </div>
  )
}

// ===== PPT（@aiden0z/pptx-renderer 幻灯片列表真渲染） =====

export function PptxSlidesPreview({ filePath, fileAccess, fallbackHtml }: OfficePreviewProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [phase, setPhase] = React.useState<PreviewPhase>('loading')

  React.useEffect(() => {
    let cancelled = false
    let viewer: { destroy: () => void } | null = null
    setPhase('loading')

    async function render(): Promise<void> {
      const container = containerRef.current
      const scrollContainer = scrollRef.current
      if (!container || !scrollContainer) return
      try {
        const buffer = await readOfficeBinary(filePath, fileAccess)
        if (cancelled) return
        if (!buffer) throw new Error('文件过大或读取失败')
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
        if (cancelled) return
        viewer = await PptxViewer.open(buffer, container, {
          fitMode: 'contain',
          scrollContainer,
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazyMedia: true,
          renderMode: 'list',
          listOptions: { windowed: true, showSlideLabels: true },
          // 禁用 EMF→PDF 兜底渲染，避免额外加载 pdfjs
          pdfjs: false,
        })
        if (cancelled) {
          viewer.destroy()
          viewer = null
          return
        }
        setPhase('ready')
      } catch (err) {
        console.warn('[office-preview] pptx-renderer 渲染失败，回退大纲模式:', err)
        if (!cancelled) setPhase(fallbackHtml ? 'fallback' : 'error')
      }
    }
    void render()
    return () => {
      cancelled = true
      viewer?.destroy()
      viewer = null
      containerRef.current?.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileAccess])

  if (phase === 'fallback' && fallbackHtml) {
    return <FallbackHtml html={fallbackHtml} className="office-preview-host" />
  }
  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-neutral-200/60 dark:bg-neutral-800/60">
      {phase === 'loading' && <PreviewStatus text="正在渲染幻灯片..." />}
      {phase === 'error' && <PreviewStatus text="无法加载 PPTX 预览" />}
      <div ref={containerRef} className={cn('pptx-preview-host p-4', phase !== 'ready' && 'hidden')} />
    </div>
  )
}

// ===== Excel（@e965/xlsx 解析 + sheet 标签页 + 合并单元格） =====

export function ExcelSheetPreview({ filePath, fileAccess, fallbackHtml }: OfficePreviewProps): React.ReactElement {
  const [phase, setPhase] = React.useState<PreviewPhase>('loading')
  const [sheets, setSheets] = React.useState<ExcelSheetModel[]>([])
  const [activeSheet, setActiveSheet] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setSheets([])
    setActiveSheet(0)

    async function parse(): Promise<void> {
      try {
        const buffer = await readOfficeBinary(filePath, fileAccess)
        if (cancelled) return
        if (!buffer) throw new Error('文件过大或读取失败')
        const { read } = await import('@e965/xlsx')
        if (cancelled) return
        const workbook = read(buffer, { type: 'array', cellDates: false })
        const models = workbook.SheetNames
          .map((name) => {
            const sheet = workbook.Sheets[name]
            return sheet ? buildSheetModel(name, sheet) : null
          })
          .filter((m): m is ExcelSheetModel => m !== null)
        if (cancelled) return
        if (models.length === 0) throw new Error('工作簿为空')
        setSheets(models)
        setPhase('ready')
      } catch (err) {
        console.warn('[office-preview] xlsx 解析失败，回退旧转换链路:', err)
        if (!cancelled) setPhase(fallbackHtml ? 'fallback' : 'error')
      }
    }
    void parse()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileAccess])

  if (phase === 'fallback' && fallbackHtml) {
    return <FallbackHtml html={fallbackHtml} className="office-preview-host" />
  }
  if (phase !== 'ready') {
    return <PreviewStatus text={phase === 'loading' ? '正在解析表格...' : '无法加载 Excel 预览'} />
  }

  const sheet = sheets[activeSheet] ?? sheets[0]
  if (!sheet) return <PreviewStatus text="无法加载 Excel 预览" />
  const colCount = sheet.rows[0]?.length ?? 0

  return (
    <div className="flex h-full flex-col">
      {/* sheet 标签页 */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1 shrink-0 scrollbar-thin">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors',
                i === activeSheet
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {(sheet.truncatedRows || sheet.truncatedColumns) && (
        <div className="border-b border-border/50 bg-warning-soft px-3 py-1 text-[11px] text-warning dark:text-warning shrink-0">
          表格过大已截断显示（实际 {sheet.totalRows} 行 × {sheet.totalColumns} 列）
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="excel-preview-table border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 border border-border/60 bg-muted px-2 py-1 text-muted-foreground font-normal" />
              {Array.from({ length: colCount }, (_, c) => (
                <th key={c} className="sticky top-0 z-10 border border-border/60 bg-muted px-2 py-1 text-center font-normal text-muted-foreground min-w-[64px]">
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={r}>
                <td className="sticky left-0 z-10 border border-border/60 bg-muted px-2 py-1 text-center text-muted-foreground">
                  {r + 1}
                </td>
                {row.map((cell, c) => {
                  if (cell.skip) return null
                  return (
                    <td
                      // eslint-disable-next-line react/no-array-index-key
                      key={c}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      className="border border-border/60 px-2 py-1 whitespace-pre-wrap align-top"
                    >
                      {cell.text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
