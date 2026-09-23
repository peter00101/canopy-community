/**
 * Onboarding 视图组件
 *
 * 首次启动时显示的全屏引导界面。视觉层使用自绘界面示意图
 * （见 guide-sketches.tsx），不依赖任何真实截图资产。
 *
 * 流程：
 *  Step 1：欢迎（品牌视觉 → 进入引导）
 *  Step 2：Agent vs Chat 科普（附 Chat / Agent 真实示例）
 *  Step 3：项目概念
 *  Step 4：会话文件/项目文件区别（附文件写入示例）
 *  Step 5：子会话科普（附启动/深入/汇总示例）
 *  Step 6：自动任务科普（附安排/执行/日程示例）
 *  Step 7：记忆功能科普（附生成/编辑示例）
 *  Step 8：侧边回答科普
 *  Step 9：FAQ 汇总页（按主题分组）
 *
 * 右上角常驻退出按钮（Esc 同效）：首次/升级文案「跳过」= 算完成；从设置重放文案「退出引导」= 不写完成状态。
 * 去哪、写不写设置见 onboarding-flow.ts。
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronLeft, ChevronsRight, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import appMarkWhite from '@/assets/onboarding/canopy-mark-white.svg'
import { AutomationGuideExamples } from './AutomationGuideExamples'
import { FileGuideExamples } from './FileGuideExamples'
import { MemoryGuideExamples } from './MemoryGuideExamples'
import { SubagentGuideExamples } from './SubagentGuideExamples'
import { FAQ_GROUPS } from './faq-content'
import { CANOPY_BRAND } from '@canopy/brand'
import {
  SketchAgentRun,
  SketchAutomationForm,
  SketchChatQA,
  SketchFilesTabs,
  SketchMemoryGenerate,
  SketchModeSwitch,
  SketchProjects,
  SketchSideAnswer,
  SketchSubagentSpawn,
} from './guide-sketches'
import {
  buildOnboardingCompletionSettings,
  getOnboardingDismissLabel,
  resolveOnboardingExit,
  shouldDismissOnboardingOnKeydown,
  type OnboardingEntry,
  type OnboardingExitTrigger,
} from './onboarding-flow'

type OnboardingStep = 'welcome' | 'guide' | 'files' | 'project' | 'automation' | 'memory' | 'sideanswer' | 'subagent' | 'faq'

interface OnboardingViewProps {
  /** 离开引导（已按入口处理完设置写入）后回调，落点由调用方按入口决定。 */
  onComplete: () => void
  /** 从设置重放时可跳过欢迎页。 */
  initialStep?: OnboardingStep
  /** 引导入口：决定右上角按钮文案，以及跳过/退出时是否写完成状态。 */
  entry?: OnboardingEntry
}

/** 页面上是否有打开的弹窗 / 菜单 / 下拉列表：有则 Esc 留给它们自己关闭。 */
function hasOpenOverlayInDocument(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
}

interface GuideFeatureStepProps {
  /** 左侧展示的界面示意图 */
  visual: React.ReactNode
  title: string
  highlight?: React.ReactNode
  paragraphs: React.ReactNode[]
  nextLabel: string
  onNext: () => void
  onBack?: () => void
  /** 是否在本讲解区显示上一页/下一页导航 */
  showNavigation?: boolean
  /** 无导航时在正文下方显示的向下滚动提示；点击可滚到示例区 */
  onScrollHint?: () => void
}

