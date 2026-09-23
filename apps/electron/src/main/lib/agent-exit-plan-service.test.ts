/**
 * AgentExitPlanService 计划审批服务测试（上游 #2018 计划文档）
 *
 * 重点覆盖维护者报障的「提供修改意见被吞」链路：
 * - 反馈通过 deny message 通道传给模型（原文不丢）
 * - 所有 resolve 路径（用户操作 / abort / 会话清理）都发出 resolved 通知，
 *   渲染层据此兜底清横幅，杜绝「残留横幅里发反馈被静默丢弃」
 *
 * 收上游 #2018 后追加：计划文档必填（限定在会话私有 plan/ 目录）、缺文件在
 * sendToRenderer 之前直接 deny、批准前哈希复核。**没有 plan 目录的会话**（无工作区）
 * 不做这套校验，退回 #2018 之前的行为——否则模型永远满足不了必填项、被钉死在墙上。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentExitPlanService } from './agent-exit-plan-service'
import type { ExitPlanModeRequest } from '@canopy/shared'

function createService(): {
  service: AgentExitPlanService
  resolved: Array<{ sessionId: string; requestId: string }>
} {
  const service = new AgentExitPlanService()
  const resolved: Array<{ sessionId: string; requestId: string }> = []
  service.setResolvedNotifier((sessionId, requestId) => {
    resolved.push({ sessionId, requestId })
  })
  return { service, resolved }
}

function startRequest(service: AgentExitPlanService, sessionId = 'session-a'): {
  promise: ReturnType<AgentExitPlanService['handleExitPlanMode']>
  request: ExitPlanModeRequest
  controller: AbortController
} {
  const controller = new AbortController()
  let captured: ExitPlanModeRequest | null = null
  const promise = service.handleExitPlanMode(
    sessionId,
    { plan: '测试计划' },
    controller.signal,
    (request) => { captured = request },
  )
  if (!captured) throw new Error('未捕获到发往渲染层的请求')
  return { promise, request: captured, controller }
}

// ===== #2018 计划文档 fixture =====

let planRoot = ''
let planDir = ''
let planFilePath = ''
let outsideFilePath = ''

beforeAll(() => {
  planRoot = join(tmpdir(), `canopy-exit-plan-test-${Date.now()}`)
  planDir = join(planRoot, 'slug', 'session', '.context', 'plan')
  mkdirSync(planDir, { recursive: true })
  mkdirSync(join(planRoot, 'user-project'), { recursive: true })
  planFilePath = join(planDir, 'my-plan.md')
  outsideFilePath = join(planRoot, 'user-project', 'notes.md')
  writeFileSync(planFilePath, '# 计划\n1. 改 A\n2. 改 B\n')
  writeFileSync(outsideFilePath, '# 用户笔记\n')
})

afterAll(() => {
  rmSync(planRoot, { recursive: true, force: true })
})

/** 带 plan 目录上下文发起审批（#2018 口径：planFile 必填）。 */
function startRequestWithPlanDirectory(
  service: AgentExitPlanService,
  input: Record<string, unknown>,
  sessionId = 'session-plan',
): {
  promise: ReturnType<AgentExitPlanService['handleExitPlanMode']>
  request: ExitPlanModeRequest | null
  sentToRendererCount: number
  controller: AbortController
} {
  const controller = new AbortController()
  let captured: ExitPlanModeRequest | null = null
  let sentToRendererCount = 0
  const promise = service.handleExitPlanMode(
    sessionId,
    input,
    controller.signal,
    (request) => { captured = request; sentToRendererCount += 1 },
    { planDirectory: planDir },
  )
  return { promise, request: captured, sentToRendererCount, controller }
}

