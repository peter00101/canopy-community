/**
 * OfficeCLI 资源目录的清理判定。
 *
 * 这个目录（`apps/electron/resources/officecli/`）由 prepare-officecli 独占写入、被
 * gitignore、且完全可再生，所以判定口径是**白名单**：除了当前构建目标的产物本身，
 * 目录里出现的任何东西都是残留，一律清掉。
 *
 * 为什么不是「按模式匹配已知残片」（0.18.34 的原设计）：那种写法只认得当时见过的
 * `<产物名>.download-<pid>-<时间戳>`，认不出后来出现的新残片。实际就出过两类：
 *   1. 下载被外力打断（进程被杀 / 沙箱挂起超时）留下的 `.download-*` 半成品
 *      —— 0.18.33 打 mac 包时 9.9MB 残片进包才发现；
 *   2. 二进制**自更新**留下的 `<产物名>.old` —— Windows 上运行中的映像删不掉，
 *      上游把旧版重命名后就删除失败、原样留在目录里（33MB）。
 * 白名单口径把第二类以及一切未来的新形态一并覆盖。
 *
 * 注意：这里返回的是「该删的」，调用方删完还要再断言目录恰好只剩产物本身——
 * 因为进包走的是 electron-builder 的 `extraResources`（`from: resources/officecli`，
 * `filter: **\/*`），目录里剩什么就打进包什么。
 */
export function pickUnexpectedOfficeCliEntries(entries: readonly string[], outputName: string): string[] {
  return entries.filter((entry) => entry !== outputName)
}

/**
 * 目录是否恰好只有产物本身。prepare 在下载/校验完成后调用，不成立即中断构建。
 */
export function isOfficeCliDirectoryClean(entries: readonly string[], outputName: string): boolean {
  return entries.length === 1 && entries[0] === outputName
}
