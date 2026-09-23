/**
 * HtmlPreviewBlock - HTML/SVG 代码块预览组件
 *
 * 对标 Cherry Studio 的 HTML Artifacts 交互：
 * - HTML 代码块：聊天流里只渲染**紧凑卡片**（图标 + 标题 + 操作），
 *   点击打开**全屏弹窗**预览——100vh 设计的页面/游戏获得完整视口，
 *   不会像内嵌小 iframe 那样被裁切出比例问题。
 * - SVG 代码块：保持内嵌直渲（矢量图自适应，无比例问题），带源码切换。
 *
 * 安全模型：
 *   iframe sandbox="allow-scripts"（不带 allow-same-origin）——
 *   脚本可执行（游戏/图表可玩），但处于独立源，
 *   无法触达宿主 DOM、preload 桥或本地文件协议。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'

interface HtmlPreviewBlockProps {
  /** HTML 或 SVG 源码 */
  code: string
  /** 源码语言（决定渲染形态与标签文案） */
  language: 'html' | 'svg'
  /** 覆盖默认剪贴板实现（Electron 可注入主进程剪贴板） */
  onCopy?: (text: string) => Promise<void>
}

/** 流式输出防抖：code 稳定该时长后才刷新 iframe */
const DEBOUNCE_MS = 500

/** 从 HTML 源码提取 <title> 作为卡片标题 */
function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  const title = match?.[1]?.trim()
  return title || null
}

// ===== 图标（与 CodeBlock / MermaidBlock 一致） =====

const ICON_ATTRS = {
  width: 14, height: 14, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}
const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)
const checkIconPath = <polyline points="20 6 9 17 4 12" />
const codeIconPath = (
  <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>
)
const eyeIconPath = (
  <>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>
)
const refreshIconPath = (
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <polyline points="21 3 21 9 15 9" />
  </>
)
const closeIconPath = (
  <>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </>
)
const expandIconPath = (
  <>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </>
)
const downloadIconPath = (
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>
)
/** HTML 文档图标（卡片左侧） */
const fileCodeIconPath = (
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="m10 12-2 2 2 2" />
    <path d="m14 12 2 2-2 2" />
  </>
)

/** 头栏小按钮 */
function HeaderButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
      title={title}
    >
      {children}
    </button>
  )
}

/** 复制按钮（含已复制反馈），卡片与弹窗共用 */
function CopyButton({ code, onCopy }: { code: string; onCopy?: (text: string) => Promise<void> }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = React.useCallback(async (): Promise<void> => {
    try {
      await (onCopy ? onCopy(code) : navigator.clipboard.writeText(code))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[HtmlPreviewBlock] 复制失败:', error)
    }
  }, [code, onCopy])
  return (
    <HeaderButton title="复制源码" onClick={() => { void handleCopy() }}>
      <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
      <span>{copied ? '已复制' : '复制'}</span>
    </HeaderButton>
  )
}

// ===== 全屏预览弹窗（对标 Cherry HtmlArtifactsPopup，预览区占满视口） =====

