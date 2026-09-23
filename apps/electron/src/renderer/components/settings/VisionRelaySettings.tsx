import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, Eye, Film, ImageOff, Search, ShieldCheck } from 'lucide-react'
import type { VideoRelaySettings as VideoRelaySettingsValue, VisionRelaySettings as VisionRelaySettingsValue } from '@/types/settings'
import { buildVisionAugmentModelKey, KIMI_VIDEO_CAPABLE_MODELS } from '@/types/settings'
import { channelsAtom } from '@/atoms/chat-atoms'
import { ModelSelector, buildModelOptions } from '@/components/chat/ModelSelector'
import { getChannelLogo, getModelLogo } from '@/lib/model-logo'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { ModelOption } from '@canopy/shared'
import { CANOPY_BRAND } from '@canopy/brand'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

const DEFAULT_SETTINGS: VisionRelaySettingsValue = { enabled: false }
const DEFAULT_VIDEO_SETTINGS: VideoRelaySettingsValue = { enabled: false }

/** 渠道数或模型总数超过阈值时，显示搜索框帮助快速定位 */
const SEARCH_CHANNEL_THRESHOLD = 4
const SEARCH_MODEL_THRESHOLD = 15

/** 为无视觉输入能力的模型选择独立的视觉模型路由（Chat 与 Agent 共用）。 */
export function VisionRelaySettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<VisionRelaySettingsValue>(DEFAULT_SETTINGS)
  const [saving, setSaving] = React.useState(false)
  const [videoSettings, setVideoSettings] = React.useState<VideoRelaySettingsValue>(DEFAULT_VIDEO_SETTINGS)
  const [savingVideo, setSavingVideo] = React.useState(false)
  const channels = useAtomValue(channelsAtom)

  React.useEffect(() => {
    window.electronAPI.getSettings()
      .then((appSettings) => {
        setSettings(appSettings.visionRelay ?? DEFAULT_SETTINGS)
        setVideoSettings(appSettings.videoRelay ?? DEFAULT_VIDEO_SETTINGS)
      })
      .catch(console.error)
  }, [])

  const save = async (next: VisionRelaySettingsValue): Promise<void> => {
    const previous = settings
    setSettings(next)
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({ visionRelay: next })
    } catch (error) {
      console.error('[视觉助手设置] 保存失败:', error)
      setSettings(previous)
    } finally {
      setSaving(false)
    }
  }

  const saveVideo = async (next: VideoRelaySettingsValue): Promise<void> => {
    const previous = videoSettings
    setVideoSettings(next)
    setSavingVideo(true)
    try {
      await window.electronAPI.updateSettings({ videoRelay: next })
    } catch (error) {
      console.error('[视频助手设置] 保存失败:', error)
      setVideoSettings(previous)
    } finally {
      setSavingVideo(false)
    }
  }

  // 视频助手候选渠道：仅 Kimi API（Anthropic 协议 + Moonshot 文件上传实测可用）
  const kimiChannels = React.useMemo(
    () => channels.filter((channel) => channel.provider === 'kimi-api' && channel.enabled),
    [channels],
  )
  const videoConfigured = Boolean(
    videoSettings.channelId
    && videoSettings.modelId
    && kimiChannels.some((channel) => channel.id === videoSettings.channelId),
  )

  const selectedModel = settings.channelId && settings.modelId
    ? { channelId: settings.channelId, modelId: settings.modelId }
    : null
  const configured = Boolean(selectedModel)

  // 勾选清单候选：全部已启用渠道的已启用模型（排除 Chat 不支持的订阅协议），
  // 但不含被选为视觉模型的那一个（自己补自己无意义）。按渠道分组折叠展示。
  const augmentCandidates = React.useMemo(
    () => buildModelOptions(channels, undefined, undefined, ['openai-codex', 'xai'])
      .filter((option) => !(option.channelId === settings.channelId && option.modelId === settings.modelId)),
    [channels, settings.channelId, settings.modelId],
  )
  const augmentGroups = React.useMemo(() => {
    const groups = new Map<string, ModelOption[]>()
    for (const option of augmentCandidates) {
      const group = groups.get(option.channelId) ?? []
      group.push(option)
      groups.set(option.channelId, group)
    }
    return Array.from(groups.entries())
  }, [augmentCandidates])
  const augmentKeys = settings.augmentModelKeys ?? []

  // 渠道/模型多时提供搜索过滤（匹配渠道名或模型名/ID），并限高滚动防止区块撑爆页面
  const [filterText, setFilterText] = React.useState('')
  const showSearch = augmentGroups.length > SEARCH_CHANNEL_THRESHOLD
    || augmentCandidates.length > SEARCH_MODEL_THRESHOLD
  const normalizedFilter = filterText.trim().toLowerCase()
  const filteredGroups = React.useMemo(() => {
    if (!normalizedFilter) return augmentGroups
    const result: Array<[string, ModelOption[]]> = []
    for (const [channelId, options] of augmentGroups) {
      // 渠道名命中 → 整组保留；否则只留命中的模型
      if (options[0]?.channelName.toLowerCase().includes(normalizedFilter)) {
        result.push([channelId, options])
        continue
      }
      const matched = options.filter((option) =>
        option.modelName.toLowerCase().includes(normalizedFilter)
        || option.modelId.toLowerCase().includes(normalizedFilter))
      if (matched.length > 0) result.push([channelId, matched])
    }
    return result
  }, [augmentGroups, normalizedFilter])

  const toggleAugmentModel = (channelId: string, modelId: string, checked: boolean): void => {
    const key = buildVisionAugmentModelKey(channelId, modelId)
    const next = checked
      ? [...augmentKeys.filter((existing) => existing !== key), key]
      : augmentKeys.filter((existing) => existing !== key)
    void save({ ...settings, augmentModelKeys: next })
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="视觉助手"
        description="为不支持原生视觉的模型接入独立视觉模型：发图时先转成文字描述再交给当前模型，Chat 与 Agent 模式都生效。图片不会发送给当前对话渠道。"
      >
        <SettingsCard>
          <SettingsRow
            label="启用视觉助手"
            icon={<Eye className="size-4 text-accent-2" />}
            description={configured
              ? '需要理解图片时，会自动使用下方选择的视觉模型生成文字描述。'
              : '先选择一个支持图片输入的已配置模型。'}
          >
            <Switch
              checked={settings.enabled}
              disabled={saving || !configured}
              onCheckedChange={(enabled) => void save({ ...settings, enabled })}
            />
          </SettingsRow>
          <SettingsRow
            label="视觉模型"
            description={`选择已有渠道中的视觉模型。${CANOPY_BRAND.productName} 继续复用该渠道加密保存的 API Key。`}
          >
            <ModelSelector
              externalSelectedModel={selectedModel}
              excludedProviders={['openai-codex', 'xai']}
              showChannelInTrigger
              onModelSelect={(model) => void save({
                ...settings,
                channelId: model.channelId,
                modelId: model.modelId,
              })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="需要补齐的模型"
        description="点开渠道勾选需要补齐的模型：发图时会先由上方视觉模型转成文字描述（DeepSeek V4 等已知纯文本模型无需勾选，会自动补齐）。原生支持视觉的模型无需勾选。"
      >
        {augmentGroups.length === 0 ? (
          <SettingsCard>
            <SettingsRow
              label="暂无可勾选的模型"
              icon={<ImageOff className="size-4 text-muted-foreground" />}
              description="请先在「渠道」中添加并启用模型。"
            />
          </SettingsCard>
        ) : (
          <div className="space-y-2">
            {showSearch && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60 pointer-events-none" />
                <Input
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                  placeholder="搜索渠道或模型…"
                  className="pl-9"
                />
              </div>
            )}
            {/* 渠道多时限高滚动，避免区块把整个设置页撑得过长 */}
            <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
              {filteredGroups.length === 0 ? (
                <SettingsCard>
                  <SettingsRow
                    label="没有匹配的渠道或模型"
                    icon={<Search className="size-4 text-muted-foreground" />}
                    description="换个关键词试试。"
                  />
                </SettingsCard>
              ) : (
                filteredGroups.map(([channelId, options]) => (
                  <AugmentChannelGroup
                    key={channelId}
                    channelId={channelId}
                    options={options}
                    augmentKeys={augmentKeys}
                    saving={saving}
                    forceOpen={normalizedFilter.length > 0}
                    onToggle={toggleAugmentModel}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="视频助手"
        description="视频附件先由 Kimi 视频模型转成文字描述再交给当前对话模型（任何对话模型都无法直接接收视频）。视频经 Moonshot 文件服务上传理解，完成后立即删除。"
      >
        <SettingsCard>
          <SettingsRow
            label="启用视频助手"
            icon={<Film className="size-4 text-accent-2" />}
            description={kimiChannels.length === 0
              ? '需要先在「渠道」中添加 Kimi API 渠道（api.moonshot.cn）。'
              : videoConfigured
                ? '发送视频附件时会自动生成文字描述；Agent 也可通过 VideoRelay 工具理解授权目录中的视频。'
                : '先在下方选择 Kimi 渠道与视频模型。'}
          >
            <Switch
              checked={videoSettings.enabled}
              disabled={savingVideo || !videoConfigured}
              onCheckedChange={(enabled) => void saveVideo({ ...videoSettings, enabled })}
            />
          </SettingsRow>
          {kimiChannels.length > 0 && (
            <>
              <SettingsRow
                label="Kimi 渠道"
                description="仅 Kimi API 渠道支持视频理解（Anthropic 协议 + 文件上传）。"
              >
                <Select
                  value={videoSettings.channelId ?? ''}
                  onValueChange={(channelId) => void saveVideo({ ...videoSettings, channelId })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="选择渠道" />
                  </SelectTrigger>
                  <SelectContent>
                    {kimiChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow
                label="视频模型"
                description="Moonshot 官方支持视频理解的模型。"
              >
                <Select
                  value={videoSettings.modelId ?? ''}
                  onValueChange={(modelId) => void saveVideo({ ...videoSettings, modelId })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {KIMI_VIDEO_CAPABLE_MODELS.map((modelId) => (
                      <SelectItem key={modelId} value={modelId}>{modelId}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="隐私边界" description="视觉助手遵循最小外发原则。">
        <SettingsCard>
          <SettingsRow
            label="启用后自动使用视觉模型"
            icon={<ShieldCheck className="size-4 text-success" />}
            description="启用即授权在需要时将对话附件或已授权目录中的 PNG、JPEG、GIF、WebP 图片，以及最多 1000 字符的视觉问题发送给所选模型；单张上限 10MB。视觉结果只会以文本形式返回。启用视频助手即授权将 MP4、MOV、WebM 等视频（单个上限 100MB）上传至 Moonshot 文件服务用于生成描述，完成后立即删除远端文件。"
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

interface AugmentChannelGroupProps {
  channelId: string
  options: ModelOption[]
  augmentKeys: string[]
  saving: boolean
  /** 搜索过滤时强制展开，让命中的模型直接可见 */
  forceOpen?: boolean
  onToggle: (channelId: string, modelId: string, checked: boolean) => void
}

/** 「需要补齐的模型」的渠道折叠分组：默认收起，标题行显示渠道 Logo、模型数与已勾选数。 */
function AugmentChannelGroup({
  channelId,
  options,
  augmentKeys,
  saving,
  forceOpen = false,
  onToggle,
}: AugmentChannelGroupProps): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  const channel = channels.find((c) => c.id === channelId)
  const checkedCount = options.filter(
    (option) => augmentKeys.includes(buildVisionAugmentModelKey(option.channelId, option.modelId)),
  ).length
  // 已有勾选的渠道默认展开，方便回看；其余收起。
  // 设置为异步加载，勾选数首次就绪时补一次自动展开；用户手动折叠后不再打扰。
  const [open, setOpen] = React.useState(checkedCount > 0)
  const userToggledRef = React.useRef(false)
  React.useEffect(() => {
    if (!userToggledRef.current && checkedCount > 0) setOpen(true)
  }, [checkedCount])

  const handleOpenChange = (next: boolean): void => {
    userToggledRef.current = true
    setOpen(next)
  }

  // 搜索过滤时强制展开命中的渠道；清空搜索后回到用户自己的展开状态
  const effectiveOpen = forceOpen || open

  const channelLogo = channel
    ? getChannelLogo({ provider: channel.provider, baseUrl: channel.baseUrl })
    : undefined
  const channelName = options[0]?.channelName ?? channel?.name ?? '未知渠道'

  return (
    <Collapsible open={effectiveOpen} onOpenChange={handleOpenChange}>
      <SettingsCard divided={false}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              {channelLogo && (
                <img src={channelLogo} alt={channelName} className="size-4 rounded object-cover flex-shrink-0" />
              )}
              <span className="text-sm font-medium text-foreground truncate">{channelName}</span>
              <span className="text-xs text-muted-foreground flex-shrink-0">
                {checkedCount > 0 ? `${checkedCount} / ${options.length} 已勾选` : `${options.length} 个模型`}
              </span>
            </div>
            <ChevronDown
              className={cn(
                'size-4 text-muted-foreground/60 flex-shrink-0 transition-transform duration-200',
                effectiveOpen && 'rotate-180',
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/25 divide-y divide-border/25">
            {options.map((option) => (
              <SettingsRow
                key={buildVisionAugmentModelKey(option.channelId, option.modelId)}
                label={option.modelName}
                icon={(
                  <img
                    src={getModelLogo(option.modelId, option.provider)}
                    alt={option.modelName}
                    className="size-4 rounded object-cover"
                  />
                )}
              >
                <Switch
                  checked={augmentKeys.includes(buildVisionAugmentModelKey(option.channelId, option.modelId))}
                  disabled={saving}
                  onCheckedChange={(checked) => onToggle(option.channelId, option.modelId, checked)}
                />
              </SettingsRow>
            ))}
          </div>
        </CollapsibleContent>
      </SettingsCard>
    </Collapsible>
  )
}
