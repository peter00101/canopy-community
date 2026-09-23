/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 核心职责：
 * - 拦截 ExitPlanMode 工具调用
 * - 解析 allowedPrompts 与经校验的计划文档，发送到渲染进程展示审批 UI
 * - 等待用户选择（批准/拒绝/反馈），返回对应 PermissionResult
 * - 根据用户选择切换权限模式
 *
 * 复用 AskUserService 的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ExitPlanModeAction,
  ExitPlanAllowedPrompt,
  ExitPlanDocument,
  AppPermissionMode,
} from '@canopy/shared'
import { buildExitPlanFeedbackMessage } from './agent-plan-mode-guidance'
import {
  buildPlanDocumentChangedDenyMessage,
  buildPlanFileRequiredDenyMessage,
  isPlanDocumentCurrent,
  resolvePlanDocument,
} from './agent-plan-file-policy'

/** ExitPlanMode 审批结果（扩展 SDK PermissionResult，附加 targetMode） */
export type ExitPlanPermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
  /** 用户选择的目标权限模式 */
  targetMode?: AppPermissionMode
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 ExitPlanMode 请求 */
interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => void
  request: ExitPlanModeRequest
  toolInput: Record<string, unknown>
  /** 审批前复核路径归属与内容版本，防止符号链接或文件替换绕过初始校验。 */
  planDirectory?: string
}

/** handleExitPlanMode 的可选上下文（由编排层按会话注入） */
export interface ExitPlanModeOptions {
  /**
   * 当前会话的 plan/ 目录绝对路径。
   *
   * **有值时**计划文档为必填：缺失或校验不过直接 deny，不弹横幅（上游 #2018 口径）。
   * **无值时**（会话没有工作区，plan/ 目录无处安放）退回 #2018 之前的行为：照常弹横幅、
   * 不带 planDocument——否则这类会话里模型永远无法满足必填项，会被钉死在墙上。
   */
  planDirectory?: string
}

/** ExitPlanMode 审批结果回调（通知编排层切换权限模式） */
export interface ExitPlanModeCallbacks {
  /** 切换权限模式 */
  onPermissionModeChange: (mode: AppPermissionMode) => void
}

/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 单例模式，管理所有会话的 ExitPlanMode 请求。
 */
export class AgentExitPlanService {
  /** 待处理的请求 Map（requestId → PendingExitPlan） */
  private pendingRequests = new Map<string, PendingExitPlan>()

  /**
   * 请求被 resolve（用户操作 / abort / 会话清理）时的通知回调。
   * 渲染层依赖它兜底清掉横幅之外被处理的残留请求——缺了它，横幅会挂着一个
   * 已失效的审批，用户在里面发反馈会被静默吞掉（permission_resolved 同族病）。
   */
  private resolvedNotifier: ((sessionId: string, requestId: string) => void) | null = null

  /** 注入 resolved 通知回调（由 agent-service 初始化时接到 eventBus） */
  setResolvedNotifier(notifier: (sessionId: string, requestId: string) => void): void {
    this.resolvedNotifier = notifier
  }

  private notifyResolved(sessionId: string, requestId: string): void {
    try {
      this.resolvedNotifier?.(sessionId, requestId)
    } catch (error) {
      console.warn(`[ExitPlanService] resolved 通知失败: requestId=${requestId}`, error)
    }
  }

  /** 指定请求是否仍在等待处理 */
  hasPendingRequest(requestId: string): boolean {
    return this.pendingRequests.has(requestId)
  }

  /**
   * 每会话最近一次用户反馈的时间戳（口头批准的谎报门槛）。
   * 模型带 userApproved=true 重提计划时，必须消费到一条近期反馈记录才放行——
   * 从未有过用户反馈的会话里，模型不可能拿到口头批准。
   */
  private recentFeedbackAt = new Map<string, number>()

  /** 口头批准的反馈有效窗口（毫秒）：超过视为过期，防止久远反馈被翻旧账 */
  static readonly USER_APPROVAL_FEEDBACK_WINDOW_MS = 30 * 60 * 1000

  /**
   * 一次性消费该会话的近期反馈记录：存在且未过期返回 true 并清除，否则 false。
   * 一次性语义：一条反馈最多支撑一次口头批准，防模型在后续 run 里反复自批。
   */
  consumeRecentFeedback(sessionId: string, now = Date.now()): boolean {
    const at = this.recentFeedbackAt.get(sessionId)
    if (at === undefined) return false
    this.recentFeedbackAt.delete(sessionId)
    return now - at <= AgentExitPlanService.USER_APPROVAL_FEEDBACK_WINDOW_MS
  }

