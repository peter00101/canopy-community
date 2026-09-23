/**
 * 视觉补齐的模型判定（纯逻辑，依赖全部注入）。
 *
 * 从 vision-relay-service 抽出来，是为了让测试不必 `mock.module` 整个 channel-manager /
 * settings-service / attachment-service / @canopy/runtime-pi——bun 的 `mock.module` 是进程级全局的，
 * 成套混跑时会把别的测试文件拿到的同名模块一并换掉（渠道运行时认证解析 ×2、
 * 已下线模型清理 ×1 就是这么红的）。
 */

import type { ProviderType } from '@canopy/shared'
import { buildVisionAugmentModelKey } from '../../types'

export type ImageInputCapability = 'supported' | 'unsupported' | 'unknown'

export interface VisionAugmentEligibilityDeps {
  /** 用户在视觉助手页勾选的模型键（`channelId::modelId`，见 buildVisionAugmentModelKey） */
  getAugmentModelKeys: () => readonly string[] | undefined
  /** 渠道的 provider；渠道不存在返回 undefined */
  getChannelProvider: (channelId: string) => ProviderType | undefined
  /** Pi catalog 判定的图片输入能力 */
  resolveImageInputCapability: (provider: ProviderType, modelId: string) => Promise<ImageInputCapability>
}

/**
 * 判定某个「渠道 + 模型」发图时是否需要视觉补齐。
 *
 * 用户在视觉助手页勾选的模型优先（可强制补齐 catalog 判为支持/未知的模型）；
 * 未勾选时按 pi catalog 兜底：仅明确 unsupported（如 DeepSeek V4）自动补齐，
 * unknown（自定义模型查不到）不补齐，交由用户勾选决定——绝不误伤原生视觉模型。
 */
export async function decideShouldAugmentModel(
  channelId: string | undefined,
  modelId: string | undefined,
  deps: VisionAugmentEligibilityDeps,
): Promise<boolean> {
  const trimmedModelId = modelId?.trim()
  if (!channelId || !trimmedModelId) return false

  if (deps.getAugmentModelKeys()?.includes(buildVisionAugmentModelKey(channelId, trimmedModelId))) return true

  const provider = deps.getChannelProvider(channelId)
  if (!provider) return false
  const capability = await deps.resolveImageInputCapability(provider, trimmedModelId)
  return capability === 'unsupported'
}
