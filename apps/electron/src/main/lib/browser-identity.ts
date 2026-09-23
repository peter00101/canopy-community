import { CANOPY_BRAND } from '@canopy/brand'

/**
 * 受管网页以 Canopy 身份出现，但保留 Chromium 兼容 token 供站点正确选择页面能力。
 * 不伪造为其他浏览器，也不添加跨站识别用的自定义请求头。
 */
export function buildCanopyBrowserUserAgent(defaultUserAgent: string, canopyVersion: string): string {
  const productName = CANOPY_BRAND.productName
  const base = defaultUserAgent
    .replace(/\s+Electron\/[^\s]+/gi, '')
    .replace(new RegExp(`\\s+${productName}/[^\\s]+`, 'gi'), '')
    .trim()
  return `${base} ${productName}/${canopyVersion}`
}