function HtmlFullscreenPopup({ code, title, onCopy, onClose }: {
  code: string
  title: string
  onCopy?: (text: string) => Promise<void>
  onClose: () => void
}): React.ReactElement {
  const [mode, setMode] = React.useState<'preview' | 'source'>('preview')
  const [reloadKey, setReloadKey] = React.useState(0)
  // 弹窗打开时 code 通常已稳定，直接渲染；流式中打开则由防抖兜底
  const [stableCode, setStableCode] = React.useState(code)
  // macOS hiddenInset 红绿灯是原生控件、浮在所有 web 内容之上，头栏左侧须避让
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

  React.useEffect(() => {
    const timer = setTimeout(() => setStableCode(code), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [code])

  // Esc 关闭（capture 阶段，先于应用内其他 Esc 逻辑）
  React.useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handleDownload = React.useCallback((): void => {
    const blob = new Blob([code], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[\\/:*?"<>|]/g, '_') || 'html-artifact'}.html`
    a.click()
    URL.revokeObjectURL(url)
  }, [code, title])

  return createPortal(
    // no-drag：弹窗头栏与宿主窗口顶部的 app-region:drag 标题栏带重叠，
    // 拖拽命中在系统层判定、不吃 z-index，不豁免则头栏按钮点击会被当成拖窗口
    <div className="fixed inset-0 z-[999] flex flex-col bg-background [-webkit-app-region:no-drag] [app-region:no-drag]">
      {/* 头栏 */}
      <div className={`flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 [-webkit-app-region:no-drag] [app-region:no-drag] ${isMac ? 'pl-[84px]' : ''}`}>
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{title}</span>
        <div className="flex shrink-0 items-center gap-1 text-xs">
          <HeaderButton title={mode === 'preview' ? '查看源码' : '渲染预览'} onClick={() => setMode((m) => (m === 'preview' ? 'source' : 'preview'))}>
            <svg {...ICON_ATTRS}>{mode === 'preview' ? codeIconPath : eyeIconPath}</svg>
            <span>{mode === 'preview' ? '源码' : '预览'}</span>
          </HeaderButton>
          {mode === 'preview' && (
            <HeaderButton title="重新加载" onClick={() => setReloadKey((k) => k + 1)}>
              <svg {...ICON_ATTRS}>{refreshIconPath}</svg>
            </HeaderButton>
          )}
          <CopyButton code={code} onCopy={onCopy} />
          <HeaderButton title="下载 HTML 文件" onClick={handleDownload}>
            <svg {...ICON_ATTRS}>{downloadIconPath}</svg>
          </HeaderButton>
          <HeaderButton title="关闭（Esc）" onClick={onClose}>
            <svg {...ICON_ATTRS}>{closeIconPath}</svg>
          </HeaderButton>
        </div>
      </div>

      {/* 内容区：占满剩余视口，100vh 页面按正常比例渲染 */}
      <div className="min-h-0 flex-1">
        {mode === 'preview' ? (
          <iframe
            key={reloadKey}
            srcDoc={stableCode}
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white"
            title={title}
          />
        ) : (
          <pre className="h-full overflow-auto p-4 m-0 text-[13px] leading-[1.6] bg-muted/30 text-foreground/80">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ===== SVG 内嵌预览（矢量自适应，无比例问题，维持原交互） =====

function SvgInlineBlock({ code, onCopy }: { code: string; onCopy?: (text: string) => Promise<void> }): React.ReactElement {
  const [showPreview, setShowPreview] = React.useState(true)
  const [stableCode, setStableCode] = React.useState<string | null>(null)

  React.useEffect(() => {
    const timer = setTimeout(() => setStableCode(code), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [code])

  const isDark = document.documentElement.classList.contains('dark')
  const srcDoc = React.useMemo(() => {
    if (stableCode === null) return null
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:${isDark ? '#0f172a' : '#ffffff'};}
      svg{max-width:100%;max-height:100%;}
    </style></head><body>${stableCode}</body></html>`
  }, [stableCode, isDark])
  const renderPreview = showPreview && srcDoc !== null

  return (
    <div className="html-preview-block-wrapper rounded-lg overflow-hidden my-2 border border-border/50">
      <div className="flex items-center justify-between h-[34px] px-2 py-1 bg-muted/60 text-muted-foreground text-xs">
        <span className="font-medium select-none uppercase">SVG</span>
        <div className="flex items-center gap-1">
          <HeaderButton title={showPreview ? '查看源码' : '渲染预览'} onClick={() => setShowPreview((v) => !v)}>
            <svg {...ICON_ATTRS}>{showPreview ? codeIconPath : eyeIconPath}</svg>
            <span>{showPreview ? '源码' : '预览'}</span>
          </HeaderButton>
          <CopyButton code={code} onCopy={onCopy} />
        </div>
      </div>
      {renderPreview ? (
        <iframe srcDoc={srcDoc} sandbox="allow-scripts" className="w-full border-0 bg-white" style={{ height: 260 }} title="svg 预览" />
      ) : (
        <pre className="html-preview-block-scroll overflow-x-auto p-4 m-0 text-[13px] leading-[1.6] bg-muted/30 text-foreground/80">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

// ===== 主组件 =====

export function HtmlPreviewBlock({ code, language, onCopy }: HtmlPreviewBlockProps): React.ReactElement {
  const [popupOpen, setPopupOpen] = React.useState(false)

  if (language === 'svg') {
    return <SvgInlineBlock code={code} onCopy={onCopy} />
  }

  const title = extractHtmlTitle(code) ?? 'HTML 预览'
  const hasContent = code.trim().length > 0

  // HTML：聊天流内只放紧凑卡片，点击全屏预览（对标 Cherry HtmlArtifactsCard）
  return (
    <>
      <div className="html-preview-block-wrapper group/artifact my-2 flex w-full max-w-xl items-center overflow-hidden rounded-lg border border-border/50 bg-muted/40 transition-colors hover:bg-muted/70">
        <button
          type="button"
          disabled={!hasContent}
          onClick={() => setPopupOpen(true)}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-default"
          title={`预览：${title}`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-orange-500">
            <svg {...ICON_ATTRS} width={18} height={18}>{fileCodeIconPath}</svg>
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-foreground">{title}</span>
          <span className="shrink-0 rounded-sm bg-background px-1.5 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
            HTML
          </span>
        </button>
        <div className="mr-2 flex shrink-0 items-center gap-0.5 text-xs">
          <HeaderButton title="全屏预览" onClick={() => setPopupOpen(true)}>
            <svg {...ICON_ATTRS}>{expandIconPath}</svg>
          </HeaderButton>
          <CopyButton code={code} onCopy={onCopy} />
        </div>
      </div>

      {popupOpen && (
        <HtmlFullscreenPopup code={code} title={title} onCopy={onCopy} onClose={() => setPopupOpen(false)} />
      )}
    </>
  )
}
