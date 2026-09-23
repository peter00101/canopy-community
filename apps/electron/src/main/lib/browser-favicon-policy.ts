/**
 * 受管浏览器标签图标（favicon）的保留 / 清空判定。
 *
 * 背景（我方对上游 v0.19.1 #1888 的修正，属长期分叉）：
 * 上游在 `did-navigate` 里无条件 `tab.favicon = null`，注释写「新页面随后会通过
 * page-favicon-updated 重新发布」。但 Chromium **只在 favicon 发生变化时**才派发
 * `page-favicon-updated`——同一站点内的再次导航（重定向落地、SPA 路由、同 URL 重载）
 * 不会重复派发。于是「清空 → 没有补发」，标签图标闪一下就永久消失。
 * 必应首页实测：图标出现 4 帧后被后续 did-navigate 清掉，此后再不回来。
 *
 * 修正：只有**站点（origin）真的换了**才清空。同站导航保留已拿到的图标，
 * 跨站导航仍立即清空（避免 A 站图标残留在 B 站标签上，这是上游本来要防的问题）。
 */

/** 解析 URL 的 origin；about:blank / data: / 畸形 URL 等无 origin 概念的一律返回 null。 */
export function getFaviconOrigin(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const { origin } = new URL(url)
    // 非网页 scheme（about:/data:/blob:）在 URL 标准里 origin 为 'null' 字符串
    return origin && origin !== 'null' ? origin : null
  } catch {
    return null
  }
}

/**
 * 导航到 nextUrl 时是否应清空当前 favicon。
 *
 * @param currentFaviconOrigin 当前 favicon 所属站点（由 page-favicon-updated 时记录）
 * @param nextUrl 本次 did-navigate 落地的地址
 */
export function shouldClearFaviconOnNavigate(
  currentFaviconOrigin: string | null,
  nextUrl: string | null | undefined,
): boolean {
  // 尚无图标时无所谓清不清，统一返回 true 让调用方走同一条赋值路径
  if (!currentFaviconOrigin) return true
  const nextOrigin = getFaviconOrigin(nextUrl)
  // 落地页没有有效 origin（about:blank 等）：旧站图标不该留在空白页上
  if (!nextOrigin) return true
  return nextOrigin !== currentFaviconOrigin
}
