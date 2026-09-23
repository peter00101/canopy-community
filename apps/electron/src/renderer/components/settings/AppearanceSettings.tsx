/**
 * AppearanceSettings - 外观设置页
 *
 * 特殊风格选择 + 主题模式切换（浅色/深色/跟随系统/特殊风格）。
 * 通过 Jotai atom 管理状态，持久化到 ~/.canopy/settings.json。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  themeStyleAtom,
  interfaceVariantAtom,
  systemIsDarkAtom,
  updateThemeMode,
  updateThemeStyle,
  updateInterfaceVariant,
  applyThemeToDOM,
  applyInterfaceVariantToDOM,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@/lib/platform'
import type { InterfaceVariant, ThemeMode, ThemeStyle, MarkdownFontSize } from '../../../types'

// ===== Logo 资源导入（用于图标选择器） =====
import appBlackLogo from '@/assets/bots/canopy-logos/canopy-black.png'
import appWhiteLogo from '@/assets/bots/canopy-logos/canopy-white.png'
import appBlueLogo from '@/assets/bots/canopy-logos/canopy-blue.png'
import appPurpleLogo from '@/assets/bots/canopy-logos/canopy-purple.png'
import appGradientLogo from '@/assets/bots/canopy-logos/canopy-gradient.png'
import appCoralLogo from '@/assets/bots/canopy-logos/canopy-coral.png'
import appVeriPeriLogo from '@/assets/bots/canopy-logos/canopy-veri-peri.png'
import appVivaMagentaLogo from '@/assets/bots/canopy-logos/canopy-viva-magenta.png'
import appMochaMousseLogo from '@/assets/bots/canopy-logos/canopy-mocha-mousse.png'
import appEmeraldLogo from '@/assets/bots/canopy-logos/canopy-emerald.png'
import app8bitLogo from '@/assets/bots/canopy-logos/canopy-8bit.png'
import appCyberpunkLogo from '@/assets/bots/canopy-logos/canopy-cyberpunk.png'
import appFuturisticLogo from '@/assets/bots/canopy-logos/canopy-futuristic.png'

// ===== 主题预览图片导入 =====
import themeCloudDancer from '@/assets/theme-previews/theme-cloud-dancer.webp'
import themeOceanLight from '@/assets/theme-previews/theme-ocean-light.webp'
import themeForestMorning from '@/assets/theme-previews/theme-forest-morning.webp'
import themeOceanDark from '@/assets/theme-previews/theme-ocean-dark.webp'
import themeForestNight from '@/assets/theme-previews/theme-forest-night.webp'
import themeMorandiNight from '@/assets/theme-previews/theme-morandi-night.webp'
import themeTerminalDark from '@/assets/theme-previews/theme-terminal-dark.png'
import themeLatteLight from '@/assets/theme-previews/theme-latte-light.svg'
import themeLavenderLight from '@/assets/theme-previews/theme-lavender-light.svg'
import themeInkDark from '@/assets/theme-previews/theme-ink-dark.svg'
import themeSpruceLight from '@/assets/theme-previews/theme-spruce-light.svg'
import themeSpruceDark from '@/assets/theme-previews/theme-spruce-dark.svg'

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
  { value: 'special', label: 'Canopy 配色' },
]

/** 界面风格选项 */
const INTERFACE_VARIANT_OPTIONS: { value: InterfaceVariant; label: string }[] = [
  { value: 'classic', label: '经典' },
  { value: 'modern', label: '现代' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 特殊风格 ID（排除 default） */
type SpecialStyleId = Exclude<ThemeStyle, 'default'>

/** 特殊风格定义 */
interface SpecialStyle {
  id: SpecialStyleId
  name: string
  variant: 'light' | 'dark'
  /** 主题预览图 */
  image: string
  /** 图片裁剪位置（默认居中） */
  objectPosition?: string
  /** 图片缩放比例（默认 1） */
  imageScale?: number
  /** Tooltip 提示 */
  tooltip?: string
}

const SPECIAL_STYLES: readonly SpecialStyle[] = [
  {
    id: 'spruce-light',
    name: '青杉映雪',
    variant: 'light',
    image: themeSpruceLight,
    tooltip: '近白纸面，浅色主题里对比最清晰',
  },
  {
    id: 'slate-light',
    name: '云絮柔灰',
    variant: 'light',
    image: themeCloudDancer,
    imageScale: 1.3,
  },
  {
    id: 'ocean-light',
    name: '海雾初晴',
    variant: 'light',
    image: themeOceanLight,
  },
  {
    id: 'forest-light',
    name: '林间晓色',
    variant: 'light',
    image: themeForestMorning,
    imageScale: 1.45,
  },
  {
    id: 'latte-light',
    name: '拿铁暖阳',
    variant: 'light',
    image: themeLatteLight,
  },
  {
    id: 'lavender-light',
    name: '薰衣草雾',
    variant: 'light',
    image: themeLavenderLight,
  },
  {
    id: 'spruce-dark',
    name: '青杉沉夜',
    variant: 'dark',
    image: themeSpruceDark,
    tooltip: '留住青色相的深炭，不追纯黑，暗色下层次仍在',
  },
  {
    id: 'ocean-dark',
    name: '远洋夜航',
    variant: 'dark',
    image: themeOceanDark,
  },
  {
    id: 'forest-dark',
    name: '松涛入夜',
    variant: 'dark',
    image: themeForestNight,
  },
  {
    id: 'slate-dark',
    name: '陶土暮色',
    variant: 'dark',
    image: themeMorandiNight,
    imageScale: 1.15,
    objectPosition: '44% 58%',
  },
  {
    id: 'terminal-dark',
    name: '荧屏余晖',
    variant: 'dark',
    image: themeTerminalDark,
    tooltip: '该主题包含轻微闪烁动画',
  },
  {
    id: 'ink-dark',
    name: '墨色极夜',
    variant: 'dark',
    image: themeInkDark,
    tooltip: 'OLED 近纯黑，夜间长阅读最省眼',
  },
]

/** 图标变体定义 */
interface IconVariant {
  id: string
  name: string
  src: string
  previewBg: string
}

const ICON_VARIANTS: readonly IconVariant[] = [
  { id: 'default', name: '默认', src: '', previewBg: 'bg-neutral-900' },
  { id: 'black', name: '经典黑', src: appBlackLogo, previewBg: 'bg-neutral-900' },
  { id: 'white', name: '纯白版', src: appWhiteLogo, previewBg: 'bg-white' },
  { id: 'blue', name: '品牌蓝', src: appBlueLogo, previewBg: 'bg-info-soft' },
  { id: 'purple', name: '紫色版', src: appPurpleLogo, previewBg: 'bg-accent-2-soft' },
  { id: 'gradient', name: '渐变版', src: appGradientLogo, previewBg: 'bg-gradient-to-br from-info to-accent-2' },
  { id: 'coral', name: '珊瑚橘', src: appCoralLogo, previewBg: 'bg-[#FF6F61]' },
  { id: 'veri-peri', name: '长春花蓝', src: appVeriPeriLogo, previewBg: 'bg-[#6667AB]' },
  { id: 'viva-magenta', name: '非凡洋红', src: appVivaMagentaLogo, previewBg: 'bg-[#BB2649]' },
  { id: 'mocha-mousse', name: '摩卡慕斯', src: appMochaMousseLogo, previewBg: 'bg-[#A47764]' },
  { id: 'emerald', name: '翡翠绿', src: appEmeraldLogo, previewBg: 'bg-[#009473]' },
  { id: '8bit', name: '8bit 像素', src: app8bitLogo, previewBg: 'bg-[#1a1a2e]' },
  { id: 'cyberpunk', name: '赛博朋克', src: appCyberpunkLogo, previewBg: 'bg-[#0d0221]' },
  { id: 'futuristic', name: '未来质感', src: appFuturisticLogo, previewBg: 'bg-[#4a4a4a]' },
] as const

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [themeStyle, setThemeStyle] = useAtom(themeStyleAtom)
  const [interfaceVariant, setInterfaceVariant] = useAtom(interfaceVariantAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)

  /** 切换主题模式 */
  const handleThemeChange = React.useCallback((value: string) => {
    const mode = value as ThemeMode
    setThemeMode(mode)
    updateThemeMode(mode)
    // 切换回普通模式时，重置特殊风格
    if (mode !== 'special') {
      setThemeStyle('default')
      updateThemeStyle('default')
      applyThemeToDOM(mode, 'default', systemIsDark)
    }
  }, [setThemeMode, setThemeStyle, systemIsDark])

  /** 选择特殊风格 */
  const handleStyleSelect = React.useCallback((style: ThemeStyle) => {
    // 同时切换到特殊风格模式
    setThemeMode('special')
    setThemeStyle(style)
    updateThemeMode('special')
    updateThemeStyle(style)
    applyThemeToDOM('special', style, systemIsDark)
  }, [setThemeMode, setThemeStyle, systemIsDark])

  /** 切换界面风格 */
  const handleInterfaceVariantChange = React.useCallback((value: string) => {
    const variant = value as InterfaceVariant
    setInterfaceVariant(variant)
    updateInterfaceVariant(variant)
    applyInterfaceVariantToDOM(variant)
  }, [setInterfaceVariant])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={handleThemeChange}
            options={THEME_OPTIONS}
          />

          <SettingsSegmentedControl
            label="界面风格"
            description="经典风保留旧版视觉；现代风使用更小圆角、更清晰分割线达成更统一干净的质感"
            value={interfaceVariant}
            onValueChange={handleInterfaceVariantChange}
            options={INTERFACE_VARIANT_OPTIONS}
          />

          {/* 特殊风格 - 标签在上，卡片在下 */}
          <div className="px-4 py-3 space-y-2">
            <div className="text-sm font-medium text-foreground">Canopy 配色</div>
            <div className="grid grid-cols-7 gap-3">
              {SPECIAL_STYLES.map((style) => (
                <StyleCard
                  key={style.id}
                  style={style}
                  isSelected={themeMode === 'special' && themeStyle === style.id}
                  onSelect={() => handleStyleSelect(style.id)}
                />
              ))}
            </div>
          </div>

          <SettingsRow
            label="界面缩放"
            description={ZOOM_HINT}
          />

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
          />

        </SettingsCard>
      </SettingsSection>

      <AppIconPicker />
    </div>
  )
}

