/**
 * 旧版 PowerPoint（.ppt）文字预览：后台线程按 [MS-PPT] 格式逐页提取文字，这里按页列出。
 * 只有文字，不含图片与版式（顶部提示里写明）。内容在本页 DOM 里，文件内查找直接可用。
 */

import * as React from 'react'
import type { FileAccessOptions } from '@canopy/shared'
import { createOfficePreviewWorker, toTransferableBuffer } from '@/lib/office-preview-worker-protocol'
import type { LegacyPptSlide } from '@/lib/legacy-ppt-text'

interface LegacyPptPreviewProps {
  filePath: string
  fileAccess: FileAccessOptions
}

export function LegacyPptPreview({ filePath, fileAccess }: LegacyPptPreviewProps): React.ReactElement {
  const [phase, setPhase] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [slides, setSlides] = React.useState<LegacyPptSlide[]>([])
  const [errorText, setErrorText] = React.useState('')

  React.useEffect(() => {
    let cancelled = false
    const client = createOfficePreviewWorker()
    setPhase('loading')
    setSlides([])
    void (async () => {
      try {
        const bytes = await window.electronAPI.readPreviewBinary(filePath, fileAccess)
        if (cancelled) return
        if (!bytes) throw new Error('文件读取失败（可能超过 50 MB 上限或无权访问）')
        const result = await client.call({ type: 'read-ppt', bytes: toTransferableBuffer(bytes) })
        if (cancelled) return
        setSlides(result)
        setPhase('ready')
      } catch (error) {
        if (cancelled) return
        console.warn('[legacy-ppt-preview] 解析失败:', error)
        setErrorText(error instanceof Error ? error.message : String(error))
        setPhase('error')
      } finally {
        // 文字提取完就用不到线程了，立即释放
        client.terminate()
      }
    })()
    return () => {
      cancelled = true
      client.terminate()
    }
  }, [filePath, fileAccess])

  if (phase === 'loading') {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">正在读取幻灯片文字…</div>
  }
  if (phase === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
        无法加载 PPT 预览：{errorText}。可以使用默认应用打开。
      </div>
    )
  }

  return (
    <div className="office-preview-host">
      <div className="office-preview office-preview-presentation">
        <div className="office-preview-notice">旧版 PowerPoint（.ppt）：仅显示各页文字，不含图片和版式。共 {slides.length} 页。</div>
        {slides.length === 0 && <div className="office-empty">没有可提取的文字内容</div>}
        {slides.map((slide) => {
          const [title, ...rest] = slide.paragraphs
          return (
            <section key={slide.index} className="office-slide">
              <div className="office-slide-index">幻灯片 {slide.index}</div>
              <h3>{title ?? '（本页没有文字）'}</h3>
              {rest.length > 0 && (
                <ul>
                  {rest.map((paragraph, index) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={index}>{paragraph}</li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
