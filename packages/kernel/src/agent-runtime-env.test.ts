import { describe, expect, test } from 'bun:test'
import type { GitBashStatus, RuntimeStatus, ShellEnvironmentStatus, WslStatus } from '@canopy/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'

function runtimeStatus(shell: ShellEnvironmentStatus): RuntimeStatus {
  return { shell } as RuntimeStatus
}

const gitBash: GitBashStatus = {
  available: true,
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  version: '5.2.37',
  error: null,
}

const wsl: WslStatus = {
  available: true,
  version: 2,
  defaultDistro: 'Ubuntu-24.04',
  distros: ['Ubuntu-24.04'],
  error: null,
}

const bothShells = runtimeStatus({ gitBash, wsl, recommended: 'git-bash' })

describe('Agent Windows Shell 运行环境', () => {
  test('Given Git Bash 与 WSL 均可用 When 使用默认策略 Then 优先使用 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
    })

    expect(result).toMatchObject({
      shellKind: 'git-bash',
      shellPath: gitBash.path,
      env: {
        CANOPY_WINDOWS_SHELL: 'git-bash',
      },
    })
  })

  test('Given Git Bash 与 WSL 均可用 When 用户显式选择 WSL Then 使用 WSL', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
      windowsShellPreference: 'wsl',
    })

    expect(result).toMatchObject({
      shellKind: 'wsl',
      wslCommand: 'wsl.exe',
      wslDistro: 'Ubuntu-24.04',
      env: {
        CANOPY_WINDOWS_SHELL: 'wsl',
        CANOPY_WSL_DISTRO: 'Ubuntu-24.04',
      },
    })
  })

  test('Given WSL 首选项不可用 When Git Bash 可用 Then 回退到 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      windowsShellPreference: 'wsl',
      runtimeStatus: runtimeStatus({
        gitBash,
        wsl: { ...wsl, available: false, version: null, defaultDistro: null, distros: [], error: '未安装' },
        recommended: 'git-bash',
      }),
    })

    expect(result.shellKind).toBe('git-bash')
    expect(result.shellPath).toBe(gitBash.path!)
  })

  test('Given Windows Path 大小写不同 When 合并运行环境 Then 仅保留覆盖后的 PATH', () => {
    const result = mergeRuntimeEnv(
      { Path: 'C:\\Windows\\System32' },
      { PATH: 'C:\\Canopy;C:\\Windows\\System32' },
    )

    // 上游原文两段都带盘符冒号；08-09 品牌重构（74ec7115）把第一段品牌名换掉时顺手丢了第二段的冒号，
    // 这条从此在 Windows 与 mac 上都红，被当成「环境类既有失败」记了一个多月。
    expect(result).toEqual({ PATH: 'C:\\Canopy;C:\\Windows\\System32' })
  })
})
