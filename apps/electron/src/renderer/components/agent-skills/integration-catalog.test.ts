import { describe, expect, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { buildCatalogMcpGuidePrompt, compareCatalogConnectionCards, getCatalogCliConnectionStatus, getCatalogCliStatusRank, getCatalogGuidedConnectionStatus, getCatalogMcpConnectionState, getCatalogMcpConnectionStatus, getCatalogMcpStatusRank, getCatalogServerNames, isCatalogIntegrationVisible, MCP_CREDENTIAL_SETUP_INSTRUCTION, MCP_INTEGRATION_CATALOG, type CatalogCredentialIntegration, type CatalogGuidedIntegration, type CatalogMcpIntegration } from './integration-catalog'

describe('MCP integration catalog', () => {
  test('uses unique server names and valid MCP transports', () => {
    const mcps = MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'mcp')
    const serverNames = MCP_INTEGRATION_CATALOG.flatMap((integration) =>
      'serverName' in integration && integration.serverName ? [integration.serverName] : [],
    )

    expect(new Set(serverNames).size).toBe(serverNames.length)
    for (const integration of mcps) {
      expect(['stdio', 'http', 'sse']).toContain(integration.entry.type)
      expect(integration.entry.enabled).toBe(integration.authentication === 'none')
      expect(integration.capabilities).toHaveLength(3)
      if (integration.entry.type === 'stdio') {
        expect(integration.entry.command).toBeTruthy()
      } else {
        expect(integration.entry.url).toMatch(/^https:\/\//)
      }
    }
  })

  test('hides unverified providers from the picker while retaining 百度网盘 and the 通达信 re-enable', () => {
    const visibleIds = MCP_INTEGRATION_CATALOG.filter(isCatalogIntegrationVisible).map((integration) => integration.id)

    expect(visibleIds).toContain('baidu-netdisk')
    // 通达信由维护者点名上架，从隐藏名单移出（我方分叉，见 integration-catalog.ts 隐藏名单注释）
    expect(visibleIds).toContain('tongdaxin-mcp')
    expect(visibleIds).not.toEqual(expect.arrayContaining([
      'google-calendar-mcp',
      'vercel-mcp',
      'github-cli',
      'github-mcp',
      'stripe-mcp',
    ]))
    // Definitions remain available for an explicit post-verification re-enable.
    expect(MCP_INTEGRATION_CATALOG.map((integration) => integration.id)).toEqual(expect.arrayContaining([
      'tongdaxin-mcp',
      'google-calendar-mcp',
      'vercel-mcp',
      'github-cli',
      'github-mcp',
      'stripe-mcp',
    ]))
  })

  test('marks only implemented catalog providers for built-in OAuth', () => {
    const oauthProviders = MCP_INTEGRATION_CATALOG
      .filter((integration): integration is CatalogMcpIntegration => integration.kind === 'mcp')
      .filter((integration) => integration.authentication === 'oauth' && integration.oauthProvider)
      .map((integration) => ({ id: integration.id, provider: integration.oauthProvider, serverName: integration.serverName }))

    // 上游 v0.19.52 把 GitHub 从「未测试前隐藏」里放出来，并补上了真实 OAuth 端点
    // （authorize / token / scopes，clientSecretRequired），所以它也算已实现。
    expect(oauthProviders).toEqual([
      { id: 'github-mcp', provider: 'github', serverName: 'github' },
      { id: 'notion-mcp', provider: 'notion', serverName: 'notion' },
    ])
  })

  test('keeps CLI entries separate from workspace MCP configuration and removes deprecated services', () => {
    const clis = MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'cli')

    expect(clis).not.toHaveLength(0)
    expect(clis).toContainEqual(expect.objectContaining({
      id: 'feishu-cli',
      iconSlug: 'asset:feishu',
      setupUrl: 'https://www.feishu.cn/feishu-cli',
    }))
    expect(clis).toContainEqual(expect.objectContaining({
      id: 'wecom-cli',
      name: '企业微信 CLI',
      iconSlug: 'asset:wecom',
      setupUrl: 'https://open.work.weixin.qq.com/help2/pc/21676',
      featured: true,
    }))
    expect(clis).toContainEqual(expect.objectContaining({
      id: 'dingtalk-cli',
      setupUrl: 'https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within',
      agentPrompt: expect.stringContaining('https://open.dingtalk.com/document/development/dingtalk-cli-performing-tasks-within'),
    }))
    expect(MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'guided').map((integration) => integration.id)).toEqual([
      'tongdaxin-mcp',
      'ctrip-wendao',
      'baidu-netdisk',
      'qichacha-mcp',
      'eastmoney-miaoxiang',
    ])
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'wecom-mcp')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'netease-mail')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'zsxq')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'dingtalk-mcp')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'linear-mcp')).toBe(true)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'sentry-mcp' || integration.id === 'sentry-cli')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'qq-mail-mcp')).toBe(false)
    const tencentDocs = MCP_INTEGRATION_CATALOG.find((integration) => integration.id === 'tencent-docs-mcp')
    expect(tencentDocs).toEqual(expect.objectContaining({
      name: '腾讯文档',
      iconSlug: 'asset:tencent-docs',
      kind: 'credential',
      placement: 'bottom',
      serverName: 'tencent-docs',
      setupUrl: 'https://docs.qq.com/open/document/mcp/get-token',
      entry: expect.objectContaining({ type: 'http', url: 'https://docs.qq.com/openapi/mcp', enabled: false }),
      credential: expect.objectContaining({
        label: 'MCP Token',
        headerName: 'Authorization',
        acquisitionUrl: 'https://docs.qq.com/open/document/mcp/get-token',
      }),
    }))
    if (!tencentDocs || tencentDocs.kind !== 'credential') throw new Error('腾讯文档必须使用安全 Token 凭据流程')
    expect(tencentDocs.entry.headers).toBeUndefined()
    expect(tencentDocs.credential.helpText).toContain('不会添加 Bearer 前缀')
    expect(MCP_INTEGRATION_CATALOG.some((integration) => integration.id === 'vercel-cli' || integration.id === 'wrangler-cli' || integration.id === 'stripe-cli')).toBe(false)
    expect(MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'mcp' && integration.placement === 'bottom').map((integration) => integration.id)).toEqual([
      'vercel-mcp',
      'supabase-mcp',
      'stripe-mcp',
    ])
    expect(MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'guided' && integration.placement === 'bottom')).toEqual([])
    // 上游 v0.19.26（#1976）新增 Brave / Tavily 两个 credential 类搜索服务，此处随之扩容
    const credentialEntries = MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'credential')
    expect(new Set(credentialEntries.map((integration) => integration.id))).toEqual(new Set([
      'tencent-docs-mcp',
      'tavily-search-mcp',
      'brave-search-mcp',
      // 上游 v0.19.53（#2040）新增 Exa Search
      'exa-search-mcp',
    ]))
    expect(credentialEntries).toContainEqual(tencentDocs)
    expect(MCP_INTEGRATION_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'google-calendar-mcp',
        name: 'Google 日历',
        iconSlug: 'googlecalendar',
        kind: 'mcp',
        serverName: 'google-calendar',
        setupUrl: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
        entry: expect.objectContaining({ type: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1' }),
      }),
      expect.objectContaining({
        id: 'linear-mcp',
        name: 'Linear',
        iconSlug: 'linear',
        kind: 'mcp',
        serverName: 'linear',
        setupUrl: 'https://linear.app/docs/mcp',
        entry: expect.objectContaining({ type: 'http', url: 'https://mcp.linear.app/mcp' }),
      }),
      expect.objectContaining({
        id: 'tongdaxin-mcp',
        setupUrl: 'https://vip.tdx.com.cn/site/app/pc-mall/main.html#/page_product_mcp',
        agentPrompt: expect.stringContaining(`${CANOPY_BRAND.productName} 内置浏览器`),
      }),
      expect.objectContaining({
        id: 'qichacha-mcp',
        setupUrl: 'https://agent.qcc.com/',
        agentPrompt: expect.stringContaining('https://agent.qcc.com/'),
      }),
      expect.objectContaining({
        id: 'eastmoney-miaoxiang',
        setupUrl: 'https://choice.eastmoney.com/mcp/',
        agentPrompt: expect.stringContaining('https://choice.eastmoney.com/mcp/'),
      }),
      expect.objectContaining({
        id: 'baidu-netdisk',
        iconSlug: 'asset:baidu-netdisk',
        setupUrl: 'https://pan.baidu.com/union/doc/mcp-server/%E4%BD%BF%E7%94%A8%E6%A6%82%E8%BF%B0/',
        agentPrompt: expect.stringContaining('https://pan.baidu.com/union/doc/mcp-server/%E4%BD%BF%E7%94%A8%E6%A6%82%E8%BF%B0/'),
      }),
      expect.objectContaining({ id: 'qichacha-mcp', iconSlug: 'asset:qichacha' }),

    ]))
    expect(clis).toContainEqual(expect.objectContaining({
      id: 'github-cli',
      setupUrl: 'https://cli.github.com/',
      agentPrompt: expect.stringContaining('https://cli.github.com/'),
    }))
    for (const integration of clis) {
      expect(integration.agentPrompt).toContain('不要只给我一个网页链接')
      expect(integration.agentPrompt).toContain('官方 CLI 已完成真实认证验证')
      expect(integration.agentPrompt).toContain(`当前 ${CANOPY_BRAND.productName} workspace 的目录中被允许/启用`)
      expect(integration.agentPrompt).toContain('不要猜测或伪造 CLI 状态')
      expect(integration.setupUrl).toMatch(/^https:\/\//)
      expect(integration.capabilities).toHaveLength(3)
      expect('entry' in integration).toBe(false)
    }
    expect(MCP_INTEGRATION_CATALOG.filter((integration) => integration.kind === 'guided').every((integration) => integration.agentPrompt.includes('当前 Agent 对话'))).toBe(true)
    for (const integration of MCP_INTEGRATION_CATALOG.filter((item) => item.kind === 'guided')) {
      expect(integration.agentPrompt).toContain('真实 SDK handshake 与 listTools 验证')
      expect(integration.agentPrompt).toContain('OpenClaw/mcporter')
      expect(integration.capabilities).toHaveLength(3)
    }

    const mcpIntegration = MCP_INTEGRATION_CATALOG.find((integration): integration is CatalogMcpIntegration => integration.kind === 'mcp')
    expect(mcpIntegration).toBeDefined()
    const mcpPrompt = buildCatalogMcpGuidePrompt(mcpIntegration!)
    expect(mcpPrompt).toContain(`当前 ${CANOPY_BRAND.productName} workspace 的 MCP 配置`)
    expect(mcpPrompt).toContain('真实 SDK handshake 与 listTools 验证成功')
    expect(mcpPrompt).toContain('通过 # 调用')
    expect(mcpPrompt).toContain('OpenClaw/mcporter')
    expect(MCP_CREDENTIAL_SETUP_INSTRUCTION).toContain('真实 SDK handshake 与 listTools 验证成功')
  })

  test('orders catalog MCP states as connected, pending, then unconfigured', () => {
    expect([
      getCatalogMcpStatusRank('connected'),
      getCatalogMcpStatusRank('pending'),
      getCatalogMcpStatusRank('unconfigured'),
    ]).toEqual([3, 2, 1])
  })

  test('keeps CLI cards neutral until their local status probe completes', () => {
    const connected = new Set(['github-cli'])

    expect(getCatalogCliConnectionStatus('github-cli', connected, 'loading')).toBe('checking')
    expect(getCatalogCliConnectionStatus('github-cli', connected, 'failed')).toBe('unavailable')
    expect(getCatalogCliConnectionStatus('github-cli', connected, 'ready')).toBe('connected')
    expect(getCatalogCliConnectionStatus('feishu-cli', connected, 'ready')).toBe('unconfigured')
    expect([
      getCatalogCliStatusRank('connected'),
      getCatalogCliStatusRank('checking'),
      getCatalogCliStatusRank('unavailable'),
      getCatalogCliStatusRank('unconfigured'),
    ]).toEqual([3, 2, 1, 0])
  })

  test('prioritizes requested services only within their connection-status group', () => {
    const preferredIds = MCP_INTEGRATION_CATALOG
      .filter((integration) => integration.featured)
      .map((integration) => integration.id)

    expect(preferredIds).toEqual([
      'tongdaxin-mcp',
      'wecom-cli',
      'dingtalk-cli',
      'qichacha-mcp',
    ])
  })

  test('keeps verified Tencent Docs with other connected MCPs despite bottom placement', () => {
    const tencentDocs = MCP_INTEGRATION_CATALOG.find((integration) => integration.id === 'tencent-docs-mcp')
    expect(tencentDocs?.placement).toBe('bottom')
    expect(compareCatalogConnectionCards(
      { placement: 'bottom', statusRank: getCatalogMcpStatusRank('connected') },
      { featured: true, statusRank: getCatalogMcpStatusRank('pending') },
    )).toBeLessThan(0)
    expect(compareCatalogConnectionCards(
      { placement: 'bottom', statusRank: getCatalogMcpStatusRank('pending') },
      { featured: true, statusRank: getCatalogMcpStatusRank('unconfigured') },
    )).toBeLessThan(0)
  })

  test('maps Tencent Docs only from persisted and verified Canopy MCP configuration', () => {
    const installed = new Set(['tencent-docs'])
    const enabled = new Set(['tencent-docs'])

    expect(getCatalogMcpConnectionState('tencent-docs', installed, enabled)).toEqual({ configured: true, enabled: true })
    expect(getCatalogMcpConnectionState(undefined, installed, enabled)).toEqual({ configured: false, enabled: false })
    expect(getCatalogMcpConnectionStatus('missing', installed, enabled, new Set())).toBe('unconfigured')
    expect(getCatalogMcpConnectionStatus('tencent-docs', installed, new Set(), new Set())).toBe('pending')
    expect(getCatalogMcpConnectionStatus('tencent-docs', installed, enabled, new Set())).toBe('pending')

    // A catalog connection is real only after the persisted Canopy entry is enabled and its test succeeded.
    expect(getCatalogMcpConnectionStatus('tencent-docs', installed, enabled, enabled)).toBe('connected')
    expect(getCatalogMcpConnectionStatus('tencent-docs', installed, new Set(), enabled)).toBe('pending')
    // 上游 v0.19.52 起只统计**可见**目录项：被 HIDDEN_UNTIL_TESTED 挡住的卡
    // （google-calendar / vercel / stripe）不再占用目录服务名，否则 Agent 写入的
    // 同名工作区 MCP 会既不在目录里、也不在「我的 MCP」里。
    expect(getCatalogServerNames()).toEqual(new Set([
      'github',
      'notion',
      'linear',
      'supabase',
      'tencent-docs',
      'qcc-company',
      'eastmoney-miaoxiang',
      // 上游 v0.19.26（#1976）新增的两个搜索服务
      'tavily-search',
      'brave-search',
      // 上游 v0.19.53（#2040）新增 Exa Search
      'exa',
    ]))
  })

  test('maps guided MCP cards from their persisted server keys rather than installation chat claims', () => {
    const qichacha = MCP_INTEGRATION_CATALOG.find((integration): integration is CatalogGuidedIntegration => integration.id === 'qichacha-mcp' && integration.kind === 'guided')
    const eastmoney = MCP_INTEGRATION_CATALOG.find((integration): integration is CatalogGuidedIntegration => integration.id === 'eastmoney-miaoxiang' && integration.kind === 'guided')

    expect(qichacha).toEqual(expect.objectContaining({ kind: 'guided', serverName: 'qcc-company' }))
    expect(eastmoney).toEqual(expect.objectContaining({ kind: 'guided', serverName: 'eastmoney-miaoxiang' }))

    const installed = new Set(['qcc-company', 'eastmoney-miaoxiang'])
    const enabledAndVerified = new Set(['qcc-company', 'eastmoney-miaoxiang'])
    expect(getCatalogGuidedConnectionStatus(qichacha!, new Set(), installed, enabledAndVerified, enabledAndVerified)).toBe('connected')
    expect(getCatalogGuidedConnectionStatus(eastmoney!, new Set(), installed, enabledAndVerified, enabledAndVerified)).toBe('connected')
    // A same-named active Skill cannot satisfy a guided MCP's handshake requirement.
    expect(getCatalogGuidedConnectionStatus(qichacha!, new Set(['qcc-company']), new Set(), new Set(), new Set())).toBe('unconfigured')
  })

  test('marks 携程问道 available only when its active workspace Skill is installed', () => {
    const ctrip = MCP_INTEGRATION_CATALOG.find((integration): integration is CatalogGuidedIntegration => integration.id === 'ctrip-wendao' && integration.kind === 'guided')
    if (!ctrip) throw new Error('携程问道必须保留为 guided integration')

    expect(ctrip).toEqual(expect.objectContaining({ expectedSkillSlug: 'ctrip-wendao' }))
    expect(getCatalogGuidedConnectionStatus(ctrip, new Set(['ctrip-wendao']), new Set(), new Set(), new Set())).toBe('skill-available')
    expect(getCatalogGuidedConnectionStatus(ctrip, new Set(), new Set(), new Set(), new Set())).toBe('unconfigured')
  })
})

