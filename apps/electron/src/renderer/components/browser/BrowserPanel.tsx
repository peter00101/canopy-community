import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { BrowserViewState } from '@canopy/shared'
import { CANOPY_BRAND } from '@canopy/brand'
import { ChevronLeft, ChevronRight, ExternalLink, FileDown, LoaderCircle, RotateCw, ShieldAlert, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BROWSER_RISK_DISCLAIMER_VERSION } from '@/types/settings'
import { cn } from '@/lib/utils'
import { browserPendingNavigationMapAtom } from '@/atoms/browser-atoms'
import { BrowserSlot } from './BrowserSlot'
import { shouldReuseInitialBrowserTab } from './agent-browser-link-utils'

/** 加号菜单最多 7 项；为原生 WebContentsView 预留完整菜单及安全间距。 */
const ADD_TAB_MENU_CLEARANCE_PX = 256

interface BrowserPanelProps {
  sessionId: string
  /** 由右侧统一顶栏选中的网页。 */
  tabId: string
  state: BrowserViewState | null
  /** 右侧加号菜单展开时，原生浏览器必须避让其 renderer 区域。 */
  isAddTabMenuOpen?: boolean
}

export function BrowserPanel({ sessionId, tabId, state, isAddTabMenuOpen = false }: BrowserPanelProps): React.ReactElement {
  const [url, setUrl] = React.useState(state?.url ?? '')
  const [riskAcknowledged, setRiskAcknowledged] = React.useState<boolean | null>(null)
  const [savingRiskAcknowledgement, setSavingRiskAcknowledgement] = React.useState(false)
  const pendingNavigationUrl = useAtomValue(browserPendingNavigationMapAtom).get(sessionId)
  const setPendingNavigationMap = useSetAtom(browserPendingNavigationMapAtom)

  const selectedTab = state?.tabs.find((tab) => tab.tabId === tabId) ?? null
  React.useEffect(() => setUrl(selectedTab?.url ?? ''), [selectedTab?.url])
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.getSettings()
      .then((settings) => {
        if (!cancelled) setRiskAcknowledged((settings.browserRiskDisclaimerVersion ?? 0) >= BROWSER_RISK_DISCLAIMER_VERSION)
      })
      .catch((error) => {
        console.error('[受管浏览器] 读取风险告知状态失败:', error)
        if (!cancelled) setRiskAcknowledged(false)
      })
    return () => { cancelled = true }
  }, [])

  const navigate = React.useCallback(async () => {
    const value = url.trim()
    const navigateBrowser = (window.electronAPI as Partial<typeof window.electronAPI>).navigateAgentBrowser
    if (!value || typeof navigateBrowser !== 'function') return
    try { await navigateBrowser({ sessionId, tabId, url: value }) } catch (error) { console.error('[受管浏览器] 导航失败:', error) }
  }, [sessionId, tabId, url])

  const closeBrowser = React.useCallback(async () => {
    try {
      await window.electronAPI.closeAgentBrowser(sessionId)
    } catch (error) {
      console.error('[受管浏览器] 关闭失败:', error)
    }
  }, [sessionId])

  const acceptRiskDisclaimer = React.useCallback(async () => {
    setSavingRiskAcknowledgement(true)
    try {
      await window.electronAPI.updateSettings({ browserRiskDisclaimerVersion: BROWSER_RISK_DISCLAIMER_VERSION })
      setRiskAcknowledged(true)
      if (pendingNavigationUrl) {
        try {
          const currentState = await window.electronAPI.getAgentBrowserState(sessionId)
          if (!currentState) throw new Error('受管浏览器会话不存在。')
          if (shouldReuseInitialBrowserTab(currentState)) {
            await window.electronAPI.navigateAgentBrowser({ sessionId, url: pendingNavigationUrl })
          } else {
            await window.electronAPI.createAgentBrowserTab({ sessionId, url: pendingNavigationUrl })
          }
        } catch (error) {
          console.error('[受管浏览器] 打开待处理链接失败:', error)
        } finally {
          setPendingNavigationMap((previous) => {
            const next = new Map(previous)
            next.delete(sessionId)
            return next
          })
        }
      } else {
        // 重新进入 controller.open，让已确认风险的用户初始标签导航到默认搜索引擎首页（默认必应，跟随设置）。
        await window.electronAPI.openAgentBrowser(sessionId)
      }
    } catch (error) {
      console.error('[受管浏览器] 保存风险告知确认失败:', error)
    } finally {
      setSavingRiskAcknowledgement(false)
    }
  }, [pendingNavigationUrl, sessionId, setPendingNavigationMap])

  const stopBackgroundRun = React.useCallback(async () => {
    if (state?.executionSource === 'user') return
    try {
      await window.electronAPI.stopAgent(sessionId)
    } catch (error) {
      console.error('[受管浏览器] 停止后台 Agent 失败:', error)
    }
  }, [sessionId, state?.executionSource])

  // 我方分叉：上游 #1740 删除了「Agent 活动」行，我方保留——它是 activity 的唯一渲染点，也是 view 崩溃提示的界面落点。
  const agentTabId = state?.agentTabId ?? ''
  const activity = state?.activity ?? null
  const activityStatus = activity?.status === 'unknown' ? '结果未知' : activity?.status === 'failed' ? '失败' : activity?.status === 'dispatched' ? '已派发' : '已完成'
  const activityDomain = activity?.domain ? ` · ${activity.domain}` : ''

  // 我方分叉：在系统默认浏览器打开当前页
  const openInDefaultBrowser = React.useCallback(() => {
    const value = url.trim()
    if (value.startsWith('http://') || value.startsWith('https://')) void window.electronAPI.openExternal(value)
  }, [url])

  // 我方分叉：导出当前页面为 PDF
  const [exportingPdf, setExportingPdf] = React.useState(false)
  const exportPdf = React.useCallback(async () => {
    const doExport = (window.electronAPI as Partial<typeof window.electronAPI>).exportAgentBrowserPdf
    if (typeof doExport !== 'function' || exportingPdf) return
    setExportingPdf(true)
    try {
      await doExport({ sessionId })
    } catch (error) {
      toast.error('导出 PDF 失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setExportingPdf(false)
    }
  }, [exportingPdf, sessionId])

  // 我方分叉：下载/导出进入终态时提示一次；记录已提示 id 防止状态广播重放导致刷屏
  const notifiedDownloadsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    for (const download of state?.downloads ?? []) {
      if (download.state === 'in_progress' || notifiedDownloadsRef.current.has(download.id)) continue
      notifiedDownloadsRef.current.add(download.id)
      if (download.state === 'completed') {
        toast.success(download.source === 'pdf-export' ? `已导出 PDF：${download.filename}` : `下载完成：${download.filename}`, {
          action: {
            label: '在文件夹中显示',
            onClick: () => void (window.electronAPI as Partial<typeof window.electronAPI>).showAgentBrowserDownload?.({ sessionId, path: download.path }),
          },
        })
      } else {
        toast.error(`下载${download.state === 'cancelled' ? '已取消' : '中断'}：${download.filename}`, {
          description: download.reason,
        })
      }
    }
  }, [sessionId, state?.downloads])

  const riskBlocked = riskAcknowledged !== true
  // 外层右侧 Tab 会先更新 UI，再异步激活 controller 中的原生标签；激活完成前禁用
  // 依赖 controller.activeTabId 的历史操作，导航则始终显式携带当前 tabId。
  const isControllerTabActive = state?.activeTabId === tabId
  const isBackgroundRun = state?.executionSource === 'automation' || state?.executionSource === 'delegation'
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden border-l border-border/80 bg-content-area titlebar-no-drag">
      <div className="flex items-center h-[42px] gap-1 px-2 border-b border-border/40 bg-muted/20">
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground" disabled={riskBlocked || !isControllerTabActive || !state?.canGoBack} onClick={() => void window.electronAPI.goBackAgentBrowser?.(sessionId)}><ChevronLeft className="size-5" /></Button></TooltipTrigger><TooltipContent>后退</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground" disabled={riskBlocked || !isControllerTabActive || !state?.canGoForward} onClick={() => void window.electronAPI.goForwardAgentBrowser?.(sessionId)}><ChevronRight className="size-5" /></Button></TooltipTrigger><TooltipContent>前进</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground" disabled={riskBlocked || !isControllerTabActive} onClick={() => void window.electronAPI.reloadAgentBrowser?.(sessionId)}><RotateCw className="size-[18px]" /></Button></TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>
        <form className="flex-1 min-w-0" onSubmit={(event) => { event.preventDefault(); if (!riskBlocked) void navigate() }}>
          <Input disabled={riskBlocked || !isControllerTabActive} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="输入网址或搜索内容" className="h-7 bg-background/70 text-xs text-muted-foreground/70" aria-label="浏览器地址" />
        </form>
        {state?.loading && <LoaderCircle className="size-3.5 text-muted-foreground animate-spin" />}
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7" disabled={!url.startsWith('http://') && !url.startsWith('https://')} onClick={openInDefaultBrowser} aria-label="在系统默认浏览器中打开当前网页"><ExternalLink className="size-3.5" /></Button></TooltipTrigger><TooltipContent>在系统默认浏览器中打开</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7" disabled={riskBlocked || exportingPdf || !state?.url} onClick={() => void exportPdf()} aria-label="导出当前页面为 PDF">{exportingPdf ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}</Button></TooltipTrigger><TooltipContent>导出当前页面为 PDF</TooltipContent></Tooltip>
        {isBackgroundRun && (
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-warning hover:text-warning" onClick={() => void stopBackgroundRun()} aria-label="停止当前后台 Agent"><Square className="size-3.5 fill-current" /></Button></TooltipTrigger><TooltipContent>停止当前{state?.executionSource === 'automation' ? '自动任务' : '委派'}运行</TooltipContent></Tooltip>
        )}
      </div>
      {activity && (
        <div className="flex min-h-7 items-center gap-2 border-b border-border/25 bg-primary/[0.04] px-3 py-1 text-[11px]" role="status" aria-live="polite">
          <span className="shrink-0 font-medium text-primary">Agent 活动</span>
          <span className="shrink-0 text-muted-foreground">{activityStatus}</span>
          <span className="truncate text-foreground/80">{activity.summary}{activityDomain}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{activity.tabId === agentTabId ? '工作标签' : `标签 ${activity.tabId}`}</span>
        </div>
      )}
      {riskAcknowledged === true ? (
        <div
          className="flex flex-1 min-h-0 flex-col"
          style={isAddTabMenuOpen ? { paddingTop: ADD_TAB_MENU_CLEARANCE_PX } : undefined}
        >
          <BrowserSlot key={tabId} sessionId={sessionId} tabId={tabId} />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 items-center justify-center bg-muted/15 px-8 text-center">
          <div className="max-w-sm space-y-2 text-muted-foreground">
            <ShieldAlert className="mx-auto size-7 text-warning/90" />
            <p className="text-sm font-medium text-foreground">使用前请阅读风险告知</p>
            <p className="text-xs leading-5">受管浏览器将在确认后启用，登录状态只保存在本机。</p>
          </div>
        </div>
      )}
      <AlertDialog open={riskAcknowledged === false} onOpenChange={(open) => { if (!open && !savingRiskAcknowledgement) void closeBrowser() }}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-warning-soft text-warning dark:text-warning">
              <ShieldAlert className="size-5" />
            </div>
            <AlertDialogTitle className="text-balance">首次使用受管浏览器</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left leading-6">
                <p>{CANOPY_BRAND.productName} 可让 Agent 在浏览器中读取、搜索、点击和输入。部分平台可能将这些行为或高频操作识别为自动化活动。</p>
                <p>这可能导致验证码、限流、功能限制、账号风控，严重时可能造成账号处罚或封禁。请自行了解并遵守目标平台规则，并自行承担相应风险。</p>
                <p className="text-xs">{CANOPY_BRAND.productName} 不会保证第三方平台接受这些操作；请避免不必要的高频互动，并在重要操作前核对页面状态。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingRiskAcknowledgement}>暂不使用</AlertDialogCancel>
            <Button type="button" disabled={savingRiskAcknowledgement} onClick={() => void acceptRiskDisclaimer()}>
              {savingRiskAcknowledgement ? '正在确认…' : '我已知悉并承担风险'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
