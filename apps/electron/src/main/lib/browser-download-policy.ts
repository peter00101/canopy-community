import { join } from 'node:path'
import { getConfigDir } from './config-paths'

/**
 * 受管浏览器下载策略：下载不再一律取消，而是受控落到数据目录内的
 * 专用下载目录。文件名经消毒后拼接，网页无法指定落盘路径。
 */

/** 单个下载文件的大小上限；超过即取消，防止网页恶意占满磁盘。 */
export const MAX_BROWSER_DOWNLOAD_BYTES = 1024 * 1024 * 1024 // 1GB

/** 每个会话保留的下载记录条数上限（内存 + 状态广播用，文件本身不受影响）。 */
export const MAX_BROWSER_DOWNLOAD_RECORDS = 50

/** Windows 保留设备名；命中时加前缀避免生成不可操作的文件。 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

const MAX_FILENAME_LENGTH = 120

const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]', 'g')

/** 浏览器下载统一落盘目录（数据目录内，dev/正式自动隔离）。 */
export function getBrowserDownloadsDir(): string {
  return join(getConfigDir(), 'browser-downloads')
}

/**
 * 消毒网页提供的下载文件名：去除路径分隔与控制字符、拒绝保留名、
 * 限制长度并保留扩展名；空名回退到带时间戳的兜底名。
 */
export function sanitizeDownloadFilename(rawName: string, fallbackStamp: number): string {
  const trimmed = rawName
    .replace(CONTROL_CHARS, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    // 先修剪首尾空白与点（纯点串直接归空走兜底名，也避免生成隐藏文件），
    // 再压平剩余的内部点串，杜绝 ".." 上级引用形态
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .replace(/\.{2,}/g, '_')
  let name = trimmed
  if (!name) name = `download-${fallbackStamp}`
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`
  if (name.length > MAX_FILENAME_LENGTH) {
    const dotIndex = name.lastIndexOf('.')
    // 扩展名（含点）最长保留 16 位，主体截断到剩余额度
    const ext = dotIndex > 0 && name.length - dotIndex <= 16 ? name.slice(dotIndex) : ''
    // 截断后主体末尾可能重新落在空格或点上（上面的首尾修剪发生在截断之前）。
    // 这种名字 Node 能建能读（走 \\?\ 长路径绕过了 Win32 规范化），但资源管理器、
    // 「在文件夹中显示」、用户手动删除等所有 Win32 路径一律访问不到——会留下一个
    // 打不开也删不掉的幽灵文件。再修剪一次；主体首字符已保证非空白非点，不会剪空。
    const base = name.slice(0, MAX_FILENAME_LENGTH - ext.length).replace(/[\s.]+$/, '')
    name = (base || `download-${fallbackStamp}`) + ext
  }
  return name
}

/**
 * 重名文件生成「name (1).ext」式的唯一名。exists 由调用方注入（便于测试，
 * 生产传 fs.existsSync 与目录拼接）。
 */
export function resolveUniqueFilename(filename: string, exists: (candidate: string) => boolean): string {
  if (!exists(filename)) return filename
  const dotIndex = filename.lastIndexOf('.')
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename
  const ext = dotIndex > 0 ? filename.slice(dotIndex) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  // 千次冲突几乎不可能；用时间戳兜底保证终止
  return `${base}-${Date.now()}${ext}`
}

/** 导出 PDF 的默认文件名：取页面标题消毒，空标题回退 page。 */
export function buildPdfExportFilename(pageTitle: string, fallbackStamp: number): string {
  const sanitized = sanitizeDownloadFilename(pageTitle, fallbackStamp)
  const base = sanitized.replace(/\.pdf$/i, '') || `page-${fallbackStamp}`
  return `${base}.pdf`
}

/** 下载达到已知总量或接收量超限时应当取消。totalBytes 为 0 表示服务端未声明长度。 */
export function shouldCancelDownload(receivedBytes: number, totalBytes: number): boolean {
  if (totalBytes > MAX_BROWSER_DOWNLOAD_BYTES) return true
  return receivedBytes > MAX_BROWSER_DOWNLOAD_BYTES
}
