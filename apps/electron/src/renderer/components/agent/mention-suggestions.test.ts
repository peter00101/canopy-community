import { describe, expect, test } from 'bun:test'
import type { WorkspaceCapabilities } from '@canopy/shared'
import { getMcpMentionItems } from './mention-suggestions'

// Match the real IPC payload: only success/timestamp cross to the renderer,
// never the server-provided diagnostic message.
const mcpServers: WorkspaceCapabilities['mcpServers'] = [
  {
    name: 'playwright',
    enabled: true,
    type: 'stdio',
    lastTestResult: { success: true, timestamp: 1 },
  },
  {
    name: 'nowledge-mem',
    enabled: true,
    type: 'http',
    lastTestResult: { success: true, timestamp: 2 },
  },
  {
    name: 'gmail',
    enabled: true,
    type: 'stdio',
    lastTestResult: { success: false, timestamp: 3 },
  },
  {
    name: 'not-tested-mcp',
    enabled: true,
    type: 'stdio',
  },
  {
    name: 'disabled-mcp',
    enabled: false,
    type: 'sse',
    lastTestResult: { success: true, timestamp: 4 },
  },
]

describe('getMcpMentionItems', () => {
  test('空查询只显示当前工作区中已启用且持久化测试成功的 MCP', () => {
    expect(getMcpMentionItems(mcpServers, '')).toEqual([
      { id: 'playwright', name: 'playwright', type: 'stdio' },
      { id: 'nowledge-mem', name: 'nowledge-mem', type: 'http' },
    ])
  })

  test('按 MCP 名称不区分大小写筛选已验证候选', () => {
    expect(getMcpMentionItems(mcpServers, 'MEM')).toEqual([
      { id: 'nowledge-mem', name: 'nowledge-mem', type: 'http' },
    ])
  })
})