// ---- 以下用例来自上游 v0.19.26（#1976 Brave/Tavily MCP 预设），合并轮收编 ----

function credentialIntegration(id: string): CatalogCredentialIntegration {
  const integration = MCP_INTEGRATION_CATALOG.find((item) => item.id === id)
  if (!integration || integration.kind !== 'credential') throw new Error(`missing credential integration: ${id}`)
  return integration
}

test('Given the MCP connection catalog When listing search providers Then Brave and Tavily require only their API key with official console links', () => {
  const brave = credentialIntegration('brave-search-mcp')
  const tavily = credentialIntegration('tavily-search-mcp')

  expect(brave.entry).toEqual({
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
    enabled: false,
  })
  expect(brave.credential).toMatchObject({
    envName: 'BRAVE_API_KEY',
    credentialStorageUrl: 'https://api.search.brave.com/',
    acquisitionUrl: 'https://api-dashboard.search.brave.com/app/keys',
  })

  expect(tavily.entry).toEqual({ type: 'http', url: 'https://mcp.tavily.com/mcp', enabled: false })
  expect(tavily.credential).toMatchObject({
    headerName: 'Authorization',
    valuePrefix: 'Bearer ',
    credentialStorageUrl: 'https://mcp.tavily.com/mcp',
    acquisitionUrl: 'https://app.tavily.com/home',
  })
})

test('搜索服务目录顺序固定为飞书、钉钉、企业微信、Tavily、Brave，再到其他集成', () => {
  const expected = ['feishu-cli', 'dingtalk-cli', 'wecom-cli', 'tavily-search-mcp', 'brave-search-mcp']
  const actual = [...MCP_INTEGRATION_CATALOG]
    .sort((left, right) => compareCatalogConnectionCards(
      { priority: left.priority, placement: left.placement, featured: left.featured, statusRank: 1 },
      { priority: right.priority, placement: right.placement, featured: right.featured, statusRank: 1 },
    ))
    .map((integration) => integration.id)

  expect(actual.slice(0, expected.length)).toEqual(expected)
})
