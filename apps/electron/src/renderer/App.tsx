import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { EnvironmentCheckDialog } from './components/environment/EnvironmentCheckDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { ShortcutGuideDialog } from './components/shortcuts/ShortcutGuideDialog'
import { FaqDialog } from './components/shortcuts/FaqDialog'
import { WindowControls } from './components/WindowControls'
import { detectIsWindows } from './lib/platform'
import { getWindowTitlebarContentInsetClass } from './lib/window-titlebar-layout'
import { cn } from './lib/utils'
import { PlanningReminderRail } from './components/planning/PlanningReminderRail'
import { conversationsAtom, currentConversationIdAtom } from './atoms/chat-atoms'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { onboardingReplayRequestedAtom } from './atoms/onboarding'
import { settingsOpenAtom, settingsTabAtom } from './atoms/settings-tab'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID, TUTORIAL_TAB_TITLE } from './atoms/tab-atoms'
import { appModeAtom } from './atoms/app-mode'
import { activeViewAtom } from './atoms/active-view'
import {
  getOnboardingDestination,
  getOnboardingEntry,
  planWelcomeConversationEntry,
} from './components/onboarding/onboarding-flow'
import { hasCompletedCurrentOnboarding } from '../types'
import appMarkWhite from './assets/onboarding/canopy-mark-white.svg'
import { CANOPY_BRAND } from '@canopy/brand'

export default function App(): React.ReactElement {
  // 应用级初始化状态。

  const store = useStore()
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)
  const [onboardingReplayRequested, setOnboardingReplayRequested] = useAtom(onboardingReplayRequestedAtom)
  const [isReplayingOnboarding, setIsReplayingOnboarding] = React.useState(false)
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  // 初始化：检查是否需要显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const settings = await window.electronAPI.getSettings()
        if (!hasCompletedCurrentOnboarding(settings)) {
          setShowOnboarding(true)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [])

  // 设置页请求重放时跳过欢迎页，但保留完整的后续 Onboarding 流程。
  React.useEffect(() => {
    if (!onboardingReplayRequested || isLoading) return

    setIsReplayingOnboarding(true)
    setShowOnboarding(true)
    setOnboardingReplayRequested(false)
  }, [isLoading, onboardingReplayRequested, setOnboardingReplayRequested])

  // 完成 onboarding 回调：重放时回到设置页，首次完成直接进入主界面
  // 完成 onboarding 回调：创建欢迎对话，可选打开教程 Tab
  // 整条教程链路是我方保留项：上游 v0.19.26（#1984）连同 shared 通道常量一并删除，我方不采。
  // 「开始使用」与右上角跳过/退出（含 Esc）共用这一个回调；完成状态已由 OnboardingView 按入口写好。
  const handleOnboardingComplete = async (openTutorial?: boolean) => {
    const destination = getOnboardingDestination(getOnboardingEntry(isReplayingOnboarding))
    const hideOnboarding = () => {
      setShowOnboarding(false)
      setIsReplayingOnboarding(false)
    }

    if (destination === 'settings-onboarding') {
      hideOnboarding()
      store.set(settingsTabAtom, 'onboarding')
      store.set(settingsOpenAtom, true)
      return
    }

    if (openTutorial) {
      hideOnboarding()
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: TUTORIAL_TAB_TITLE })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      return
    }

    try {
      const meta = await window.electronAPI.createWelcomeConversation()
      if (meta) {
        const conversations = store.get(conversationsAtom)
        store.set(conversationsAtom, [meta, ...conversations])

        // Tab、模式、当前对话一次对齐（同 useOpenSession 打开 Chat 会话），左栏才会切到 Chat 列表并选中欢迎对话
        const plan = planWelcomeConversationEntry(store.get(tabsAtom), meta)
        store.set(tabsAtom, plan.tabs)
        store.set(activeTabIdAtom, plan.activeTabId)
        store.set(appModeAtom, plan.appMode)
        store.set(currentConversationIdAtom, plan.currentConversationId)
        store.set(activeViewAtom, plan.activeView)
      }
    } catch (error) {
      console.error('[App] 创建欢迎对话失败:', error)
    } finally {
      // 必须先写好 Tab 与模式再卸载引导：若先挂 AppShell，Tab 为空时 WelcomeView 会按旧模式（默认 agent）抢建草稿会话
      hideOnboarding()
    }
  }

  // 加载中状态
  if (isLoading) {
    return <StartupLoadingScreen />
  }

  // 显示 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200} disableHoverableContent>
        <div className={cn('relative h-screen w-screen overflow-hidden', getWindowTitlebarContentInsetClass(isWindows))}>
          <WindowControls />
          <OnboardingView
            initialStep={isReplayingOnboarding ? 'guide' : 'welcome'}
            entry={getOnboardingEntry(isReplayingOnboarding)}
            onComplete={handleOnboardingComplete}
          />
        </div>
      </TooltipProvider>
    )
  }

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200} disableHoverableContent>
      <AppShell />
      <PlanningReminderRail />
      <ShortcutGuideDialog />
      <FaqDialog />
      <GlobalEnvironmentCheckDialog />
    </TooltipProvider>
  )
}

/**
 * 应用启动时复用 Onboarding 首屏的品牌视觉，让冷启动阶段也保持一致的品牌体验。
 */
function StartupLoadingScreen(): React.ReactElement {
  return (
    <main
      className="relative flex h-screen items-center justify-center overflow-hidden bg-[#6D28D9] text-white"
      aria-busy="true"
      aria-live="polite"
    >
      {/* 品牌紫渐变底 + 树冠光斑（与 Onboarding 欢迎页一致，不依赖位图资产） */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#C3A8FF] via-[#A07CF2] to-[#7C3AED]" />
      <div className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
      <div className="absolute bottom-[-20%] right-[-10%] h-96 w-96 rounded-full bg-[#C4B5FD]/25 blur-3xl" />
      <svg
        aria-hidden="true"
        viewBox="0 0 64 64"
        className="absolute -right-16 top-1/2 h-[130%] w-auto -translate-y-1/2 opacity-[0.14]"
        fill="none"
      >
        <path d="M44 16 A20 20 0 1 0 44 48" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
        <path d="M36 28 Q42 20 50 22" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M36 28 Q38 34 36 40" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
      </svg>

      <div className="relative flex w-full max-w-sm flex-col items-center px-8 text-center">
        <div className="flex items-center gap-3">
          <img
            src={appMarkWhite}
            alt=""
            className="h-9 w-9 object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
          />
          <span className="text-xl font-light tracking-wide">{CANOPY_BRAND.productName}</span>
        </div>

        <p className="mt-6 max-w-xs text-balance text-lg font-light leading-relaxed tracking-[0.04em] text-white/95">
          让协作自然发生，让想法流动成形
        </p>

        <div className="mt-7 h-px w-24 overflow-hidden bg-white/35">
          <div className="h-full w-2/5 animate-pulse bg-white/90" />
        </div>
        <p className="mt-4 text-sm font-medium tracking-[0.08em] text-white/95">正在启动 {CANOPY_BRAND.productName}</p>
      </div>

      <p className="absolute bottom-8 px-6 text-center text-[11px] uppercase tracking-[0.3em] text-white/65">
        Local-first AI Agent
      </p>
    </main>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
