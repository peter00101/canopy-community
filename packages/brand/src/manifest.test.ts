import { describe, expect, test } from 'bun:test'
import { CANOPY_BRAND } from './manifest'

describe('CANOPY_BRAND', () => {
  test('本地配置目录独立于其它发行版', () => {
    expect(CANOPY_BRAND.configDirName).toBe('.canopy-community')
    expect(CANOPY_BRAND.configDirNameDev).toBe('.canopy-community-dev')
  })

  test('appId 与 electron-builder.yml 保持一致', () => {
    expect(CANOPY_BRAND.appId).toBe('com.canopy.community')
  })

  test('userData 使用独立目录，与同名 package 的其它发行版互不干扰', () => {
    expect(CANOPY_BRAND.userDataDirName).toBe('@canopy/electron-community')
  })

  test('User-Agent 产品标识是单个 token', () => {
    expect(CANOPY_BRAND.userAgentProduct).not.toMatch(/\s/)
    expect(CANOPY_BRAND.userAgentProduct.length).toBeGreaterThan(0)
  })

  test('Git 归因 trailer 使用产品名', () => {
    const trailer = `${CANOPY_BRAND.gitAttribution.trailerKey}: ${CANOPY_BRAND.productName}`
    expect(trailer).toBe('Made-with: Canopy Community')
  })

  test('Vault 展示文案', () => {
    expect(CANOPY_BRAND.vault.managedLabel).toBe('Canopy Vault')
    expect(CANOPY_BRAND.vault.inboxName).toBe('Canopy Inbox')
  })
})
