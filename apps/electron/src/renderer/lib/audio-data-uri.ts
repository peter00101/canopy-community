/**
 * data: URI → ArrayBuffer 解码。
 *
 * 背景（2026-08-24 维护者报障「相当一部分提示音没声」）：vite 默认把 ≤4096 字节的
 * 资源内联成 data: URI（12 个通知音包里恰有 11 个小 mp3 中招），而通知音走
 * fetch/XHR 加载后交给 Web Audio 解码——这两条网络路径都受 CSP `connect-src`
 * 管辖（白名单里没有 data:），于是小音效文件双路被拦、静默失败。
 *
 * 根因已在 vite.config.ts 里修（音频文件永不内联）；本函数是第二道防线：
 * 遇到 data: URI 时直接在 JS 里解码出字节，完全不经过网络层与 CSP。
 */

/**
 * 把 data: URI 解码为 ArrayBuffer。
 *
 * 支持 base64 与 percent-encoding 两种载荷形态；非 data: URL 或畸形输入返回
 * null（调用方继续走 fetch/XHR 正常路径）。
 */
export function decodeDataUriToArrayBuffer(url: string): ArrayBuffer | null {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  try {
    if (/;base64$/i.test(meta)) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }
    // 非 base64 载荷按 percent-encoding 文本处理（音频实际都是 base64，此分支为完备性）
    return new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer
  } catch {
    return null
  }
}
