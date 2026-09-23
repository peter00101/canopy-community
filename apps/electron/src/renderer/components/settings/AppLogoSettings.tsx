/**
 * AppLogoSettings - Canopy 品牌 Logo 下载
 *
 * 展示多个 Canopy Logo 颜色变体网格，用户可下载用作机器人头像。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'
import { CANOPY_BRAND } from '@canopy/brand'

// ===== Logo 资源导入 =====

// 基础色系
import appBlackLogo from '@/assets/bots/canopy-logos/canopy-black.png'
import appWhiteLogo from '@/assets/bots/canopy-logos/canopy-white.png'
import appBlueLogo from '@/assets/bots/canopy-logos/canopy-blue.png'
import appPurpleLogo from '@/assets/bots/canopy-logos/canopy-purple.png'
import appGradientLogo from '@/assets/bots/canopy-logos/canopy-gradient.png'
import appTransparentLogo from '@/assets/bots/canopy-logos/canopy-transparent.png'

// 潘通年度色
import appCoralLogo from '@/assets/bots/canopy-logos/canopy-coral.png'
import appVeriPeriLogo from '@/assets/bots/canopy-logos/canopy-veri-peri.png'
import appVivaMagentaLogo from '@/assets/bots/canopy-logos/canopy-viva-magenta.png'
import appMochaMousseLogo from '@/assets/bots/canopy-logos/canopy-mocha-mousse.png'
import appEmeraldLogo from '@/assets/bots/canopy-logos/canopy-emerald.png'

// 科技风格
import app8bitLogo from '@/assets/bots/canopy-logos/canopy-8bit.png'
import appCyberpunkLogo from '@/assets/bots/canopy-logos/canopy-cyberpunk.png'
import appFuturisticLogo from '@/assets/bots/canopy-logos/canopy-futuristic.png'

// ===== 类型 =====

interface LogoVariant {
  id: string
  name: string
  description: string
  src: string
  resourcePath: string
  previewBg: string
}

// ===== Logo 变体定义 =====

const LOGO_VARIANTS: readonly LogoVariant[] = [
  // 基础色系
  {
    id: 'black',
    name: '经典黑',
    description: '黑色背景，适合浅色界面',
    src: appBlackLogo,
    resourcePath: 'canopy-logos/canopy-black.png',
    previewBg: 'bg-neutral-900',
  },
  {
    id: 'white',
    name: '纯白版',
    description: '白色背景，适合深色界面',
    src: appWhiteLogo,
    resourcePath: 'canopy-logos/canopy-white.png',
    previewBg: 'bg-white',
  },
  {
    id: 'blue',
    name: '品牌蓝',
    description: '深蓝背景，适合正式场合',
    src: appBlueLogo,
    resourcePath: 'canopy-logos/canopy-blue.png',
    previewBg: 'bg-info-soft',
  },
  {
    id: 'purple',
    name: '紫色版',
    description: '紫色调，个性风格',
    src: appPurpleLogo,
    resourcePath: 'canopy-logos/canopy-purple.png',
    previewBg: 'bg-accent-2-soft',
  },
  {
    id: 'gradient',
    name: '渐变版',
    description: '蓝紫渐变背景',
    src: appGradientLogo,
    resourcePath: 'canopy-logos/canopy-gradient.png',
    previewBg: 'bg-gradient-to-br from-info to-accent-2',
  },
  {
    id: 'transparent',
    name: '透明底',
    description: '无背景，可叠加任意颜色',
    src: appTransparentLogo,
    resourcePath: 'canopy-logos/canopy-transparent.png',
    previewBg: 'bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]',
  },
  // 潘通年度色
  {
    id: 'coral',
    name: '珊瑚橘',
    description: 'Pantone 2019 Living Coral',
    src: appCoralLogo,
    resourcePath: 'canopy-logos/canopy-coral.png',
    previewBg: 'bg-[#FF6F61]',
  },
  {
    id: 'veri-peri',
    name: '长春花蓝',
    description: 'Pantone 2022 Very Peri',
    src: appVeriPeriLogo,
    resourcePath: 'canopy-logos/canopy-veri-peri.png',
    previewBg: 'bg-[#6667AB]',
  },
  {
    id: 'viva-magenta',
    name: '非凡洋红',
    description: 'Pantone 2023 Viva Magenta',
    src: appVivaMagentaLogo,
    resourcePath: 'canopy-logos/canopy-viva-magenta.png',
    previewBg: 'bg-[#BB2649]',
  },
  {
    id: 'mocha-mousse',
    name: '摩卡慕斯',
    description: 'Pantone 2025 Mocha Mousse',
    src: appMochaMousseLogo,
    resourcePath: 'canopy-logos/canopy-mocha-mousse.png',
    previewBg: 'bg-[#A47764]',
  },
  {
    id: 'emerald',
    name: '翡翠绿',
    description: 'Pantone 2013 Emerald',
    src: appEmeraldLogo,
    resourcePath: 'canopy-logos/canopy-emerald.png',
    previewBg: 'bg-[#009473]',
  },
  // 科技风格
  {
    id: '8bit',
    name: '8bit 像素风',
    description: '复古像素游戏风格',
    src: app8bitLogo,
    resourcePath: 'canopy-logos/canopy-8bit.png',
    previewBg: 'bg-[#1a1a2e]',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    description: '霓虹赛博风格',
    src: appCyberpunkLogo,
    resourcePath: 'canopy-logos/canopy-cyberpunk.png',
    previewBg: 'bg-[#0d0221]',
  },
  {
    id: 'futuristic',
    name: '未来质感',
    description: '金属全息科技风',
    src: appFuturisticLogo,
    resourcePath: 'canopy-logos/canopy-futuristic.png',
    previewBg: 'bg-[#4a4a4a]',
  },
] as const

// ===== 组件 =====

function LogoCard({ logo }: { logo: LogoVariant }): React.ReactElement {
  const handleDownload = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveResourceFileAs(
        logo.resourcePath,
        `canopy-${logo.id}.png`,
      )
      if (saved) {
        toast.success(`${logo.name} 已保存`)
      }
    } catch {
      toast.error('保存失败，请重试')
    }
  }, [logo])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          'w-20 h-20 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          logo.previewBg,
        )}
      >
        <img
          src={logo.src}
          alt={logo.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
      <div className="text-center">
        <div className="text-xs font-medium">{logo.name}</div>
        <div className="text-[10px] text-muted-foreground">{logo.description}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 h-7 text-xs"
        onClick={handleDownload}
      >
        <Download size={12} />
        下载
      </Button>
    </div>
  )
}

export function AppLogoSettings(): React.ReactElement {
  return (
    <>
      <SettingsSection
        title="品牌 Logo"
        description={`下载 ${CANOPY_BRAND.productName} Logo 用作机器人头像，让用户一眼认出你的 AI 助手`}
      >
        <div className="grid grid-cols-3 gap-4">
          {LOGO_VARIANTS.map((logo) => (
            <LogoCard key={logo.id} logo={logo} />
          ))}
        </div>
      </SettingsSection>

      <div className="my-6 border-t border-border/50" />

      <SettingsSection
        title="使用提示"
        description="在机器人平台设置头像时参考"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-1.5 text-sm text-muted-foreground">
            <p>建议使用 PNG 格式，飞书/钉钉头像推荐 200x200 以上。</p>
            <p>透明背景版本适合需要自定义背景色的平台。</p>
            <p>渐变版和科技风格在社交平台头像中辨识度最高。</p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}
