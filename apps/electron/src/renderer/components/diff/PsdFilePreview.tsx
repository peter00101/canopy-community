/**
 * PsdFilePreview — 右侧面板的 PSD 内联预览。
 *
 * 左边是合成图（透明区域画棋盘格，可在「适应 / 100%」间切换），右边是图层树：
 * 点眼睛临时改显隐，主进程重新合成后刷新，不改文件。合成来自主进程的 psd-service
 * （内置 ag-psd，或用户机器上的 psd-tools 高保真引擎，顶栏有标注）。
 */

import * as React from 'react'
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Shapes,
  SlidersHorizontal,
  Type as TypeIcon,
} from 'lucide-react'
import type { FileAccessOptions, PsdLayerNode, PsdPreviewResult } from '@canopy/shared'
import { cn } from '@/lib/utils'

interface PsdFilePreviewProps {
  filePath: string
  fileAccess: FileAccessOptions
}

type Phase = 'loading' | 'ready' | 'error'

/** 有效显隐：临时改写优先于文件里的值 */
function isEffectivelyHidden(node: PsdLayerNode, overrides: ReadonlyMap<string, boolean>): boolean {
  const override = overrides.get(node.id)
  return override === undefined ? node.hidden : override
}

function kindIcon(kind: PsdLayerNode['kind'], opened: boolean): React.ReactElement {
  const cls = 'size-3.5 shrink-0'
  switch (kind) {
    case 'group':
      return opened ? <FolderOpen className={cls} /> : <Folder className={cls} />
    case 'artboard':
      return <Layers className={cls} />
    case 'text':
      return <TypeIcon className={cls} />
    case 'adjustment':
      return <SlidersHorizontal className={cls} />
    case 'smart-object':
      return <Box className={cls} />
    case 'shape':
      return <Shapes className={cls} />
    default:
      return <ImageIcon className={cls} />
  }
}

const KIND_LABEL: Record<PsdLayerNode['kind'], string> = {
  group: '分组',
  artboard: '画板',
  pixel: '像素',
  text: '文字',
  adjustment: '调整层',
  'smart-object': '智能对象',
  shape: '形状',
}

/** 棋盘格背景，透明区域一眼可辨 */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundColor: 'hsl(var(--muted) / 0.5)',
  backgroundImage:
    'linear-gradient(45deg, hsl(var(--border) / 0.5) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--border) / 0.5) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--border) / 0.5) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--border) / 0.5) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
}

interface LayerRowProps {
  node: PsdLayerNode
  depth: number
  overrides: ReadonlyMap<string, boolean>
  collapsed: ReadonlySet<string>
  parentHidden: boolean
  onToggleVisible: (node: PsdLayerNode) => void
  onToggleCollapse: (id: string) => void
}

