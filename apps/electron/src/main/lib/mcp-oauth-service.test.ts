import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

let tempHome: string
const originalHome = process.env.HOME
const originalCanopyDev = process.env.CANOPY_DEV
const originalFetch = globalThis.fetch

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function encryptedCredential(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64')
}

function credentialPath(): string {
  return join(tempHome, CANOPY_BRAND.configDirName, 'mcp-oauth-credentials.json')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-mcp-oauth-'))
  process.env.HOME = tempHome
  process.env.CANOPY_DEV = '0'
  await import('./mcp-oauth-service')
})

beforeEach(() => {
  rmSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true, force: true })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalCanopyDev === undefined) delete process.env.CANOPY_DEV
  else process.env.CANOPY_DEV = originalCanopyDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('MCP OAuth resource metadata', () => {
  test('Given issuer URL When building RFC 8414 metadata URL Then path is inserted after the host-level well-known prefix', async () => {
    const {
      authorizationServerMetadataUrl,
      protectedResourceMetadataUrl,
    } = await import('./mcp-oauth-service')

    expect(authorizationServerMetadataUrl('https://auth.example.com'))
      .toBe('https://auth.example.com/.well-known/oauth-authorization-server')
    expect(authorizationServerMetadataUrl('https://auth.example.com/issuer'))
      .toBe('https://auth.example.com/.well-known/oauth-authorization-server/issuer')
    expect(authorizationServerMetadataUrl('https://auth.example.com/issuer/'))
      .toBe('https://auth.example.com/.well-known/oauth-authorization-server/issuer/')
    expect(authorizationServerMetadataUrl('https://auth.example.com/org/team/issuer'))
      .toBe('https://auth.example.com/.well-known/oauth-authorization-server/org/team/issuer')

    expect(protectedResourceMetadataUrl('https://mcp.example.com/org/server/'))
      .toBe('https://mcp.example.com/.well-known/oauth-protected-resource/org/server')
  })
})

describe('MCP OAuth token resource indicator', () => {
  test('Given normalized resource When exchanging authorization code Then resource is included in the form body', async () => {
    const { exchangeAuthorizationCode } = await import('./mcp-oauth-service')
    let requestBody = ''
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 })
    }) as typeof fetch

    await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:1234/callback',
      code: 'authorization-code',
      verifier: 'verifier',
      resource: 'https://mcp.example.com/server/',
    })

    expect(new URLSearchParams(requestBody).get('resource')).toBe('https://mcp.example.com/server/')
  })

  test('Given resource-bearing credential When refreshing Then resource is included in the form body', async () => {
    const { refreshCredential } = await import('./mcp-oauth-service')
    let requestBody = ''
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'refreshed-access-token', expires_in: 3600 }), { status: 200 })
    }) as typeof fetch

    await refreshCredential({
      provider: 'notion',
      serverUrl: 'https://mcp.example.com/server/',
      resource: 'https://mcp.example.com/server/',
      clientId: 'client-id',
      tokenEndpoint: 'https://auth.example.com/token',
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
    })

    expect(new URLSearchParams(requestBody).get('resource')).toBe('https://mcp.example.com/server/')
  })

  // 「legacy 凭证 refresh 不带 resource」的行为由上方 refreshCredential 直测覆盖；
  // getMcpOAuthHeaders 端到端版会经 runWithOAuthProxyScope 走真实代理探测（上游 7d07bdfd 之后），
  // mock fetch 拦不住，不在单测里重复。
})

describe('MCP static token credentials', () => {
  test('Given a Tencent-style Authorization token When resolving headers Then it is returned unchanged and is not persisted as plaintext', async () => {
    const { getMcpOAuthHeaders, saveMcpApiKey } = await import('./mcp-oauth-service')
    const token = 'test-mcp-token-not-a-bearer-value'

    saveMcpApiKey({ workspaceSlug: 'workspace', serverName: 'tencent-docs', serverUrl: 'https://docs.example.com/mcp', headerName: 'Authorization', value: token })

    await expect(getMcpOAuthHeaders('workspace', 'tencent-docs', 'https://docs.example.com/mcp')).resolves.toEqual({ Authorization: token })
    expect(readFileSync(credentialPath(), 'utf-8')).not.toContain(token)
  })
})

describe('MCP OAuth credential deletion', () => {
  test('Given multiple credentials When deleting one server Then only its credential is removed', async () => {
    const { deleteMcpCredential } = await import('./mcp-oauth-service')
    mkdirSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true })
    writeFileSync(credentialPath(), JSON.stringify({
      version: 1,
      credentials: {
        'workspace:server-a': encryptedCredential({ value: 'secret-a' }),
        'workspace:server-b': encryptedCredential({ value: 'secret-b' }),
      },
    }), 'utf-8')

    deleteMcpCredential('workspace', 'server-a')

    const stored = JSON.parse(readFileSync(credentialPath(), 'utf-8')) as { credentials: Record<string, string> }
    expect(stored.credentials['workspace:server-a']).toBeUndefined()
    expect(stored.credentials['workspace:server-b']).toBeDefined()
  })
})
