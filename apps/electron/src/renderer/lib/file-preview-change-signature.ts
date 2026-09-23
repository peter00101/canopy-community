/**
 * 窗口重新聚焦时判断「预览的文件在外部被改过没有」的指纹。
 *
 * 0.18.67 修维护者报障：原实现只对 `resolveAndReadFile` 返回的 **content** 取 hash，而该接口
 * 对二进制文件（.xlsx/.docx/.pptx、图片等）恒返回空串——mac / Windows 实测同样，同目录 .md
 * 返回 24 字节、.xlsx 返回 0 字节。于是 Office 文档的指纹永远相同，「切走再切回」这条外部
 * 修改兜底对它们**从来没生效过**。
 *
 * 改为把 metadata 的 size 与 modifiedAt 一并计入：二进制文件靠这两项识别变化，文本文件仍
 * 保留内容 hash，覆盖「大小与 mtime 都没变但内容变了」的边角（部分文件系统 mtime 粒度粗）。
 */
import type { FilePreviewReadResult } from '@canopy/shared'

/** cyrb53: 快速字符串 hash，遍历完整内容避免边缘碰撞 */
export function cyrb53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * 由预览读取结果构造变化指纹。文件读不到时返回固定的 `missing`，使「消失 → 恢复」也判为变化。
 *
 * metadata 用可选读取：dev 下 renderer 可能先于 main 热重载，拿到老结构不应整条链路抛错。
 */
export function buildFilePreviewChangeSignature(result: FilePreviewReadResult | null | undefined): string {
  if (!result) return 'missing'
  const size = result.metadata?.size ?? -1
  const modifiedAt = result.metadata?.modifiedAt ?? -1
  return `${size}:${modifiedAt}:${cyrb53(result.content ?? '')}`
}
