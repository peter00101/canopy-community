/// <reference types="vite/client" />

// CSS 模块类型声明
declare module '*.css' {
  const content: Record<string, string>
  export default content
}

// 音频资源类型声明
declare module '*.wav' {
  const src: string
  export default src
}

declare module '*.mp3' {
  const src: string
  export default src
}

interface AppPerformanceDiagnostics {
  snapshot: () => import('./lib/performance-monitor').PerformanceSnapshot
  clear: () => void
}

// 附件临时 base64 缓存（用于发送前暂存数据）
interface Window {
  __pendingAttachmentData?: Map<string, string>
  __pendingAgentFileData?: Map<string, string>
  /** 仅在 ?perf=1 或 app-performance-debug=1 时安装的性能诊断接口。 */
  __appPerformance?: AppPerformanceDiagnostics
}