describe('AgentExitPlanService 计划审批', () => {
  test('Given 挂起的审批 When 用户提交修改意见 Then deny message 含反馈原文与流程指引', async () => {
    const { service, resolved } = createService()
    const { promise, request } = startRequest(service)

    const feedback = '请把文件名改成 feedback-received.md'
    const result = service.respondToExitPlanMode({
      requestId: request.requestId,
      action: 'feedback',
      feedback,
    })

    expect(result).toEqual({
      sessionId: 'session-a',
      targetMode: null,
      action: 'feedback',
      feedback,
    })
    const permission = await promise
    expect(permission.behavior).toBe('deny')
    if (permission.behavior !== 'deny') throw new Error('unreachable')
    // 反馈原文必须一字不差进入模型可见文本
    expect(permission.message).toContain(feedback)
    // 附带流程指引，模型收到同意语义时立即重提审批而不是直接动手撞墙
    expect(permission.message).toContain('ExitPlanMode')
    expect(permission.message).toContain('计划模式')
    // 用户操作路径也要发 resolved 通知（其他窗口/残留兜底一并清理）
    expect(resolved).toEqual([{ sessionId: 'session-a', requestId: request.requestId }])
  })

  test('Given 挂起的审批 When 用户批准 Then 返回 allow 且目标模式切换为完全自动', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service)

    const result = service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_bypass' })

    expect(result?.targetMode).toBe('bypassPermissions')
    expect(result?.action).toBe('approve_bypass')
    const permission = await promise
    expect(permission.behavior).toBe('allow')
  })

  test('Given 挂起的审批 When 用户拒绝 Then deny 固定文案且不切模式', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service)

    const result = service.respondToExitPlanMode({ requestId: request.requestId, action: 'deny' })

    expect(result?.targetMode).toBeNull()
    const permission = await promise
    expect(permission).toEqual({ behavior: 'deny', message: '用户拒绝了计划' })
  })

  test('Given 审批已不存在 When 响应 Then 返回 null（IPC 层据此告知用户而非静默吞掉）', () => {
    const { service, resolved } = createService()

    const result = service.respondToExitPlanMode({
      requestId: 'not-exist',
      action: 'feedback',
      feedback: '这条意见不该消失',
    })

    expect(result).toBeNull()
    expect(resolved).toEqual([])
  })

  test('Given 挂起的审批 When AbortSignal 触发 Then deny 中止文案且发出 resolved 通知', async () => {
    const { service, resolved } = createService()
    const { promise, request, controller } = startRequest(service)

    controller.abort()

    const permission = await promise
    expect(permission).toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(resolved).toEqual([{ sessionId: 'session-a', requestId: request.requestId }])
    expect(service.hasPendingRequest(request.requestId)).toBe(false)
  })

  test('Given 挂起的审批 When 会话清理 Then deny 会话结束文案且发出 resolved 通知', async () => {
    const { service, resolved } = createService()
    const { promise, request } = startRequest(service, 'session-b')

    service.clearSessionPending('session-b')

    const permission = await promise
    expect(permission).toEqual({ behavior: 'deny', message: '会话已结束' })
    expect(resolved).toEqual([{ sessionId: 'session-b', requestId: request.requestId }])
  })

  test('Given 请求先被 abort When 用户再从残留横幅响应 Then 返回 null 且不重复通知', async () => {
    const { service, resolved } = createService()
    const { promise, request, controller } = startRequest(service)

    controller.abort()
    await promise
    const secondResponse = service.respondToExitPlanMode({
      requestId: request.requestId,
      action: 'feedback',
      feedback: '迟到的意见',
    })

    expect(secondResponse).toBeNull()
    expect(resolved.length).toBe(1)
  })

  test('Given 挂起与不存在两种请求 When 查询 hasPendingRequest Then 判定准确', () => {
    const { service } = createService()
    const { request } = startRequest(service)

    expect(service.hasPendingRequest(request.requestId)).toBe(true)
    expect(service.hasPendingRequest('ghost')).toBe(false)
  })

  test('Given 未注入 resolvedNotifier When 各路径 resolve Then 不抛错（通知是增强不是依赖）', async () => {
    const service = new AgentExitPlanService()
    const controller = new AbortController()
    let captured: ExitPlanModeRequest | null = null
    const promise = service.handleExitPlanMode('session-c', {}, controller.signal, (r) => { captured = r })

    expect(() => service.respondToExitPlanMode({
      requestId: captured!.requestId,
      action: 'deny',
    })).not.toThrow()
    await promise
  })
})

