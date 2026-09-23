/**
 * 文件面板的可见性判定：文件树、@ 文件搜索与目录监听共用同一份口径。
 *
 * 1. 临时 / 锁文件：Office / WPS 打开文档时的 `~$` 属主文件、LibreOffice 的 `.~lock.*#`、
 *    各类程序保存时的 `*.tmp`。它们会在几秒内出现又消失，文件树里每闪一次，下面的行就整体
 *    上下跳一行（实测 32px），维护者报障「项目文件一直抖动」可稳定复现。只是不展示，不影响读写。
 * 2. Python 虚拟环境：除了 `.venv` / `venv`，训练项目常见 `.venv-train`、`venv310` 这类带后缀的
 *    目录，里面几万个文件，装包 / 编译时持续写入。不排除就会让监听不停触发整树刷新、搜索同步扫描。
 */

const TRANSIENT_FILE_PATTERNS: readonly RegExp[] = [
  /^~\$/, // Office / WPS 属主文件：~$报告.docx
  /^\.~lock\..*#$/, // LibreOffice 锁文件：.~lock.报告.docx#
  /\.tmp$/i, // 保存 / 下载过程中的临时文件
]

/** 是否为应在文件面板中隐藏的临时 / 锁文件（只看文件名）。 */
export function isTransientFileName(name: string): boolean {
  return TRANSIENT_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

/** 是否为 Python 虚拟环境或其包目录（.venv、venv、.venv-train、venv310、site-packages）。 */
export function isPythonEnvironmentDirName(name: string): boolean {
  if (name === 'site-packages') return true
  return /^\.?venv(?:$|[-_.\d])/i.test(name)
}
