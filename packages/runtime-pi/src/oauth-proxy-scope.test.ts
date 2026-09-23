import { describe, expect, test } from 'bun:test'
import { buildOAuthNoProxy, readNoProxyEnvironment, runWithOAuthProxyScope } from './oauth-proxy-scope'
import { getPiRequestProxyDispatcher } from './pi-request-proxy'

describe('OAuth proxy scope', () => {
  test('Given a user NO_PROXY list When building OAuth exclusions Then preserves it and includes every loopback host', () => {
    expect(buildOAuthNoProxy('internal.example,localhost')).toBe('internal.example,localhost,127.0.0.1,[::1]')
  })

  test('Given a NO_PROXY wildcard When building OAuth exclusions Then preserves its all-direct meaning', () => {
    expect(buildOAuthNoProxy('*')).toBe('*')
  })

  test('Given both NO_PROXY environment variable spellings When resolving exclusions Then prefers lowercase like Undici', () => {
    expect(readNoProxyEnvironment({
      NO_PROXY: 'uppercase.example',
      no_proxy: 'lowercase.example',
    })).toBe('lowercase.example')
  })

  test('Given an application proxy When running OAuth Then scopes the entire operation to that proxy', async () => {
    await expect(runWithOAuthProxyScope(async () => {
      expect(getPiRequestProxyDispatcher()).toBeDefined()
      return 'token'
    }, async () => 'http://127.0.0.1:7890')).resolves.toBe('token')

    expect(getPiRequestProxyDispatcher()).toBeUndefined()
  })

  test('Given no configured proxy When running OAuth Then preserves direct networking while retaining loopback exclusions', async () => {
    await expect(runWithOAuthProxyScope(async () => {
      expect(getPiRequestProxyDispatcher()).toBeUndefined()
      return 'token'
    }, async () => undefined)).resolves.toBe('token')
  })
})
