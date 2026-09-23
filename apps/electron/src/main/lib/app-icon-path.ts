import { join } from 'node:path'

/**
 * 解析应用图标变体相对 resources 目录的路径。
 *
 * macOS Dock 不会给 dock.setIcon 的自定义图标套系统圆角模板，
 * 圆角与留白必须烘焙进位图本身。默认图标（icon.png）生成时已带
 * 该几何；其余变体的满幅方形原版仅供品牌素材下载使用，darwin 上
 * 必须改走 canopy-logos/dock/ 下的同款几何加工版本，否则 Dock
 * 里会显示为直角方块。
 */
export function resolveAppIconRelativePath(variantId: string, platform: NodeJS.Platform): string {
  if (!variantId || variantId === 'default') {
    return 'icon.png'
  }
  if (platform === 'darwin') {
    return join('canopy-logos', 'dock', `canopy-${variantId}.png`)
  }
  return join('canopy-logos', `canopy-${variantId}.png`)
}
