/**
 * node-pty 的 Electron ABI 重编（容错版）。
 *
 * 上游直接跑 `electron-rebuild -f -w node-pty`，但它依赖本机 C++ 工具链
 * （Windows 需 VS Build Tools，mac 需 Xcode CLT）。node-pty 1.1.0 是 N-API
 * （node-addon-api）模块，ABI 跨 Node/Electron 稳定，官方 prebuilds 在
 * Electron 43 下实测可直接加载（2026-08-27 本机 spawn PowerShell 回显验证）。
 * 因此重编失败不应阻断 dev/打包：prebuild 在位就警告后继续，缺了才硬失败。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')
const require2 = createRequire(join(appDir, 'package.json'))

function findNodePtyDir(): string | null {
  try {
    return dirname(require2.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

const result = spawnSync('bunx', ['electron-rebuild', '-f', '-w', 'node-pty'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: true,
})

if (result.status === 0) {
  console.log('[rebuild-node-pty] electron-rebuild 成功')
  process.exit(0)
}

const ptyDir = findNodePtyDir()
const prebuilt = ptyDir ? join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node') : null
if (prebuilt && existsSync(prebuilt)) {
  console.warn('[rebuild-node-pty] electron-rebuild 失败（本机可能缺 C++ 工具链），'
    + `回落使用官方 N-API prebuild：${prebuilt}`)
  process.exit(0)
}

console.error('[rebuild-node-pty] electron-rebuild 失败且找不到对应平台的 prebuild，无法继续')
process.exit(result.status ?? 1)
