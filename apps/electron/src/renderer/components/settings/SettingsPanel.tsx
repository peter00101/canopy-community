/**
 * SettingsPanel - 设置面板
 *
 * 在应用主工作区中展示左侧导航和右侧内容区域：普通设置页套统一的 ScrollArea，
 * 自带滚动容器的页面（Canopy 教程）直接铺满，见 settings-navigation.ts。
 * 使用 Jotai atom 管理当前标签页状态，保持已有设置项与分组顺序。
 * 所有导航项只切换右侧内容，不关设置、不动主区 Tab / 视图 / 模式。
 */

import * as React from "react";
import { useAtom, useAtomValue } from "jotai";
import { cn } from "@/lib/utils";
import { detectIsMac, detectIsWindows } from "@/lib/platform";
import { getSettingsTopBandLabelInsetPx, getWindowTitlebarDragInsetStyle } from "@/lib/window-titlebar-layout";
import { PALETTE_TONE_COUNT, paletteToneTextClass, type PaletteTone } from "@/lib/palette-tone";
import {
  Settings,
  Radio,
  Eye,
  Palette,
  Info,
  Globe,
  BookOpen,
  Wrench,
  Bot,
  GraduationCap,
  ArrowLeft,
  Keyboard,
  Mic,
  HardDriveDownload,
  HardDrive,
  BarChart3,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShortcutKeycaps } from "@/components/shortcuts/ShortcutKeycaps";
import {
  settingsTabAtom,
  channelFormDirtyAtom,
  settingsCloseRequestedAtom,
  settingsPendingSessionNavigationAtom,
  type SettingsSessionNavigation,
} from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { VisionRelaySettings } from "./VisionRelaySettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProxySettings } from "./ProxySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { UsageStatsSettings } from "./UsageStatsSettings";
import { AboutSettings } from "./AboutSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { MigrationSettings } from "./MigrationSettings";
import { StorageSettings } from "./StorageSettings";
import { OnboardingSettings } from "./OnboardingSettings";
import { TutorialReader } from "@/components/tutorial/TutorialReader";
import { getSettingsContentLayout, resolveSettingsNavigation } from "./settings-navigation";
import { useOpenSession } from '@/hooks/useOpenSession'
import { CANOPY_BRAND } from '@canopy/brand'

/** 设置 Tab 定义 */
interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
  /** 页头一句话说明（配色体系页头：当前分区图标 + 标题 + 说明） */
  description?: string;
}

/** 基础 Tabs（所有模式都有） */
const BASE_TABS: TabItem[] = [
  { id: "general", label: "通用设置", icon: <Settings size={16} />, description: "档案、入口开关、通知与提示音" },
  { id: "channels", label: "模型配置", icon: <Radio size={16} />, description: "供应商连接、API Key 与可用模型" },
  { id: "vision-relay", label: "视觉助手", icon: <Eye size={16} />, description: "给不支持看图的模型补上视觉与视频理解" },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} />, description: "Chat 模式使用的系统提示词" },
  { id: "proxy", label: "代理设置", icon: <Globe size={16} />, description: "网络代理与连通性" },
];

