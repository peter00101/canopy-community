import { describe, expect, test } from 'bun:test'
import { resolveBrowserClosePermission, resolveBrowserUploadPermission } from './browser-close-permission-policy'

describe('BrowserClose 权限策略（免确认关闭时的默认行为）', () => {
  test('Given 未开启免确认且用户主会话发起, When 判定, Then 需要一次性批准', () => {
    expect(resolveBrowserClosePermission('BrowserClose', 'user')).toBe('require-single-approval')
    expect(resolveBrowserClosePermission('BrowserClose', undefined)).toBe('require-single-approval')
  })

  test('Given 自动任务或协作子 Agent 发起, When 判定, Then 直接拒绝（无人值守不能关用户的浏览器）', () => {
    expect(resolveBrowserClosePermission('BrowserClose', 'automation')).toBe('deny-unattended')
    expect(resolveBrowserClosePermission('BrowserClose', 'delegation')).toBe('deny-unattended')
  })

  test('Given 其他浏览器工具, When 判定, Then 沿用各自既有策略（allow）', () => {
    expect(resolveBrowserClosePermission('BrowserCloseTab', 'user')).toBe('allow')
    expect(resolveBrowserClosePermission('BrowserNavigate', 'automation')).toBe('allow')
  })
})

describe('BrowserClose 权限策略（开启免确认后，0.18.74 起默认如此）', () => {
  test('Given 开启免确认且用户主会话发起, When 判定, Then 直接放行不再弹确认', () => {
    expect(resolveBrowserClosePermission('BrowserClose', 'user', true)).toBe('allow')
    expect(resolveBrowserClosePermission('BrowserClose', undefined, true)).toBe('allow')
  })

  test('Given 开启免确认但由自动任务 / 委派发起, When 判定, Then 仍然拒绝', () => {
    // 无人值守场景根本没有用户在场可确认，免确认在这里等于放任模型关掉用户正在看的页面，
    // 所以这条边界不随开关放开
    expect(resolveBrowserClosePermission('BrowserClose', 'automation', true)).toBe('deny-unattended')
    expect(resolveBrowserClosePermission('BrowserClose', 'delegation', true)).toBe('deny-unattended')
  })

  test('Given 开关关闭, When 判定, Then 回到逐次确认（用户可随时改回来）', () => {
    expect(resolveBrowserClosePermission('BrowserClose', 'user', false)).toBe('require-single-approval')
  })
})

describe('BrowserUpload 权限策略（把本机文件选进网页 file input）', () => {
  test('Given 未开启免确认, When 判定, Then 逐次确认——上传是外发动作且不可撤回', () => {
    expect(resolveBrowserUploadPermission()).toBe('require-single-approval')
    expect(resolveBrowserUploadPermission(false)).toBe('require-single-approval')
  })

  test('Given 开启免确认, When 判定, Then 直接放行（维护者 2026-09-09 知悉外发风险后的决定）', () => {
    expect(resolveBrowserUploadPermission(true)).toBe('allow')
  })
})
