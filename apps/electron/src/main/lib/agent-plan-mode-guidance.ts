/**
 * 计划模式给模型的行动指引文案
 *
 * 维护者实测暴露的模型行为缺陷：用户在审批反馈里说「删了吧」，模型把它当成批准
 * 直接去执行写操作 → 被计划模式拦截 → 反复撞墙、长时间 thinking 无产出。
 * 根因是拦截文案与反馈文本都没告诉模型「下一步该走什么流程」。
 *
 * 两条原则：
 * - 拦截 deny 必须附带行动指引（重提 ExitPlanMode），模型被拦后立刻知道正道；
 * - 反馈转交模型时包装处理规则，同意语义 → 立即重提审批而不是直接动手。
 */

/** 计划模式拦截写操作时的行动指引（追加在各 deny 文案末尾） */
export const PLAN_MODE_DENY_GUIDANCE =
  '你仍处于计划模式，不要再直接尝试任何写操作（都会被拒绝）。正确做法：立即调用 ExitPlanMode 重新提交计划，等用户在审批横幅上点击批准后再执行。'

/** 计划模式写操作拦截的完整 deny 文案 */
export const PLAN_MODE_WRITE_DENY_MESSAGE = `计划模式下不允许执行写操作。${PLAN_MODE_DENY_GUIDANCE}`

/**
 * 用户对计划审批的反馈 → 模型可执行的处理规则。
 * 反馈经 ExitPlanMode 的工具错误通道传给模型；裸文本会让模型自行发挥
 * （把「删了吧」当成已获批准直接动手），必须附上流程指引。
 *
 * 同意语义走「口头批准」通道——模型重提 ExitPlanMode 时带
 * userApproved=true，主进程校验该会话确实刚有过用户反馈后直接放行执行，
 * 用户无需再点横幅（维护者拍板：说了执行就执行）。
 */
export function buildExitPlanFeedbackMessage(feedback: string): string {
  return [
    `用户对你提交的计划给出了答复：${feedback}`,
    '',
    '处理规则（你仍处于计划模式，任何直接写操作都会被拒绝）：',
    '- 答复是修改意见 → 按意见修订计划，再次调用 ExitPlanMode 提交新计划（不要设置 userApproved）。',
    '- 答复明确表示同意/批准（如「可以」「执行」「删了吧」）→ 立即再次调用 ExitPlanMode 提交同一计划并设置 userApproved: true，计划将直接获批、随后你即可执行。',
    '- 答复含糊或态度不明 → 视为修改意见处理，绝不可设置 userApproved。',
    '不要在计划模式下直接尝试执行任何写操作。',
  ].join('\n')
}