const TOOLS_TAB: TabItem = {
  id: "tools",
  label: "Chat 工具",
  icon: <Wrench size={16} />,
  description: "Chat 模式可调用的搜索与生图工具",
};
const BOTS_TAB: TabItem = {
  id: "bots",
  label: "远程连接",
  icon: <Bot size={16} />,
  description: "飞书、钉钉、企业微信桥接",
};
const TUTORIAL_TAB: TabItem = {
  id: "tutorial",
  label: `${CANOPY_BRAND.productName} 教程`,
  icon: <GraduationCap size={16} />,
  description: "应用内使用教程",
};
const SHORTCUTS_TAB: TabItem = {
  id: "shortcuts",
  label: "快捷键管理",
  icon: <Keyboard size={16} />,
  description: "全局与应用内快捷键",
};
const ONBOARDING_TAB: TabItem = {
  id: "onboarding",
  label: `${CANOPY_BRAND.productName} 新手引导`,
  icon: <GraduationCap size={16} />,
  description: "重新走一遍首次启动引导",
};
const VOICE_INPUT_TAB: TabItem = {
  id: "voice-input",
  label: "语音输入",
  icon: <Mic size={16} />,
  description: "语音识别服务与快捷键",
};
/** 尾部 Tabs */
const TAIL_TABS: TabItem[] = [
  { id: "usage", label: "用量统计", icon: <BarChart3 size={16} />, description: "按会话、日期与渠道查看 token 用量" },
  { id: "migration", label: "数据迁移", icon: <HardDriveDownload size={16} />, description: "导入导出会话与配置" },
  { id: "storage", label: "磁盘管理", icon: <HardDrive size={16} />, description: "本地数据占用与清理" },
  { id: "appearance", label: "外观设置", icon: <Palette size={16} />, description: "主题配色、界面风格与图标" },
  ONBOARDING_TAB,
  { id: "about", label: "关于/更新", icon: <Info size={16} />, description: "版本、环境检查与依赖状态" },
];

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "vision-relay":
      return <VisionRelaySettings />;
    case "prompts":
      return <PromptSettings />;
    case "proxy":
      return <ProxySettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "voice-input":
      return <VoiceInputSettings />;
    case "migration":
      return <MigrationSettings />;
    case "storage":
      return <StorageSettings />;
    case "usage":
      return <UsageStatsSettings />;
    case "onboarding":
      return <OnboardingSettings />;
    case "tutorial":
      // 就地阅读：自带滚动容器，外层不套 ScrollArea（getSettingsContentLayout）
      return <TutorialReader />;
    default:
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  // mac：设置页铺满整窗、MacTitleRow 已隐藏，顶带落在 y=0，标签要让开原生红绿灯
  const isMac = React.useMemo(() => detectIsMac(), [])
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const [pendingSessionNavigation, setPendingSessionNavigation] = useAtom(settingsPendingSessionNavigationAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const openSession = useOpenSession()
  /** 统一的退出拦截对话框状态 */
  type PendingAction =
    | { type: 'tab'; tabId: SettingsTab }
    | { type: 'close' }
    | { type: 'session'; navigation: SettingsSessionNavigation }
    | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      setActiveTab(pendingAction.tabId)
    } else if (pendingAction.type === 'session') {
      openSession(
        pendingAction.navigation.type,
        pendingAction.navigation.sessionId,
        pendingAction.navigation.title,
        { bypassSettingsGuard: true },
      )
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  /** 切换标签页时检测是否有未保存内容；所有导航项（含 Canopy 教程）都只切换右侧内容 */
  const handleTabChange = (tabId: SettingsTab): void => {
    const intent = resolveSettingsNavigation({
      currentTab: activeTab,
      targetTab: tabId,
      channelFormDirty,
    })
    if (intent.kind === 'confirm-discard') {
      setPendingAction({ type: 'tab', tabId: intent.tabId })
      return
    }
    if (intent.kind === 'switch') {
      setActiveTab(intent.tabId)
    }
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = React.useCallback((): void => {
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }, [activeTab, channelFormDirty, onClose])

  /** 按 ESC 退出设置面板：window 级监听确保焦点在设置面板内任何位置（含 body）都生效；
   *  Radix 弹层（Select 下拉/AlertDialog/Popover 等）处理 ESC 时会 preventDefault，
   *  此时交给弹层自行关闭，不退出设置。 */
  React.useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      handleClose()
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [handleClose])

  // 左侧会话点击在渠道表单有未保存内容时，由 useOpenSession 暂存目标并交给此处确认。
  React.useEffect(() => {
    if (!pendingSessionNavigation) return
    setPendingAction({ type: 'session', navigation: pendingSessionNavigation })
    setPendingSessionNavigation(null)
  }, [pendingSessionNavigation, setPendingSessionNavigation])

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (closeRequested && activeTab === 'channels') {
      setPendingAction({ type: 'close' })
      setCloseRequested(false)
    }
  }, [closeRequested, activeTab, setCloseRequested])

  // 工具 tab 两种模式都显示，Agent Skills / MCP 独立在侧边栏能力中心管理。
  const tabs = React.useMemo(() => {
    if (appMode === "agent") {
      return [
        ...BASE_TABS,
        TOOLS_TAB,
        VOICE_INPUT_TAB,
        BOTS_TAB,
        TUTORIAL_TAB,
        SHORTCUTS_TAB,
        ...TAIL_TABS,
      ];
    }
    return [
      ...BASE_TABS,
      TOOLS_TAB,
      VOICE_INPUT_TAB,
      BOTS_TAB,
      TUTORIAL_TAB,
      SHORTCUTS_TAB,
      ...TAIL_TABS,
    ];
  }, [appMode]);

  const activeTabIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const activeTabItem = activeTabIndex >= 0 ? tabs[activeTabIndex] : undefined;
  const activeTabTone = (((activeTabIndex >= 0 ? activeTabIndex : 0) % PALETTE_TONE_COUNT) + 1) as PaletteTone;

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-area text-foreground">
      {/* 顶带：拖拽区之外放一个「设置」标签，让这条 35px 不再是空白同色带；底色与导航同为辅助面 */}
      <div className="settings-topband relative h-[35px] flex-shrink-0">
        <div
          aria-hidden="true"
          className="titlebar-drag-region pointer-events-none absolute inset-y-0 left-0"
          style={getWindowTitlebarDragInsetStyle(isWindows)}
        />
        <span
          className="pointer-events-none absolute top-0 flex h-[35px] items-center text-[12px] font-medium tracking-wide text-fg-2"
          style={{ left: getSettingsTopBandLabelInsetPx(isMac) }}
        >
          设置
        </span>
      </div>

      {/* 主体：左导航 + 右内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 Tab 导航：图标按色族轮流上色，选中态走 accent-2（配色体系） */}
        <div className="flex h-full min-h-0 w-[var(--layout-settings-nav-w)] flex-shrink-0 flex-col border-r border-border/80 bg-[hsl(var(--sidebar-surface))] dark:border-border/70">
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-4 scrollbar-thin">
            {tabs.map((tab, index) => {
              const tone = ((index % PALETTE_TONE_COUNT) + 1) as PaletteTone;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent-2-soft text-accent-2-soft-foreground font-medium"
                      : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span className={cn("flex size-4 shrink-0 items-center justify-center", isActive ? "text-accent-2" : paletteToneTextClass(tone))}>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {tab.id === "about" && hasEnvironmentIssues && (
                    <span className="w-2 h-2 rounded-full bg-danger" />
                  )}
                </button>
              );
            })}
          </nav>
          <div className="flex-shrink-0 p-3">
            <button
              onClick={handleClose}
              className="group flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <ArrowLeft size={16} />
              <span>返回</span>
              <span aria-hidden="true" className="ml-auto inline-flex opacity-0 transition-opacity group-hover:opacity-100">
                <ShortcutKeycaps accelerator="Esc" />
              </span>
            </button>
          </div>
        </div>

        {/* 右侧：页头 + 内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 页头：当前分区的图标（色族同一档）+ 标题 + 一句话说明；底色与底线由 .settings-page-header 按经典 / 现代各画一套 */}
          {activeTabItem && (
            <header className="settings-page-header flex h-16 flex-shrink-0 items-center gap-3 px-[var(--layout-page-gutter)]">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-line-1", paletteToneTextClass(activeTabTone))}>
                {activeTabItem.icon}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold leading-5 text-foreground">{activeTabItem.label}</h1>
                {activeTabItem.description && (
                  <p className="truncate text-[12px] leading-4 text-fg-2">{activeTabItem.description}</p>
                )}
              </div>
            </header>
          )}
          {/* key 绑定 activeTab：切标签时整块重建，入场动画才会重新触发。
              4px 的上移 + 淡入足够让"内容换了"这件事被看见，又不至于让人等动画。 */}
          {getSettingsContentLayout(activeTab) === "self-scroll" ? (
            // 自带滚动容器的页面（教程阅读器）：铺满右侧，不再套 ScrollArea，避免双层滚动
            <div
              key={activeTab}
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-content-area animate-in fade-in slide-in-from-bottom-1 duration-normal [animation-timing-function:var(--ease-out-soft)]"
            >
              {renderTabContent(activeTab)}
            </div>
          ) : (
            <ScrollArea className="min-w-0 flex-1 bg-content-area">
              <div
                key={activeTab}
                className="w-full animate-in fade-in slide-in-from-bottom-1 px-[var(--layout-page-gutter)] py-6 pb-12 duration-normal [animation-timing-function:var(--ease-out-soft)]"
              >
                {renderTabContent(activeTab)}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道配置尚未保存，确定要离开吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>留在当前页</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>放弃并离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
