/**
 * Git / PR 归因标识
 *
 * 目标：当 Agent 代用户创建 commit / PR 时，附带可搜索、可关闭的产品标识，
 * 同时避免 Co-Authored-By 假冒作者、污染 GitHub contributors。
 *
 * System prompt 指令 — 引导 Agent 在 git commit / gh pr 时附加标识。
 *
 * 后续可增强：canUseTool 对 Bash 的确定性 --trailer / body 注入。
 *
 * 品牌相关取值（链接地址、产品名、trailer key）来自 `@canopy/brand` 的 `CANOPY_BRAND`。
 */

import { CANOPY_BRAND } from '@canopy/brand'

/** 默认开启：对齐 Claude Code / Cursor「默认归因 + 可关」策略 */
export const DEFAULT_GIT_ATTRIBUTION_ENABLED = true

/** Commit trailer（标准 git trailer，不进入 GitHub co-author 列表） */
export const CANOPY_COMMIT_TRAILER = `${CANOPY_BRAND.gitAttribution.trailerKey}: ${CANOPY_BRAND.productName}`

/** PR / MR 描述底部标识；品牌未配置链接时只写产品名。 */
export const CANOPY_PR_ATTRIBUTION = buildPrAttribution(CANOPY_BRAND.productName, CANOPY_BRAND.gitAttribution.linkUrl)

export function buildPrAttribution(productName: string, linkUrl: string | null): string {
  return linkUrl ? `Made with [${productName}](${linkUrl})` : `Made with ${productName}`
}

export interface GitAttributionConfig {
  /** 是否启用；undefined 视为默认开启 */
  enabled?: boolean
}

/** 解析最终是否启用（缺省 = 默认开启） */
export function isGitAttributionEnabled(config?: GitAttributionConfig | boolean | null): boolean {
  if (typeof config === 'boolean') return config
  if (config && typeof config === 'object' && typeof config.enabled === 'boolean') {
    return config.enabled
  }
  return DEFAULT_GIT_ATTRIBUTION_ENABLED
}

/** 注入到 buildSystemPrompt 的 Git/PR 标识规范 */
export function buildGitAttributionPromptSection(enabled: boolean): string {
  if (!enabled) {
    return `## Git / PR 标识
用户已关闭 ${CANOPY_BRAND.productName} 标识；除非当次明确要求，不要添加任何 ${CANOPY_BRAND.productName} 归因。`
  }

  return `## Git / PR 标识
当你代用户创建 commit 或 PR/MR 时，除非用户当次明确拒绝：
- commit 的 message 末尾追加唯一的 \`${CANOPY_COMMIT_TRAILER}\` trailer；不要使用 \`Co-Authored-By\`，不要改 author/committer。
- PR/MR 描述末尾追加唯一的 \`${CANOPY_PR_ATTRIBUTION}\`。`
}