  /**
   * 处理 ExitPlanMode 工具调用
   *
   * 解析 allowedPrompts 与计划 Markdown 工件，发送到渲染进程，阻塞等待用户选择。
   * 计划文档校验不过时**在 sendToRenderer 之前**直接 deny——用户不会看到一个
   * 没有计划正文可看的横幅，模型则拿到带 plan/ 目录真实路径的重提指引。
   */
  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void,
    options?: ExitPlanModeOptions,
  ): Promise<ExitPlanPermissionResult> {
    console.log(`[ExitPlanService] handleExitPlanMode 开始: sessionId=${sessionId}, signal.aborted=${signal.aborted}`)
    const allowedPrompts = this.parseAllowedPrompts(input)
    const planDirectory = options?.planDirectory

    let planDocument: ExitPlanDocument | undefined
    if (planDirectory) {
      planDocument = resolvePlanDocument(input.planFile, planDirectory)
      if (!planDocument) {
        const reason = typeof input.planFile === 'string' && input.planFile.trim()
          ? `planFile \`${input.planFile.trim()}\` 无法作为本次审批的计划文档（必须是当前会话 plan/ 目录内、真实存在、不经符号链接、不超过 1 MB 的 .md 文件）`
          : '提交计划审批时没有提供 planFile：用户需要在右侧只读预览完整的 Markdown 计划，缺少它审批无法进行'
        console.warn(`[ExitPlanService] 计划文档校验未通过，直接拒绝: sessionId=${sessionId}`)
        return Promise.resolve({
          behavior: 'deny' as const,
          message: buildPlanFileRequiredDenyMessage(planDirectory, reason),
        })
      }
    }

    const request: ExitPlanModeRequest = {
      requestId: randomUUID(),
      sessionId,
      toolInput: input,
      allowedPrompts,
      planDocument,
    }

    sendToRenderer(request)

    return new Promise<ExitPlanPermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request, toolInput: input, planDirectory })

      signal.addEventListener('abort', () => {
        if (this.pendingRequests.has(request.requestId)) {
          console.warn(`[ExitPlanService] AbortSignal 触发，deny: requestId=${request.requestId}`)
          this.pendingRequests.delete(request.requestId)
          resolve({ behavior: 'deny', message: '操作已中止' })
          this.notifyResolved(sessionId, request.requestId)
        }
      }, { once: true })
    })
  }

  /**
   * 响应 ExitPlanMode 请求（由 IPC handler 调用）
   *
   * @returns { sessionId, targetMode, action, feedback } 用于通知编排层与落盘反馈；未找到返回 null
   */
  respondToExitPlanMode(response: ExitPlanModeResponse): {
    sessionId: string
    targetMode: AppPermissionMode | null
    action: ExitPlanModeAction
    feedback?: string
    /** 批准被哈希复核否掉（计划文件在挂起期间变了）。渲染层据此告诉用户，别静默吞。 */
    planDocumentChanged?: boolean
  } | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId
    this.pendingRequests.delete(response.requestId)

    let targetMode: AppPermissionMode | null = null
    switch (response.action) {
      case 'approve_bypass': {
        // 批准前复核：用户批的必须是他刚才看到的那一版计划。
        // 文件在审批挂起期间被改写/移走/换成符号链接时，本次批准作废，模型按指引重提。
        if (pending.request.planDocument
          && !isPlanDocumentCurrent(pending.request.planDocument, pending.planDirectory)) {
          console.warn(`[ExitPlanService] 计划文档已变更，批准作废: requestId=${response.requestId}`)
          pending.resolve({
            behavior: 'deny' as const,
            message: buildPlanDocumentChangedDenyMessage(pending.request.planDocument.displayName),
          })
          this.notifyResolved(sessionId, response.requestId)
          return { sessionId, targetMode: null, action: response.action, feedback: response.feedback, planDocumentChanged: true }
        }
        // 批准 + 切换到完全自动模式
        pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'bypassPermissions',
        })
        targetMode = 'bypassPermissions'
        break
      }
      case 'deny': {
        // 拒绝计划
        pending.resolve({
          behavior: 'deny' as const,
          message: '用户拒绝了计划',
        })
        break
      }
      case 'feedback': {
        // 用户提供反馈：通过 deny message 传给模型（Pi 把它作为工具错误文本给到下一轮）。
        // 反馈的用户可见形态（上屏 + 落盘）由 IPC handler 负责，这里只管模型侧通道。
        // 裸反馈文本会让模型自行发挥（把「删了吧」当成已批准直接动手撞计划模式的墙），
        // 统一包装处理规则：改意见→修订重提；同意→带 userApproved 重提直接获批。
        this.recentFeedbackAt.set(sessionId, Date.now())
        pending.resolve({
          behavior: 'deny' as const,
          message: buildExitPlanFeedbackMessage(response.feedback ?? '用户要求修改计划'),
        })
        break
      }
      default: {
        pending.resolve({
          behavior: 'deny' as const,
          message: '未知操作',
        })
        break
      }
    }

    this.notifyResolved(sessionId, response.requestId)
    return { sessionId, targetMode, action: response.action, feedback: response.feedback }
  }

  /**
   * 获取当前所有待处理的 ExitPlanMode 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理请求
   */
  clearSessionPending(sessionId: string): void {
    this.recentFeedbackAt.delete(sessionId)
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
        this.notifyResolved(sessionId, requestId)
      }
    }
  }

  /**
   * 从工具输入中解析 allowedPrompts
   */
  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    const raw = input.allowedPrompts
    if (!Array.isArray(raw)) return []

    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item): ExitPlanAllowedPrompt => ({
        tool: typeof item.tool === 'string' ? item.tool as 'Bash' : 'Bash',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      }))
      .filter((item) => item.prompt.length > 0)
  }
}

/** 全局 ExitPlanMode 服务实例 */
export const exitPlanService = new AgentExitPlanService()