describe('口头批准的反馈记录（userApproved 的谎报门槛）', () => {
  test('Given 用户刚提交过反馈 When 消费记录 Then 首次 true、二次 false（一次性语义）', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service, 'session-v')
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'feedback', feedback: '执行' })
    await promise

    expect(service.consumeRecentFeedback('session-v')).toBe(true)
    expect(service.consumeRecentFeedback('session-v')).toBe(false)
  })

  test('Given 从未有过反馈的会话 When 消费记录 Then false（模型凭空声明 userApproved 不放行）', () => {
    const { service } = createService()
    expect(service.consumeRecentFeedback('ghost-session')).toBe(false)
  })

  test('Given 反馈已超过有效窗口 When 消费 Then false（久远反馈不能翻旧账）', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service, 'session-w')
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'feedback', feedback: '可以' })
    await promise

    const beyondWindow = Date.now() + AgentExitPlanService.USER_APPROVAL_FEEDBACK_WINDOW_MS + 1
    expect(service.consumeRecentFeedback('session-w', beyondWindow)).toBe(false)
  })

  test('Given 拒绝或批准操作 When 检查记录 Then 不产生反馈记录（只有 feedback 才算）', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service, 'session-x')
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'deny' })
    await promise

    expect(service.consumeRecentFeedback('session-x')).toBe(false)
  })

  test('Given 会话清理（run 结束） When 消费记录 Then false（口头批准限当前 run 内）', async () => {
    const { service } = createService()
    const { promise, request } = startRequest(service, 'session-y')
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'feedback', feedback: '删了吧' })
    await promise

    service.clearSessionPending('session-y')
    expect(service.consumeRecentFeedback('session-y')).toBe(false)
  })
})

