/**
 * 预热 Pi Agent SDK 的约 36MB 模块图（唯一目的：让宿主应用在启动空闲期把加载耗时提前，
 * 避免"第一条 Agent 消息几十秒无响应"）。宿主只管调用，不需要持有或使用返回的模块本身
 * ——真正的动态 import 仍在各自的调用点（agent-orchestrator.ts / pi-agent-adapter.ts 等），
 * 这里只是触发一次模块加载并原样吞掉结果。
 */
export function warmupPiRuntimeModule(): Promise<void> {
  return import('@earendil-works/pi-coding-agent').then(() => undefined)
}
