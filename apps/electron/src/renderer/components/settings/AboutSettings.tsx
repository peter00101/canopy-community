/**
 * AboutSettings - 关于页面
 *
 * 显示应用版本号等基本信息。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Info, Terminal } from 'lucide-react'
import type { EnvironmentCheckResult, RuntimeStatus, WindowsShellPreference } from '@canopy/shared'
import { CANOPY_BRAND } from '@canopy/brand'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from './primitives'
import { environmentCheckResultAtom } from '@/atoms/environment'
import { EnvironmentCheckCard } from '@/components/environment/EnvironmentCheckCard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

/** 从 package.json 构建时由 Vite define 注入 */
declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__

/** 环境检测卡片 */
function EnvironmentCard(): React.ReactElement {
  const setEnvironmentResult = useSetAtom(environmentCheckResultAtom)
  const [result, setResult] = React.useState<EnvironmentCheckResult | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)

  // 初始化时加载缓存的检测结果
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastEnvironmentCheck) {
        setResult(settings.lastEnvironmentCheck)
        setEnvironmentResult(settings.lastEnvironmentCheck)
      }
    })
  }, [])

  // 执行环境检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      const checkResult = await window.electronAPI.checkEnvironment()
      setResult(checkResult)
      setEnvironmentResult(checkResult)
    } catch (error) {
      console.error('[环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  // Node.js 检测状态
  const nodejsStatus = !result
    ? 'checking'
    : result.nodejs.installed && result.nodejs.meetsMinimum && result.nodejs.meetsRecommended
      ? 'success'
      : 'warning'

  // Git 仅影响仓库状态、Changes 与 Diff，不阻塞基础 Agent。
  const gitStatus = !result
    ? 'checking'
    : result.git.installed && result.git.meetsRequirement
      ? 'success'
      : 'warning'

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">可选环境能力</h3>
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          基础 Agent 无需 Node.js 或 Git；按需安装以启用 MCP、Git 变更视图等能力
        </p>
      </div>

      <div className="p-4 space-y-3">
        {/* Node.js 检测卡片 */}
        <EnvironmentCheckCard
          name="Node.js"
          status={nodejsStatus}
          version={result?.nodejs.version}
          requirement="可选 · 仅 npx / npm 型 MCP 服务器需要（推荐 22 LTS）"
          action={{
            type: 'openExternal',
            url: result?.nodejs.downloadUrl || 'https://nodejs.org/',
          }}
          statusText={
            result && nodejsStatus === 'warning'
              ? `v${result.nodejs.version} (建议升级到 22 LTS 以获得最佳体验)`
              : undefined
          }
        />

        {/* Git 检测卡片 */}
        <EnvironmentCheckCard
          name="Git"
          status={gitStatus}
          version={result?.git.version}
          requirement="可选 · Git 仓库状态、Changes 与 Diff 功能需要"
          action={{
            type: 'openExternal',
            url: result?.git.downloadUrl || 'https://git-scm.com/',
          }}
        />

        {/* Windows 提示 */}
        {result?.platform === 'win32' && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Windows 用户建议：</strong>
              安装时请选择默认路径（C:\Program Files\...），并确保勾选"添加到 PATH"选项
            </AlertDescription>
          </Alert>
        )}
      </div>
    </SettingsCard>
  )
}