describe('计划文档必填与哈希复核（收上游 #2018，维护者 2026-09-08 拍板）', () => {
  test('Given 会话有 plan 目录但模型没传 planFile When 提交审批 Then 直接 deny 且不弹横幅', async () => {
    const { service, resolved } = createService()
    const { promise, request, sentToRendererCount } = startRequestWithPlanDirectory(service, { plan: '只有摘要' })

    // 用户看不到一个没有计划正文可看的横幅
    expect(request).toBeNull()
    expect(sentToRendererCount).toBe(0)
    expect(resolved).toEqual([])

    const permission = await promise
    expect(permission.behavior).toBe('deny')
    if (permission.behavior !== 'deny') throw new Error('unreachable')
    // 弱模型撞墙防线：deny 文案必须给出真实 plan 目录与两步重提指引（行动指引体系）
    expect(permission.message).toContain(planDir)
    expect(permission.message).toContain('Write')
    expect(permission.message).toContain('planFile')
    expect(permission.message).toContain('ExitPlanMode')
  })

  test('Given planFile 指向用户项目而非 plan 目录 When 提交审批 Then 直接 deny 且不弹横幅', async () => {
    const { service } = createService()
    const { promise, request, sentToRendererCount } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: outsideFilePath },
    )

    expect(request).toBeNull()
    expect(sentToRendererCount).toBe(0)
    const permission = await promise
    expect(permission.behavior).toBe('deny')
    if (permission.behavior !== 'deny') throw new Error('unreachable')
    // 拒绝理由里回显模型传错的那个路径，便于它自己纠正
    expect(permission.message).toContain(outsideFilePath)
    expect(permission.message).toContain(planDir)
  })

  test('Given planFile 是 plan 目录内的真实 .md When 提交审批 Then 请求带 planDocument 送到渲染层', async () => {
    const { service } = createService()
    const { promise, request, sentToRendererCount, controller } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: planFilePath },
    )

    expect(sentToRendererCount).toBe(1)
    expect(request?.planDocument?.displayName).toBe('my-plan.md')
    expect(request?.planDocument?.contentHash).toMatch(/^[0-9a-f]{64}$/)

    controller.abort()
    await promise
  })

  test('Given 审批期间计划文件未变 When 用户批准 Then 正常 allow 并切换完全自动模式', async () => {
    const { service } = createService()
    const { promise, request } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: planFilePath },
      'session-ok',
    )

    const result = service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' })
    expect(result?.targetMode).toBe('bypassPermissions')
    const permission = await promise
    expect(permission.behavior).toBe('allow')
  })

  test('Given 审批期间计划文件被改写 When 用户批准 Then 哈希复核失败改判 deny 且不切模式', async () => {
    const { service, resolved } = createService()
    const swapPath = join(planDir, 'swap-plan.md')
    writeFileSync(swapPath, '# 用户看到的计划\n')
    const { promise, request } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: swapPath },
      'session-swap',
    )

    // 用户还在看横幅时文件被换掉
    writeFileSync(swapPath, '# 偷换后的计划：顺手删库\n')
    const result = service.respondToExitPlanMode({ requestId: request!.requestId, action: 'approve_bypass' })

    expect(result?.targetMode).toBeNull()
    const permission = await promise
    expect(permission.behavior).toBe('deny')
    if (permission.behavior !== 'deny') throw new Error('unreachable')
    expect(permission.message).toContain('swap-plan.md')
    expect(permission.message).toContain('ExitPlanMode')
    // 改判后横幅同样要清掉，否则用户对着一个已失效的审批继续操作
    expect(resolved).toEqual([{ sessionId: 'session-swap', requestId: request!.requestId }])
    expect(service.hasPendingRequest(request!.requestId)).toBe(false)
    rmSync(swapPath, { force: true })
  })

  test('Given 带计划文档的审批 When 用户提交修改意见 Then 不做哈希复核、反馈原文照常直达模型', async () => {
    const { service } = createService()
    const { promise, request } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: planFilePath },
      'session-fb',
    )

    const feedback = '第二步不要动数据库'
    service.respondToExitPlanMode({ requestId: request!.requestId, action: 'feedback', feedback })
    const permission = await promise
    expect(permission.behavior).toBe('deny')
    if (permission.behavior !== 'deny') throw new Error('unreachable')
    expect(permission.message).toContain(feedback)
    // 口头批准门槛不受 #2018 影响：反馈仍产生一次性记录
    expect(service.consumeRecentFeedback('session-fb')).toBe(true)
    expect(service.consumeRecentFeedback('session-fb')).toBe(false)
  })

  test('Given 带计划文档的审批 When AbortSignal 触发 Then resolved 通知仍然发出', async () => {
    const { service, resolved } = createService()
    const { promise, request, controller } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: planFilePath },
      'session-abort',
    )

    controller.abort()
    const permission = await promise
    expect(permission).toEqual({ behavior: 'deny', message: '操作已中止' })
    expect(resolved).toEqual([{ sessionId: 'session-abort', requestId: request!.requestId }])
  })

  test('Given 带计划文档的审批 When 会话清理 Then resolved 通知仍然发出', async () => {
    const { service, resolved } = createService()
    const { promise, request } = startRequestWithPlanDirectory(
      service,
      { plan: '摘要', planFile: planFilePath },
      'session-clear',
    )

    service.clearSessionPending('session-clear')
    const permission = await promise
    expect(permission).toEqual({ behavior: 'deny', message: '会话已结束' })
    expect(resolved).toEqual([{ sessionId: 'session-clear', requestId: request!.requestId }])
  })

  test('Given 无工作区会话（拿不到 plan 目录） When 不传 planFile 提交审批 Then 照常弹横幅、不因必填被钉死', async () => {
    const { service } = createService()
    // 不传 planDirectory —— 等价于会话没有工作区
    const { promise, request } = startRequest(service, 'session-no-ws')

    expect(request.planDocument).toBeUndefined()
    service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_bypass' })
    const permission = await promise
    expect(permission.behavior).toBe('allow')
  })
})
