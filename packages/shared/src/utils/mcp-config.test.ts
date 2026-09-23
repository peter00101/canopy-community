import { describe, expect, it } from 'bun:test'
import { removeMcpServerFromConfig } from './mcp-config'
import type { WorkspaceMcpConfig } from '../types/agent'

// 上游 98a56c0c 交付时零测试。这里钉住「删一个不动其他」这条唯一契约——
// 它正是 #1993 的病根：删 A 时用整份配置回存，导致 B/C 被顺带关闭并重新验证。
describe('removeMcpServerFromConfig', () => {
  const config: WorkspaceMcpConfig = {
    servers: {
      a: { type: 'stdio', command: 'a-cmd', enabled: true },
      b: { type: 'stdio', command: 'b-cmd', enabled: true, lastTestResult: { success: true, message: 'ok', timestamp: 1 } },
      c: { type: 'stdio', command: 'c-cmd', enabled: false },
    },
  }

  it('给定三个 MCP，当删除其中一个时，则只有它消失', () => {
    const next = removeMcpServerFromConfig(config, 'a')
    expect(Object.keys(next.servers).sort()).toEqual(['b', 'c'])
  })

  it('给定其余条目带启用态与验证结果，当删除别的条目时，则它们逐字段原样保留', () => {
    const next = removeMcpServerFromConfig(config, 'a')
    expect(next.servers.b).toEqual(config.servers.b)
    expect(next.servers.c).toEqual(config.servers.c)
  })

  it('给定原配置对象，当删除后，则不就地修改入参（调用方仍持有旧快照）', () => {
    removeMcpServerFromConfig(config, 'a')
    expect(Object.keys(config.servers).sort()).toEqual(['a', 'b', 'c'])
  })

  it('给定不存在的名字，当删除时，则返回等价配置而不是抛错', () => {
    expect(removeMcpServerFromConfig(config, '不存在').servers).toEqual(config.servers)
  })

  it('给定只有一个条目的配置，当删掉它时，则得到空的 servers 而不是 undefined', () => {
    const next = removeMcpServerFromConfig({ servers: { only: { type: 'stdio', command: 'x', enabled: true } } }, 'only')
    expect(next.servers).toEqual({})
  })
})
