import { describe, expect, mock, test } from 'bun:test'
import type { McpServerEntry, WorkspaceMcpConfig } from '@canopy/shared'

mock.module('./index', () => ({ getMainWindow: () => null }))

mock.module('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: true, on: () => undefined, setPath: () => undefined, setName: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
  nativeTheme: {},
  shell: {},
  dialog: {},
  BrowserWindow: class { static getAllWindows = () => [] },
  clipboard: {},
  nativeImage: {},
  net: {},
  Menu: {},
  Notification: class {},
  Tray: class {},
  WebContentsView: class {},
  MessageChannelMain: class {},
  utilityProcess: {},
  globalShortcut: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  protocol: {},
  safeStorage: {},
  screen: {},
  session: {},
  systemPreferences: {},
}))

const {
  getCliIntegrationStatuses,
  getCliProbeInvocation,
  getMcpEntryFingerprint,
  mapWithConcurrency,
  mergeMcpRefreshResults,
} = await import('./ipc')

function mcpEntry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    type: 'http',
    url: 'https://mcp.example.com/v1',
    headers: { Authorization: 'Bearer original-token' },
    enabled: true,
    ...overrides,
  }
}

describe('MCP connection refresh helpers', () => {
  test('Given a same-name server edited during validation When merging old evidence Then it does not write the old result', () => {
    const initial = mcpEntry()
    const unchanged = mcpEntry({ url: 'https://mcp.example.com/unchanged' })
    const current: WorkspaceMcpConfig = {
      servers: {
        edited: mcpEntry({ url: 'https://mcp.example.com/v2', headers: { Authorization: 'Bearer replacement-token' } }),
        unchanged,
      },
    }

    const merged = mergeMcpRefreshResults(current, [
      {
        name: 'edited',
        fingerprint: getMcpEntryFingerprint(initial),
        lastTestResult: { success: true, message: '旧验证结果', timestamp: 1 },
      },
      {
        name: 'unchanged',
        fingerprint: getMcpEntryFingerprint(unchanged),
        lastTestResult: { success: true, message: '当前验证结果', timestamp: 2 },
      },
    ])

    expect(merged.servers.edited).toEqual(current.servers.edited)
    expect(merged.servers.unchanged?.lastTestResult).toEqual({ success: true, message: '当前验证结果', timestamp: 2 })
  })

  test('Given a server is disabled or deleted while its handshake is in flight When merging its old evidence Then it cannot be restored', () => {
    const initial = mcpEntry()
    const validation = [{
      name: 'target',
      fingerprint: getMcpEntryFingerprint(initial),
      lastTestResult: { success: true, message: '过期验证结果', timestamp: 1 },
    }]

    const disabled = mergeMcpRefreshResults({
      servers: { target: mcpEntry({ enabled: false }), unaffected: mcpEntry({ url: 'https://mcp.example.com/new' }) },
    }, validation)
    expect(disabled.servers.target).toEqual(mcpEntry({ enabled: false }))
    expect(disabled.servers.unaffected).toEqual(mcpEntry({ url: 'https://mcp.example.com/new' }))

    const deleted = mergeMcpRefreshResults({
      servers: { unaffected: mcpEntry({ url: 'https://mcp.example.com/new' }) },
    }, validation)
    expect(deleted.servers.target).toBeUndefined()
    expect(deleted.servers.unaffected).toEqual(mcpEntry({ url: 'https://mcp.example.com/new' }))
  })

  test('Given many enabled servers When validating Then concurrency stays bounded and output order is stable', async () => {
    let active = 0
    let peak = 0
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await Bun.sleep(5)
      active -= 1
      return value * 10
    })

    expect(peak).toBe(2)
    expect(results).toEqual([0, 10, 20, 30, 40, 50])
  })
})

describe('CLI integration status probes', () => {
  test('Given an npm CLI on Windows When creating its probe invocation Then it uses cmd.exe for the .cmd shim', () => {
    expect(getCliProbeInvocation('lark-cli', ['auth', 'status', '--verify'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      bin: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'lark-cli auth status --verify'],
    })
    expect(getCliProbeInvocation('gh', ['auth', 'status'], 'darwin')).toEqual({
      bin: 'gh',
      args: ['auth', 'status'],
    })
  })

  test('Given missing CLI commands When checking statuses Then all catalog CLIs are returned and none is connected', async () => {
    const calls: Array<{ bin: string; args: string[] }> = []
    const statuses = await getCliIntegrationStatuses(async (bin, args) => {
      calls.push({ bin, args })
      return { status: null, stdout: '' }
    })

    expect(statuses).toEqual([
      { id: 'wecom-cli', connected: false, enabled: true },
      { id: 'dingtalk-cli', connected: false, enabled: true },
      { id: 'github-cli', connected: false, enabled: true },
      { id: 'feishu-cli', connected: false, enabled: true },
    ])
    expect(calls).toEqual([
      { bin: 'wecom-cli', args: ['auth', 'show', '--status'] },
      { bin: 'dws', args: ['auth', 'status', '--format', 'json'] },
      { bin: 'gh', args: ['auth', 'status', '--active'] },
      { bin: 'lark-cli', args: ['auth', 'status', '--verify'] },
    ])
  })

  test('Given DWS reports a valid authenticated session When checking statuses Then DingTalk is connected', async () => {
    const statuses = await getCliIntegrationStatuses(async (bin) => {
      if (bin === 'dws') {
        return { status: 0, stdout: JSON.stringify({ success: true, authenticated: true, token_valid: true }) }
      }
      return { status: null, stdout: '' }
    })

    expect(statuses.find((status) => status.id === 'dingtalk-cli')).toEqual({
      id: 'dingtalk-cli',
      connected: true,
      enabled: true,
    })
  })

  test('Given DWS has no complete valid status result When checking statuses Then DingTalk remains disconnected', async () => {
    const statuses = await getCliIntegrationStatuses(async (bin) => {
      if (bin === 'dws') return { status: 0, stdout: JSON.stringify({ success: true, authenticated: true }) }
      return { status: null, stdout: '' }
    })

    expect(statuses.find((status) => status.id === 'dingtalk-cli')).toEqual({
      id: 'dingtalk-cli',
      connected: false,
      enabled: true,
    })
  })

  test('Given an authenticated CLI disabled for Canopy When checking statuses Then it remains authenticated but is not enabled for this workspace', async () => {
    const statuses = await getCliIntegrationStatuses(async (bin) => {
      if (bin === 'gh') return { status: 0, stdout: 'authenticated' }
      return { status: null, stdout: '' }
    }, new Set(['github-cli']))

    expect(statuses.find((status) => status.id === 'github-cli')).toEqual({
      id: 'github-cli',
      connected: true,
      enabled: false,
    })
  })
})