/** Shell 环境卡片（Windows 平台）*/
function ShellEnvironmentCard(): React.ReactElement | null {
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [shellPreference, setShellPreference] = React.useState<WindowsShellPreference>('auto')
  const [isChecking, setIsChecking] = React.useState(false)

  // 初始化时加载运行时状态与用户偏好
  React.useEffect(() => {
    Promise.all([window.electronAPI.getRuntimeStatus(), window.electronAPI.getSettings()])
      .then(([status, settings]) => {
        setRuntimeStatus(status)
        setShellPreference(settings.windowsShellPreference ?? 'auto')
      })
      .catch((error) => console.error('[Shell 环境检测] 读取设置失败:', error))
  }, [])

  // 重新检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      // 触发重新初始化运行时（后续可以添加此 IPC 方法）
      const status = await window.electronAPI.getRuntimeStatus()
      setRuntimeStatus(status)
    } catch (error) {
      console.error('[Shell 环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  const handlePreferenceChange = async (value: string): Promise<void> => {
    if (value !== 'auto' && value !== 'git-bash' && value !== 'wsl') return
    const preference = value as WindowsShellPreference
    await window.electronAPI.updateSettings({ windowsShellPreference: preference })
    setShellPreference(preference)
  }

  // 非 Windows 平台不显示
  if (!runtimeStatus || !runtimeStatus.shell) {
    return null
  }

  const { shell } = runtimeStatus
  const hasShell = shell.gitBash?.available || shell.wsl?.available
  const resolvedShell = shellPreference === 'wsl' && shell.wsl.available
    ? 'wsl'
    : shellPreference === 'git-bash' && shell.gitBash.available
      ? 'git-bash'
      : shell.recommended
  const resolvedShellLabel = resolvedShell === 'git-bash' ? 'Git Bash' : resolvedShell === 'wsl' ? 'WSL' : '无可用 Shell'

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Shell 环境（Windows）</h3>
            {!hasShell && <Badge variant="secondary">可选</Badge>}
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          可选：配置 Git Bash 或 WSL 后，Agent 可执行 Bash 命令
        </p>
      </div>

      <div className="p-4 space-y-3">
        <SettingsSelect
          label="Agent Shell"
          description="默认使用 Git Bash，确保 Windows 项目与 Agent 工具使用同一套路径；选择 WSL 后，WSL 不可用时会回退到 Git Bash。"
          value={shellPreference}
          onValueChange={(value) => {
            void handlePreferenceChange(value).catch((error) => console.error('[Shell 环境检测] 保存偏好失败:', error))
          }}
          options={[
            { value: 'auto', label: '自动（推荐：Git Bash 优先）' },
            { value: 'git-bash', label: 'Git Bash' },
            { value: 'wsl', label: 'WSL（实验性）' },
          ]}
        />

        {/* Git Bash 检测卡片 */}
        <EnvironmentCheckCard
          name="Git Bash"
          status={shell.gitBash?.available ? 'success' : 'error'}
          version={shell.gitBash?.version ?? undefined}
          requirement="Git for Windows 自带"
          action={{ type: 'download', installerId: 'git-for-windows' }}
          statusText={
            shell.gitBash?.available
              ? `${shell.gitBash.path}`
              : shell.gitBash?.error || '未安装'
          }
        />

        {/* WSL 检测卡片 */}
        <EnvironmentCheckCard
          name="WSL"
          status={shell.wsl?.available ? 'success' : 'error'}
          version={shell.wsl?.version ? `WSL ${shell.wsl.version}` : undefined}
          requirement="WSL 1 或 WSL 2"
          action={{
            type: 'openExternal',
            url: 'https://learn.microsoft.com/zh-cn/windows/wsl/install',
          }}
          statusText={
            shell.wsl?.available
              ? `默认发行版: ${shell.wsl.defaultDistro || '未设置'} (${shell.wsl.distros.join(', ')})`
              : shell.wsl?.error || '未安装'
          }
        />

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Agent 将使用：</strong>{resolvedShellLabel}
            {shellPreference === 'wsl' && resolvedShell !== 'wsl' && '（WSL 不可用，已回退）'}
            {shellPreference === 'git-bash' && resolvedShell !== 'git-bash' && '（Git Bash 不可用，已回退）'}
          </AlertDescription>
        </Alert>

        {/* 无可用环境警告 */}
        {!hasShell && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>未检测到可用的 Shell 环境。</strong>
              <br />
              基础 Agent 仍可使用；安装 Git Bash 或 WSL 后可启用 Bash 命令执行。
            </AlertDescription>
          </Alert>
        )}
      </div>
    </SettingsCard>
  )
}

export function AboutSettings(): React.ReactElement {
  return (
    <SettingsSection
      title={`关于 ${CANOPY_BRAND.productName}`}
      description="集成通用 AI Agent 的下一代人工智能软件"
    >
      <SettingsCard>
        <SettingsRow label="版本">
          <span className="text-sm text-muted-foreground font-mono">{APP_VERSION}</span>
        </SettingsRow>
        <SettingsRow label="运行时">
          <span className="text-sm text-muted-foreground">Electron + React</span>
        </SettingsRow>
        <SettingsRow
          label="开源协议"
          description="基于 AGPL-3.0 开源"
        >
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            AGPL-3.0
          </a>
        </SettingsRow>
      </SettingsCard>

      {/* 环境检测卡片 */}
      <EnvironmentCard />

      {/* Shell 环境卡片（仅 Windows） */}
      <ShellEnvironmentCard />
    </SettingsSection>
  )
}
