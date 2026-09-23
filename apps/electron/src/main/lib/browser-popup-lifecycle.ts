/**
 * 关闭父标签时，子标签（由页面 window.open / target=_blank 打开）该不该跟着关。
 *
 * 上游 v0.19.1 的做法是无条件递归回收（disposePopupChildren），但这与浏览器行为不符：
 * 在必应里点开一个网页，再关掉必应标签，那个网页也被一起关掉了（维护者实测报障）。
 * Chrome 里从 A 打开的 B 是独立标签，关 A 不动 B。
 *
 * 真正需要跟随关闭的只有「临时弹窗」——网站用 window.open 弹出的登录/支付框那类：
 * 它们停在 about:blank / blob: / data:，本身没有可独立浏览的内容，父页面一关就是孤儿。
 * 只要子标签已经导航到真实网页（http/https），就把它留下并解除父子关系。
 */

export interface PopupChildState {
  tabId: string
  /** 子标签当前地址；未开始导航时可能为空。 */
  currentUrl: string
  /** window.open 请求的初始地址（用于识别 about:blank 起步的临时弹窗）。 */
  initialUrl: string | null
  /** 初始导航是否仍未完成。 */
  initialNavigationPending: boolean
}

/** 只有 http/https 才算「已落到可独立浏览的真实网页」。 */
function isRealPage(url: string | null | undefined): boolean {
  if (!url) return false
  const value = url.trim()
  return /^https?:\/\//i.test(value)
}

/**
 * 父标签关闭时，返回应当**一并关闭**的子标签 id。
 * 未列出的子标签应被保留，并由调用方清掉其 openerTabId（解除父子关系）。
 */
export function getPopupChildrenToDispose(children: readonly PopupChildState[]): string[] {
  return children
    .filter((child) => {
      // 已经停在真实网页上 → 用户在看的内容，必须留下
      if (isRealPage(child.currentUrl)) return false
      // 还没导航完，但目标就是真实网页 → 也留下（正在加载的页面不该被父标签带走）
      if (child.initialNavigationPending && isRealPage(child.initialUrl)) return false
      // 其余（about:blank / blob: / data: 的临时弹窗）随父标签回收
      return true
    })
    .map((child) => child.tabId)
}
