/**
 * 教程配图路径改写（纯函数，无 electron 依赖，便于单测）。
 *
 * 教程内容是以**字符串**交给渲染层的，没有随行的基准目录，相对路径无从解析；
 * 而 `resources/` 的真实位置只有主进程知道（开发在 dist/resources，生产在
 * extraResources）。故由主进程改写为绝对路径，交给渲染层既有的
 * `file:resolve-path` → `canopy-file://` 链路在图片真正渲染时解析。
 */

/** 教程配图目录名；教程 markdown 内一律以 `tutorial-images/xxx.png` 相对形式引用。 */
export const TUTORIAL_IMAGES_DIR_NAME = 'tutorial-images'

/**
 * 把 `![alt](tutorial-images/x.png "图注")` 改写为绝对路径形态。
 *
 * 三个刻意选择：
 * - **绝对路径而非直接注册 `canopy-file://`**：注册令牌 TTL 仅 1 小时，若在取内容时
 *   注册，教程标签页开着超过 1 小时后重绘就会 404；改写成路径则由图片渲染的那一刻
 *   才去换令牌，天然不受 TTL 影响。
 * - **正斜杠**：Windows 绝对路径的反斜杠在 markdown 里会被当作转义符。
 * - **角括号包裹**：生产环境路径可能含空格（如 `C:/Program Files/...`）。
 *
 * ⚠️ **教程配图只能用 markdown 形态，不能用 `<img width>` 控制显示尺寸。**
 * 编辑器虽然开了 `html: true`、`markdownImage` 也支持 `width` 属性，但独立成行的
 * `<img>` 会走原始 HTML 通路，被 `markdown-preview-extensions.tsx` 的 `sanitizeHtml`
 * （DOMPurify）处理——`C:/...` 被当作未知协议 `c:`，**整个 src 属性会被静默剥掉**，
 * 渲染出一个空 img（实测：src=null、width 未应用、无 figure 包裹）。
 * 所以配图尺寸只能靠 png 自身的像素宽度控制：栏宽以内按原尺寸显示，超出由
 * `max-w-full` 限制到栏宽。
 *
 * 改写结果仍能被 `stripTutorialImages` 整段删除，所以欢迎对话的附件里不会残留本机路径。
 */
export function rewriteTutorialImagePaths(markdown: string, imagesDir: string): string {
  const base = imagesDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return markdown.replace(
    new RegExp(`(!\\[[^\\]]*\\]\\()<?${TUTORIAL_IMAGES_DIR_NAME}/([^)>\\s]+)>?((?:\\s+"[^"]*")?\\))`, 'g'),
    (_match, prefix: string, name: string, suffix: string) => `${prefix}<${base}/${name}>${suffix}`,
  )
}

/**
 * 从教程内容里剥掉图片。
 *
 * 欢迎对话把教程作为附件喂给模型，图片在纯文本上下文里没有意义，且改写后的
 * 绝对路径只是噪音。markdown 与 HTML 两种形态都要剥干净。
 */
export function stripTutorialImages(markdown: string): string {
  return markdown
    .replace(/!\[.*?\]\(.*?\)\n*/g, '')
    .replace(/<img\b[^>]*>\n*/g, '')
}