/** 应用图标选择器 */
function AppIconPicker(): React.ReactElement {
  const [activeIcon, setActiveIcon] = React.useState<string>('default')
  const [isLoading, setIsLoading] = React.useState(false)

  // 初始化时读取当前设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setActiveIcon(settings.appIconVariant ?? 'default')
    })
  }, [])

  const isWindows = React.useMemo(() => detectIsWindows(), [])

  const handleIconSelect = React.useCallback(async (variantId: string) => {
    if (isWindows) {
      toast.error('Windows 系统暂不支持更换应用图标')
      return
    }
    if (variantId === activeIcon || isLoading) return
    setIsLoading(true)
    try {
      const success = await window.electronAPI.setAppIcon(variantId)
      if (success) {
        setActiveIcon(variantId)
        toast.success('应用图标已更换')
      } else {
        toast.error('图标切换失败')
      }
    } catch {
      toast.error('图标切换失败')
    } finally {
      setIsLoading(false)
    }
  }, [activeIcon, isLoading, isWindows])

  return (
    <SettingsSection
      title="应用图标"
      description={isWindows
        ? 'Windows 暂不支持更换应用图标（任务栏图标由安装包固定）'
        : '自定义 Dock 栏中的应用图标样式。仅在应用运行期间生效——退出后程序坞、访达与启动台显示的仍是安装包内置图标，这是 macOS 的限制（自定义图标写入应用包会破坏代码签名）'}
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-3">
          <div className={cn('grid grid-cols-7 gap-3', isWindows && 'pointer-events-none opacity-45 saturate-50')} aria-disabled={isWindows || undefined}>
            {ICON_VARIANTS.map((variant) => (
              <IconCard
                key={variant.id}
                variant={variant}
                isSelected={activeIcon === variant.id}
                disabled={isWindows}
                onSelect={() => handleIconSelect(variant.id)}
              />
            ))}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 图标选项卡片 */
function IconCard({
  variant,
  isSelected,
  disabled = false,
  onSelect,
}: {
  variant: IconVariant
  isSelected: boolean
  disabled?: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all',
        isSelected
          ? 'ring-2 ring-primary bg-primary/5'
          : 'hover:bg-muted/50'
      )}
    >
      <div
        className={cn(
          'w-12 h-12 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          variant.previewBg,
        )}
      >
        {variant.id === 'default' ? (
          // 默认图标用内联 SVG 绘制 Canopy C 树冠标志
          <svg viewBox="0 0 64 64" className="h-8 w-8" fill="none" aria-hidden="true">
            <path d="M44 16 A20 20 0 1 0 44 48" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
            <path d="M36 28 Q42 20 50 22" stroke="#fff" strokeWidth="2.75" strokeLinecap="round" />
            <path d="M36 28 Q38 34 36 40" stroke="#fff" strokeWidth="2.75" strokeLinecap="round" />
          </svg>
        ) : (
          <img
            src={variant.src}
            alt={variant.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        )}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground leading-tight text-center">
        {variant.name}
      </span>
      {isSelected && (
        <div className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="size-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}

/** 特殊风格卡片 - 竖长条图片预览 + 名字放在卡片下方 */
function StyleCard({
  style,
  isSelected,
  onSelect,
}: {
  style: SpecialStyle
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={style.tooltip}
      className="group flex flex-col items-center gap-2 focus-visible:outline-none"
    >
      {/* 图片卡片本体 */}
      <div
        className={cn(
          'relative rounded-lg overflow-hidden w-[99px] h-[183px] transition-all duration-150',
          isSelected
            ? 'ring-2 ring-primary shadow-lg shadow-primary/20'
            : 'ring-1 ring-border/50 group-hover:ring-border group-focus-visible:ring-2 group-focus-visible:ring-primary group-focus-visible:ring-offset-1'
        )}
      >
        <div
          className="w-full h-full"
          style={style.imageScale ? { transform: `scale(${style.imageScale})` } : undefined}
        >
          <img
            src={style.image}
            alt={style.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            style={style.objectPosition ? { objectPosition: style.objectPosition } : undefined}
            draggable={false}
          />
        </div>
        {isSelected && (
          <div className="absolute top-1 right-1 size-4 rounded-full bg-primary flex items-center justify-center z-10">
            <Check className="size-2.5 text-primary-foreground" />
          </div>
        )}
      </div>
      {/* 名字放在卡片下方，吃 token，自动跟主题切色 */}
      <span
        className={cn(
          'text-xs font-medium transition-colors',
          isSelected ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
        )}
      >
        {style.name}
      </span>
    </button>
  )
}