/** 章节标记：标题上方，左侧为线条与圆点，右侧为章节文字。 */
function ChapterMarker({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 flex w-full max-w-lg self-start items-center justify-end gap-4 text-sm font-medium tracking-[0.08em] text-[#6D28D9]">
      <span className="relative h-px flex-1 bg-[#6D28D9]/25">
        <span className="absolute left-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-[#6D28D9]" />
      </span>
      <span className="shrink-0 whitespace-nowrap">{children}</span>
    </div>
  )
}

function GuideNavigation({ nextLabel, onNext, onBack }: { nextLabel: string; onNext: () => void; onBack?: () => void }) {
  return (
    <div className="flex w-full items-center justify-between border-t border-[#6D28D9]/20 pt-6">
      {onBack ? (
        <Button variant="ghost" size="sm" onClick={onBack} className="text-neutral-500">
          <ChevronLeft className="mr-1 h-4 w-4" />
          上一个
        </Button>
      ) : (
        <span />
      )}
      <button
        onClick={onNext}
        className="flex h-14 items-center justify-center gap-1.5 rounded-md bg-[#6D28D9] px-9 text-base font-medium text-white shadow-[0_8px_18px_rgba(109,40,217,0.14)] transition-all hover:bg-[#7C3AED] active:translate-y-0.5 active:shadow-none"
      >
        {nextLabel}
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

/**
 * 引导科普页：左侧显示界面示意图，右侧为讲解区。
 */
function GuideFeatureStep({ visual, title, highlight, paragraphs, nextLabel, onNext, onBack, showNavigation = true, onScrollHint }: GuideFeatureStepProps) {
  return (
    <div className="flex h-full w-full items-stretch">
      {/* 左侧：界面示意图 */}
      <div className="relative flex h-full w-[calc(58%+80px)] shrink-0 items-center justify-center overflow-visible p-6">
        {/* 四角定位标记，仅作为视觉边界。 */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-6 top-[10%] bottom-[10%] z-0">
          <span className="absolute left-0 top-0 h-7 w-7 border-l-2 border-t-2 border-[#6D28D9]/70" />
          <span className="absolute right-0 top-0 h-7 w-7 border-r-2 border-t-2 border-[#6D28D9]/70" />
          <span className="absolute bottom-0 left-0 h-7 w-7 border-b-2 border-l-2 border-[#6D28D9]/70" />
          <span className="absolute bottom-0 right-0 h-7 w-7 border-b-2 border-r-2 border-[#6D28D9]/70" />
        </div>
        <div className="relative z-10 flex w-full items-center justify-center px-6">{visual}</div>
      </div>

      {/* 右侧：科普讲解，保持章节标记、标题、正文和操作区的阅读节奏。 */}
      <div
        className="relative flex flex-1 flex-col items-center justify-start px-8 pt-20 md:px-12 md:pt-24"
        style={{ transform: 'translateY(clamp(0px, calc(133.333vh - 1000px), 200px))' }}
      >
        {highlight && <ChapterMarker>{highlight}</ChapterMarker>}
        <h2 className="w-full max-w-lg text-left text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">{title}</h2>
        <div className="mt-9 w-full max-w-lg space-y-5">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-base leading-[1.65] text-neutral-600 md:text-lg">
              {p}
            </p>
          ))}
        </div>

        {showNavigation && (
          <div className="mt-12 w-full max-w-lg">
            <GuideNavigation nextLabel={nextLabel} onNext={onNext} onBack={onBack} />
          </div>
        )}

        {/* 无导航的首屏：用一行文字承接阅读动线，说明下方还有内容。 */}
        {!showNavigation && onScrollHint && (
          <div className="mt-12 w-full max-w-lg border-t border-[#6D28D9]/20 pt-5">
            <button
              type="button"
              onClick={onScrollHint}
              className="text-left text-sm leading-6 text-neutral-500 transition-colors hover:text-[#6D28D9]"
            >
              继续向下滚动，查看这一步的真实示例
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

type GuideExamplesIntroProps = Omit<GuideFeatureStepProps, 'nextLabel' | 'onNext' | 'onBack' | 'showNavigation' | 'onScrollHint'>

function GuideExamplesPage({ intro, nextLabel, onNext, onBack, children, showScrollHint = false }: {
  intro: GuideExamplesIntroProps
  nextLabel: string
  onNext: () => void
  onBack: () => void
  children: React.ReactNode
  /** 首个讲解页在正文下方提示继续向下滚动，避免底部进度地图被误解为横向翻页。 */
  showScrollHint?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  /** 点击提示推进约一屏，避免与首屏高度、示例区负 margin 耦合。 */
  const handleScrollHint = () => {
    const container = scrollRef.current
    if (!container) return
    container.scrollBy({ top: container.clientHeight * 0.82, behavior: 'smooth' })
  }

  return (
    <div className="relative h-full w-full">
      <div ref={scrollRef} className="h-full w-full overflow-y-auto">
        <div className="h-[1100px] lg:h-[calc(100vh-4rem)] lg:min-h-[660px]">
          <GuideFeatureStep
            {...intro}
            nextLabel={nextLabel}
            onNext={onNext}
            onBack={onBack}
            showNavigation={false}
            onScrollHint={showScrollHint ? handleScrollHint : undefined}
          />
        </div>

        <div className="mx-auto w-full max-w-[calc(58vw+504px)] px-6 pb-28 pt-6 md:px-10">
          {children}
          <GuideNavigation nextLabel={nextLabel} onNext={onNext} onBack={onBack} />
        </div>
      </div>
    </div>
  )
}

/** Agent / Chat 首章：保留模式说明，并在同页继续展示真实工作流。 */
function AgentChatGuidePage({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <GuideExamplesPage
      showScrollHint
      intro={{
        visual: <SketchModeSwitch />,
        highlight: '入门篇 · 第 1 步',
        title: 'Agent 和 Chat 模式的区别',
        paragraphs: [
          <>左边栏顶部是 {CANOPY_BRAND.productName} 的<b className="font-medium text-neutral-900">模式切换</b>：Agent 与 Chat。</>,
          <>
            <b className="font-medium text-neutral-900">Chat</b> 是一问一答的对话——快速提问、不涉及任何对电脑的操作，
            核心偏向满足好奇心和完成简单的文字工作。
          </>,
          <>
            <b className="font-medium text-neutral-900">Agent</b> 则能自主规划做调研、操作电脑、写代码、PPT 和文档，
            为你的想法赋形。
          </>,
        ],
      }}
      nextLabel="下一个"
      onNext={onNext}
      onBack={onBack}
    >
      <section className="pb-16 pt-6 md:pb-20 md:pt-10">
        <div className="space-y-16 md:space-y-20">
          <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
            <SketchChatQA />
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-[#6D28D9]">示例 01 · Chat</div>
              <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">快速厘清一个概念用 Chat</h3>
              <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
                AI 最常见的场景，随意询问一件事，得到简单快速的解释。Chat 专注对话和文字回答，不会有任何产出。
              </p>
              <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
                <div className="text-base font-medium leading-7 text-[#6D28D9]">你可以这样说</div>
                <p className="mt-1 text-base leading-7 text-neutral-500">“用通俗的话帮我解释一下 RAG 的搜索原理。”</p>
              </div>
            </div>
          </article>

          <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-center">
            <div className="lg:order-1">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-[#6D28D9]">示例 02 · Agent</div>
              <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">
                复杂<b className="font-medium text-neutral-900">调研/写代码/做PPT</b>等需要产出成果时用 Agent
              </h3>
              <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
                例如，请它研究一个概念或者行业并将结论做成 PPT/文档。Agent 会拆解任务、调用工具、持续推进，再把成果保留在当前工作区。
              </p>
              <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
                <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
                <p className="mt-1 text-base leading-7 text-neutral-500">“帮我研究一下什么是 RAG，然后把研究结果写成一个文件/PPT放到会话文件里。”</p>
              </div>
            </div>
            <div className="lg:order-2">
              <SketchAgentRun />
            </div>
          </article>
        </div>
      </section>
    </GuideExamplesPage>
  )
}

/**
 * FAQ 页面：左侧可点击目录地图 + 右侧按主题展开全部问题。
 */
function FaqPage({ nextLabel, onNext, onBack, highlight }: { nextLabel: string; onNext: () => void; onBack?: () => void; highlight?: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToGroup = (topic: string) => {
    const el = document.getElementById(`faq-${topic}`)
    if (!el || !scrollRef.current) return
    const container = scrollRef.current
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
    container.scrollTo({ top, behavior: 'smooth' })
  }

  return (
    <div className="flex h-full w-full items-stretch">
      {/* 左侧：本页目录地图（垂直居中，整体上移 20px） */}
      <div className="hidden w-56 shrink-0 border-r border-neutral-200/80 px-4 py-4 md:flex md:flex-col md:justify-center -translate-y-5">
        <div className="text-center text-[11px] uppercase tracking-[0.2em] text-neutral-400">本页目录</div>
        <nav className="mt-4 space-y-1">
          {FAQ_GROUPS.map((group) => (
            <button
              key={group.topic}
              onClick={() => scrollToGroup(group.topic)}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-neutral-600 transition-colors hover:bg-[#6D28D9]/5 hover:text-[#6D28D9]"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#6D28D9]/40" />
              {group.topic}
            </button>
          ))}
        </nav>
      </div>

      {/* 右侧：FAQ 内容（flex-col + m-auto 实现居中，超高时可正常滚动不裁剪） */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-32 md:px-10">
        {/* 顶部留白与其他步骤页一致（pt-20），让章节标记落在右上角「步骤编号 + 退出引导」工具条下方；
            py-10 时窄窗口（约 800～1010px）里二者会叠在一起。 */}
        <div className="m-auto w-full max-w-4xl pb-10 pt-20">
          {highlight && <ChapterMarker>{highlight}</ChapterMarker>}
          <div className="flex items-baseline gap-3">
            <h2 className="text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">常见问题</h2>
            <span className="text-2xl font-light tracking-[0.3em] text-[#6D28D9]/60 md:text-3xl">FAQ</span>
          </div>
          <p className="mt-3 text-base leading-relaxed text-neutral-500">
            常见问题已经全部展开，方便你快速浏览和搜索。点击左侧目录可跳转到对应主题。
          </p>

          <div className="mt-10 space-y-10">
            {FAQ_GROUPS.map((group, groupIndex) => (
              <section key={group.topic} aria-labelledby={`faq-${group.topic}`}>
                <div className="flex items-end gap-3 border-b border-neutral-300 pb-3">
                  <span className="text-xs font-medium tracking-[0.16em] text-[#6D28D9]">
                    {String(groupIndex + 1).padStart(2, '0')}
                  </span>
                  <h3 id={`faq-${group.topic}`} className="text-lg font-medium text-neutral-900">
                    {group.topic}
                  </h3>
                </div>

                <div className="divide-y divide-neutral-200/80">
                  {group.items.map((item) => (
                    <article key={item.q} className="border-l-2 border-[#6D28D9]/25 py-4 pl-4">
                      <h4 className="text-sm font-semibold tracking-wide text-[#6D28D9]">{item.q}</h4>
                      <p className="mt-2 max-w-3xl text-[15px] leading-7 text-neutral-600">{item.a}</p>
                    </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12 flex w-full items-center justify-between border-t border-[#6D28D9]/20 pt-6">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="text-neutral-500">
              <ChevronLeft className="mr-1 h-4 w-4" />
              上一个
            </Button>
          ) : (
            <span />
          )}
          <button
            onClick={onNext}
            className="flex h-14 items-center justify-center gap-1.5 rounded-md bg-[#6D28D9] px-9 text-base font-medium text-white shadow-[0_8px_18px_rgba(109,40,217,0.14)] transition-all hover:bg-[#7C3AED] active:translate-y-0.5 active:shadow-none"
          >
            {nextLabel}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        </div>
      </div>
    </div>
  )
}

/** 引导步骤标题（欢迎页独立，不在地图中显示） */
const STEP_LABELS: Array<{ step: Exclude<OnboardingStep, 'welcome'>; label: string }> = [
  { step: 'guide', label: 'Agent / Chat' },
  { step: 'project', label: '项目' },
  { step: 'files', label: '文件' },
  { step: 'subagent', label: '子会话' },
  { step: 'automation', label: '自动任务' },
  { step: 'memory', label: '记忆' },
  { step: 'sideanswer', label: '侧边回答' },
  { step: 'faq', label: 'FAQ' },
]

const BEGINNER_STEP_LABELS = STEP_LABELS.slice(0, 3)
const ADVANCED_STEP_LABELS = STEP_LABELS.slice(3)

/**
 * 底部进度地图：仅显示当前章节的步骤，并保持章节内的宽松间距。
 */
function ProgressMap({ current }: { current: Exclude<OnboardingStep, 'welcome'> }) {
  const isBeginner = BEGINNER_STEP_LABELS.some((step) => step.step === current)
  const visibleSteps = isBeginner ? BEGINNER_STEP_LABELS : ADVANCED_STEP_LABELS
  const activeIdx = visibleSteps.findIndex((step) => step.step === current)

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-start justify-center bg-[#fbf9f7]/90 px-8 pb-5 pt-2 md:px-12">
      <div className={`w-full ${isBeginner ? 'max-w-3xl' : 'max-w-5xl'}`}>
        <div className="flex items-start">
          {visibleSteps.map((item, index) => {
            const done = index < activeIdx
            const isCurrent = index === activeIdx
            return (
              <div key={item.step} className="flex flex-1 flex-col items-center">
                <span
                  className={`text-[11px] leading-tight tracking-[0.04em] md:text-sm ${
                    isCurrent
                      ? 'font-medium text-[#6D28D9]'
                      : done
                        ? 'text-neutral-500'
                        : 'text-neutral-400'
                  }`}
                >
                  {item.label}
                </span>
                <div className="mt-1.5 flex h-3 w-full items-center">
                  <div
                    className={`h-px flex-1 ${
                      index === 0
                        ? 'bg-transparent'
                        : done || isCurrent
                          ? 'bg-[#6D28D9]/50'
                          : 'bg-neutral-200'
                    }`}
                  />
                  <div
                    className={`mx-1.5 h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-300 ${
                      isCurrent
                        ? 'bg-[#6D28D9] ring-4 ring-[#6D28D9]/15'
                        : done
                          ? 'bg-[#6D28D9]/70'
                          : 'bg-neutral-300'
                    }`}
                  />
                  <div
                    className={`h-px flex-1 ${
                      index === visibleSteps.length - 1
                        ? 'bg-transparent'
                        : index < activeIdx
                          ? 'bg-[#6D28D9]/50'
                          : 'bg-neutral-200'
                    }`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function OnboardingView({ onComplete, initialStep = 'welcome', entry = 'first-run' }: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const [flash, setFlash] = useState(false)
  const [fading, setFading] = useState(false)
  const [faqBackStep, setFaqBackStep] = useState<'subagent' | 'sideanswer'>('sideanswer')
  const [exiting, setExiting] = useState(false)
  /** 离开流程只允许走一次：连点「开始使用」/ 跳过 / Esc 不会重复写设置、重复建欢迎对话。 */
  const exitingRef = useRef(false)
  const dismissLabel = getOnboardingDismissLabel(entry)

  const leaveOnboarding = async (trigger: OnboardingExitTrigger) => {
    if (exitingRef.current) return
    exitingRef.current = true
    setExiting(true)
    try {
      if (resolveOnboardingExit(entry, trigger).persistCompletion) {
        await window.electronAPI.updateSettings(buildOnboardingCompletionSettings())
      }
    } catch (error) {
      // 写设置失败时留在引导里可重试，不能让按钮永久失效
      console.error('[Onboarding] 写入完成状态失败:', error)
      exitingRef.current = false
      setExiting(false)
      return
    }
    onComplete()
  }
  const handleFinish = () => leaveOnboarding('finish')
  const handleDismiss = () => leaveOnboarding('dismiss')

  // Esc = 右上角跳过/退出。本组件只在引导显示时挂载，卸载即解绑；输入框、输入法组合、打开的弹窗内的 Esc 不接管。
  const dismissRef = useRef(handleDismiss)
  dismissRef.current = handleDismiss
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const shouldDismiss = shouldDismissOnboardingOnKeydown({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        repeat: event.repeat,
        targetTagName: target?.tagName ?? null,
        targetIsContentEditable: target?.isContentEditable ?? false,
        hasOpenOverlay: hasOpenOverlayInDocument(),
      })
      if (!shouldDismiss) return
      event.preventDefault()
      void dismissRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  /**
   * 页面切换：
   * - welcome 进出（品牌面板显隐）用白色闪屏遮挡
   * - guide 之后的科普页之间用淡入淡出
   */
  const transitionTo = (next: OnboardingStep) => {
    const useFlash = step === 'welcome' || next === 'welcome'
    setFading(true)
    if (useFlash) setFlash(true)
    setTimeout(() => {
      setStep(next)
      requestAnimationFrame(() => {
        setFading(false)
        setFlash(false)
      })
    }, 250)
  }

  const handleEnterGuide = () => transitionTo('guide')
  const handleNextFromGuide = () => transitionTo('project')
  const handleNextFromProject = () => transitionTo('files')
  const handleNextFromFiles = () => transitionTo('subagent')
  const handleNextFromAutomation = () => transitionTo('memory')
  const handleNextFromMemory = () => transitionTo('sideanswer')
  const handleNextFromSideAnswer = () => {
    setFaqBackStep('sideanswer')
    transitionTo('faq')
  }
  const handleNextFromSubagent = () => transitionTo('automation')
  const handleJumpToFaq = () => {
    setFaqBackStep('subagent')
    transitionTo('faq')
  }
  const handleNextFromFaq = () => handleFinish()

  const currentMapIndex = STEP_LABELS.findIndex((item) => item.step === step)
  const stepIndex = currentMapIndex + 1
  const totalSteps = STEP_LABELS.length

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#fbf9f7] md:flex-row">

      {/* ===== 左侧：品牌面板（仅欢迎页显示，引导页清屏） ===== */}
      {step === 'welcome' && (
        <div className="relative h-56 shrink-0 overflow-hidden md:h-auto md:w-[calc(58%+100px)]">
          {/* 品牌紫渐变底 + 树冠光斑 */}
          <div className="absolute inset-0 bg-gradient-to-br from-[#C3A8FF] via-[#A07CF2] to-[#7C3AED]" />
          <div className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-[-20%] right-[-10%] h-96 w-96 rounded-full bg-[#C4B5FD]/25 blur-3xl" />
          {/* 大号 C 树冠水印 */}
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="absolute -right-16 top-1/2 h-[130%] w-auto -translate-y-1/2 opacity-[0.16]"
            fill="none"
          >
            <path d="M44 16 A20 20 0 1 0 44 48" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
            <path d="M36 28 Q42 20 50 22" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
            <path d="M36 28 Q38 34 36 40" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
          </svg>

          {/* 左上角品牌 */}
          <div className="absolute left-6 top-6 flex items-center gap-3 md:left-10 md:top-8">
            <img
              src={appMarkWhite}
              alt={CANOPY_BRAND.productName}
              className="h-8 w-8 object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
            />
            <span className="text-lg font-light tracking-wide text-white">{CANOPY_BRAND.productName}</span>
          </div>

          {/* 左下角标语 */}
          <div className="absolute bottom-6 left-6 right-6 md:bottom-10 md:left-10 md:right-10">
            <p className="text-lg font-light leading-snug text-white md:text-2xl">
              让协作自然发生，让想法流动成形。
            </p>
            <p className="mt-2 text-[11px] uppercase tracking-[0.3em] text-white/70 md:text-xs">
              FOR PROFESSIONALS
            </p>
          </div>

        </div>
      )}

      {/* ===== 内容面板（引导页清屏后占满全宽，切换时淡入淡出） ===== */}
      <div
        className={`relative flex flex-1 items-center justify-center overflow-y-auto transition-opacity duration-300 ${
          fading ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {step === 'welcome' && (
          <div className="w-full max-w-xl px-6 py-10 md:px-10">
            {/* 状态徽章 */}
            <div className="mb-6 flex items-center gap-2.5">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#6D28D9] text-white">
                <Check size={13} strokeWidth={3} />
              </span>
              <span className="text-sm font-medium text-neutral-500">准备就绪</span>
            </div>

            <h1 className="text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">
              欢迎使用 {CANOPY_BRAND.productName}
            </h1>
            <p className="mt-3 text-base leading-relaxed text-neutral-500 md:text-lg">
              为专业用户打造的通用 Agent
            </p>

            {/* 主操作 */}
            <div className="mt-8">
              <button
                onClick={handleEnterGuide}
                className="flex h-12 w-full items-center justify-center gap-1.5 rounded-sm bg-[#6D28D9] text-base font-medium text-white transition-all hover:bg-[#7C3AED] active:translate-y-0.5 active:shadow-none"
              >
                进入引导界面
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {step === 'guide' && (
          <AgentChatGuidePage
            onNext={handleNextFromGuide}
            onBack={() => transitionTo('welcome')}
          />
        )}

        {step === 'files' && (
          <GuideExamplesPage
            intro={{
              visual: <SketchFilesTabs />,
              highlight: '入门篇 · 第 3 步',
              title: '会话文件和项目文件',
              paragraphs: [
                <>右侧文件面板顶部有<b className="font-medium text-neutral-900">项目文件</b>和<b className="font-medium text-neutral-900">会话文件</b>两个页签，默认停在项目文件。</>,
                <>
                  <b className="font-medium text-neutral-900">项目文件</b>属于整个项目——所有项目内的会话共享这些文件，
                  是团队/长期项目真正的工作台。
                </>,
                <>
                  <b className="font-medium text-neutral-900">会话文件</b>属于这一次对话——附件、截图、临时引用等。
                </>,
              ],
            }}
            nextLabel="开始进阶篇"
            onNext={handleNextFromFiles}
            onBack={() => transitionTo('project')}
          >
            <section className="border-t border-[#6D28D9]/20 py-16 md:py-20">
              <FileGuideExamples />
            </section>
          </GuideExamplesPage>
        )}

        {step === 'project' && (
          <GuideFeatureStep
            visual={<SketchProjects />}
            highlight="入门篇 · 第 2 步"
            title="项目的概念"
            paragraphs={[
              <>左侧边栏的<b className="font-medium text-neutral-900">项目</b>是你为特定工作建立的独立空间。</>,
              <>
                每个项目有自己的<b className="font-medium text-neutral-900">项目文件</b>、
                <b className="font-medium text-neutral-900">上下文、Skills/MCP 与记忆</b>，互不干扰。
              </>,
              <>
                比如图中的「产品调研」「代码仓库分析」，都各是一个独立的项目工作区，用于做完全不同的事。
              </>,
            ]}
            nextLabel="下一个"
            onNext={handleNextFromProject}
            onBack={() => transitionTo('guide')}
          />
        )}

        {step === 'subagent' && (
          <GuideExamplesPage
            intro={{
              visual: <SketchSubagentSpawn />,
              highlight: '进阶指南 · 第 1 步',
              title: '子会话功能',
              paragraphs: [
                <>
                  子会话（Collaboration）是 Agent 派生的<b className="font-medium text-neutral-900">独立研究小分队</b>——
                  你用一句自然语言就能启动，比如「启动 3 个子会话研究躺平现象」。
                </>,
                <>
                  每个子会话可以用自然语言<b className="font-medium text-neutral-900">指定不同模型</b>（如 GLM、DeepSeek），
                  拥有<b className="font-medium text-neutral-900">独立的上下文</b>，各自专注一个方向并行研究。
                </>,
                <>
                  结果再汇回父会话——
                  <b className="font-medium text-neutral-900">既节省父会话的上下文，又能省时并行干更多的活</b>。
                </>,
              ],
            }}
            nextLabel="下一个"
            onNext={handleNextFromSubagent}
            onBack={() => transitionTo('files')}
          >
            <SubagentGuideExamples />
          </GuideExamplesPage>
        )}

        {step === 'automation' && (
          <GuideExamplesPage
            intro={{
              visual: <SketchAutomationForm />,
              highlight: '进阶指南 · 第 2 步',
              title: '自动任务功能',
              paragraphs: [
                <>
                  打开<b className="font-medium text-neutral-900">自动任务</b>，你可以让 {CANOPY_BRAND.productName} 定时自动执行一件事。
                  在任务描述里用自然语言写清楚「做什么、什么时候做」，再配置频率与模型，
                  <b className="font-medium text-neutral-900">无人值守</b>也能完成。
                  你也可以用自然语言直接让 Agent 帮你创建自动任务。
                </>,
              ],
            }}
            nextLabel="下一个"
            onNext={handleNextFromAutomation}
            onBack={() => transitionTo('subagent')}
          >
            <section className="border-t border-[#6D28D9]/20 py-16 md:py-20">
              <AutomationGuideExamples />
            </section>
          </GuideExamplesPage>
        )}

        {step === 'memory' && (
          <GuideExamplesPage
            intro={{
              visual: <SketchMemoryGenerate />,
              highlight: '进阶指南 · 第 3 步',
              title: '建立项目地图与协作记忆',
              paragraphs: [
                <>
                  <b className="font-medium text-neutral-900">项目地图</b>放在两层 AGENTS.md，减少重复探索；<b className="font-medium text-neutral-900">协作记忆</b>只保留你的稳定偏好与避免重犯的经验。
                </>,
              ],
            }}
            nextLabel="下一个"
            onNext={handleNextFromMemory}
            onBack={() => transitionTo('automation')}
          >
            <section className="border-t border-[#6D28D9]/20 py-16 md:py-20">
              <MemoryGuideExamples />
            </section>
          </GuideExamplesPage>
        )}

        {step === 'sideanswer' && (
          <GuideFeatureStep
            visual={<SketchSideAnswer />}
            highlight="进阶指南 · 第 4 步"
            title="侧边回答"
            paragraphs={[
              <>在 Agent 对话中选中一段文字，浮层里点<b className="font-medium text-neutral-900">「打开右侧问答」</b>。</>,
              <>这会打开<b className="font-medium text-neutral-900">右侧问答面板</b>，
                围绕你选中的内容讲解，不打断主对话也不占用上下文。
              </>,
              <>适合查词、解释概念、拆解长文。
              </>,
            ]}
            nextLabel="下一个"
            onNext={handleNextFromSideAnswer}
            onBack={() => transitionTo('memory')}
          />
        )}

        {step === 'faq' && (
          <FaqPage
            highlight="进阶指南 · 第 5 步"
            nextLabel="开始使用"
            onNext={handleNextFromFaq}
            onBack={() => transitionTo(faqBackStep)}
          />
        )}

      </div>

      {step !== 'welcome' && <ProgressMap current={step} />}

      {step === 'subagent' && (
        <button
          onClick={handleJumpToFaq}
          className="absolute bottom-5 right-[30px] z-30 flex h-8 items-center gap-1 px-2 text-sm text-neutral-500 transition-colors hover:text-[#6D28D9]"
        >
          跳到 FAQ
          <ChevronsRight className="h-4 w-4" />
        </button>
      )}

      {/* ===== 右上角：步骤指示 + 常驻退出按钮 =====
          根容器在 Windows 上已被 App 的 pt-8 推到 32px 自绘标题栏（拖拽区 + 窗口控件）之下，mac 红绿灯在左上；
          仍显式 no-drag，避免将来布局变动后落进拖拽区点不动。引导页固定浅色配色，不跟深色主题。 */}
      <div className="titlebar-no-drag absolute right-6 top-5 z-40 flex items-center gap-4 md:right-8 md:top-6">
        {step !== 'welcome' && (
          <span className="text-xs uppercase tracking-[0.3em] text-neutral-400">
            {String(stepIndex).padStart(2, '0')} / {String(totalSteps).padStart(2, '0')}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => { void handleDismiss() }}
          disabled={exiting}
          title={`${dismissLabel}（Esc）`}
          data-onboarding-exit={entry}
          className="gap-1.5 bg-[#fbf9f7]/90 text-neutral-500 hover:bg-[#6D28D9]/10 hover:text-[#6D28D9]"
        >
          <X />
          {dismissLabel}
          <kbd className="rounded-sm border border-neutral-300 px-1 font-sans text-[10px] leading-4 text-neutral-400">Esc</kbd>
        </Button>
      </div>

      {/* ===== 白色闪屏遮罩 ===== */}
      <div
        className={`pointer-events-none absolute inset-0 z-50 bg-white transition-opacity duration-300 ${
          flash ? 'opacity-100' : 'opacity-0'
        }`}
      />

    </div>
  )
}