function LayerRow({ node, depth, overrides, collapsed, parentHidden, onToggleVisible, onToggleCollapse }: LayerRowProps): React.ReactElement {
  const hidden = isEffectivelyHidden(node, overrides)
  const dimmed = hidden || parentHidden
  const isGroup = node.kind === 'group' || node.kind === 'artboard'
  const isCollapsed = collapsed.has(node.id)
  const meta: string[] = []
  if (node.opacity < 1) meta.push(`${Math.round(node.opacity * 100)}%`)
  if (node.blendMode && node.blendMode !== 'normal' && node.blendMode !== 'pass through') meta.push(node.blendMode)
  if (node.hasMask) meta.push('蒙版')
  if (node.clipping) meta.push('剪贴')
  if (node.effects?.length) meta.push('fx')
  const title = [
    `${KIND_LABEL[node.kind]} · id ${node.id}`,
    node.bounds ? `位置 (${node.bounds.left}, ${node.bounds.top}) 尺寸 ${node.bounds.right - node.bounds.left}×${node.bounds.bottom - node.bounds.top}` : '',
    node.text ? `文字：${node.text}` : '',
    node.effects?.length ? `效果：${node.effects.join('、')}` : '',
  ].filter(Boolean).join('\n')
  return (
    <>
      <div
        className={cn('group flex items-center gap-1 h-7 pr-1 text-[12px] rounded-md hover:bg-muted/60', dimmed && 'text-muted-foreground/60')}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={title}
        data-psd-layer-id={node.id}
      >
        <button
          type="button"
          className={cn('size-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted', !hidden && 'text-foreground/80')}
          aria-label={hidden ? `显示图层 ${node.name}` : `隐藏图层 ${node.name}`}
          aria-pressed={!hidden}
          onClick={() => onToggleVisible(node)}
        >
          {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        {isGroup ? (
          <button
            type="button"
            className="size-4 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
            aria-label={isCollapsed ? `展开分组 ${node.name}` : `收起分组 ${node.name}`}
            onClick={() => onToggleCollapse(node.id)}
          >
            {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className="text-muted-foreground/80">{kindIcon(node.kind, !isCollapsed)}</span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {meta.length > 0 && <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">{meta.join(' · ')}</span>}
      </div>
      {isGroup && !isCollapsed && node.children && [...node.children].reverse().map((child) => (
        <LayerRow
          key={child.id}
          node={child}
          depth={depth + 1}
          overrides={overrides}
          collapsed={collapsed}
          parentHidden={dimmed}
          onToggleVisible={onToggleVisible}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </>
  )
}

export function PsdFilePreview({ filePath, fileAccess }: PsdFilePreviewProps): React.ReactElement {
  const [result, setResult] = React.useState<PsdPreviewResult | null>(null)
  const [phase, setPhase] = React.useState<Phase>('loading')
  const [error, setError] = React.useState('')
  const [rendering, setRendering] = React.useState(false)
  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(() => new Map())
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())
  const [panelOpen, setPanelOpen] = React.useState(true)
  const [actualSize, setActualSize] = React.useState(false)
  const requestSeq = React.useRef(0)

  const load = React.useCallback(async (nextOverrides: ReadonlyMap<string, boolean>, initial: boolean): Promise<void> => {
    const seq = ++requestSeq.current
    if (initial) setPhase('loading')
    else setRendering(true)
    const hiddenLayerIds = [...nextOverrides.entries()].filter(([, hidden]) => hidden).map(([id]) => id)
    const visibleLayerIds = [...nextOverrides.entries()].filter(([, hidden]) => !hidden).map(([id]) => id)
    try {
      const next = await window.electronAPI.psdPreview(filePath, { hiddenLayerIds, visibleLayerIds }, fileAccess)
      if (seq !== requestSeq.current) return
      if (!next) {
        setPhase('error')
        setError('无法预览这个 PSD：文件损坏、超过体积上限、是 .psb 大型文档，或不在授权目录内。可用默认应用打开。')
        return
      }
      setResult(next)
      setPhase('ready')
    } catch (err) {
      if (seq !== requestSeq.current) return
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === requestSeq.current) setRendering(false)
    }
  }, [filePath, fileAccess])

  React.useEffect(() => {
    const fresh = new Map<string, boolean>()
    setOverrides(fresh)
    setResult(null)
    void load(fresh, true)
  }, [load])

  const handleToggleVisible = React.useCallback((node: PsdLayerNode) => {
    setOverrides((previous) => {
      const next = new Map(previous)
      next.set(node.id, !isEffectivelyHidden(node, previous))
      void load(next, false)
      return next
    })
  }, [load])

  const handleToggleCollapse = React.useCallback((id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleResetOverrides = React.useCallback(() => {
    const fresh = new Map<string, boolean>()
    setOverrides(fresh)
    void load(fresh, false)
  }, [load])

  if (phase === 'loading') {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">正在渲染 PSD…</div>
  }
  if (phase === 'error' || !result) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
        <div className="text-[13px] text-foreground/80">无法预览 PSD</div>
        <div className="text-[12px] text-muted-foreground">{error}</div>
      </div>
    )
  }

  const topDown = [...result.layers].reverse()
  const engineLabel = result.engine === 'psd-tools' ? 'psd-tools 高保真' : '内置引擎'
  const overrideCount = overrides.size

  return (
    <div className="flex h-full min-h-0 flex-col" data-psd-preview="">
      <div className="flex items-center gap-2 h-8 px-2 border-b border-border/40 text-[11px] text-muted-foreground shrink-0">
        <span className="tabular-nums">{result.width} × {result.height}</span>
        {result.colorMode && <span className="uppercase">{result.colorMode}</span>}
        <span className="rounded bg-muted px-1.5 py-px" title="产出合成图的引擎">{engineLabel}</span>
        {result.warnings && result.warnings.length > 0 && (
          <span className="rounded bg-warning/15 text-warning px-1.5 py-px cursor-help" title={result.warnings.join('\n')}>
            {result.warnings.length} 条提醒
          </span>
        )}
        {rendering && <span className="text-foreground/60">重新合成中…</span>}
        <span className="flex-1" />
        {overrideCount > 0 && (
          <button type="button" className="rounded px-1.5 py-px hover:bg-muted hover:text-foreground" onClick={handleResetOverrides}>
            还原显隐（{overrideCount}）
          </button>
        )}
        <button
          type="button"
          className={cn('rounded px-1.5 py-px hover:bg-muted hover:text-foreground', actualSize && 'bg-muted text-foreground')}
          onClick={() => setActualSize((v) => !v)}
          aria-pressed={actualSize}
        >
          {actualSize ? '100%' : '适应'}
        </button>
        <button
          type="button"
          className="size-6 inline-flex items-center justify-center rounded hover:bg-muted hover:text-foreground"
          aria-label={panelOpen ? '收起图层面板' : '展开图层面板'}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
        </button>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className={cn('flex-1 min-w-0 overflow-auto scrollbar-thin', !actualSize && 'flex items-center justify-center p-3')} style={CHECKER_STYLE}>
          <img
            src={result.compositeUrl}
            alt={`${filePath} 合成图`}
            draggable={false}
            className={cn('shadow-sm', actualSize ? 'max-w-none m-3' : 'max-w-full max-h-full object-contain')}
            style={actualSize ? { width: result.width, height: result.height } : undefined}
          />
        </div>
        {panelOpen && (
          <div className="w-60 shrink-0 border-l border-border/40 flex flex-col min-h-0" aria-label="图层">
            <div className="h-7 px-2 flex items-center text-[11px] font-medium text-foreground/70 border-b border-border/30 shrink-0">
              图层 · {countNodes(result.layers)}
            </div>
            <div className="flex-1 min-h-0 overflow-auto scrollbar-thin py-1 px-1">
              {topDown.map((node) => (
                <LayerRow
                  key={node.id}
                  node={node}
                  depth={0}
                  overrides={overrides}
                  collapsed={collapsed}
                  parentHidden={false}
                  onToggleVisible={handleToggleVisible}
                  onToggleCollapse={handleToggleCollapse}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function countNodes(nodes: PsdLayerNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countNodes(node.children) : 0), 0)
}
