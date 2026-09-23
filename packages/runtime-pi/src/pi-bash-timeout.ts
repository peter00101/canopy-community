/**
 * Pi bash 工具的默认超时兜底（纯逻辑，可测）。
 *
 * Pi 内置 bash 工具支持 `timeout`（秒）参数、超时时把「Command timed out after N seconds」当作工具结果
 * 返回给模型——但**默认没有超时**：模型没主动传就无限阻塞。用户实测 Agent 跟等一个永不到达的外部
 * 管道终态 31 分 47 秒。第一层（system prompt「等待与长任务」纪律）
 * 只能靠模型自觉；这里是第三层：模型没传 timeout 时注入一个保守默认值，超时后模型拿到明确的
 * 超时结果自行决策（重跑并显式给更大的 timeout / 改短轮询 / 询问用户），而不是整段会话卡死。
 * 默认 10 分钟：与提示词里「同一状态累计约 10 分钟无进展则停止陪等」一致，正常构建/测试/安装极少超过；
 * 真需要更久的命令由模型显式传 timeout（描述里已告知）。
 */

export const DEFAULT_BASH_TIMEOUT_SECONDS = 600

/** 我们只关心 bash 参数里的 timeout；其余字段原样透传 */
export interface BashToolParamsLike {
  timeout?: number
  [key: string]: unknown
}

/**
 * 最小化的工具定义形状：只依赖 name / description / execute 三个字段，避免与 Pi 的泛型签名耦合。
 * execute 用方法签名（参数双变）而非属性箭头类型，这样 Pi 的 `{ command; timeout? }` 参数能对上。
 */
export interface BashToolDefinitionLike {
  name: string
  description: string
  execute(toolCallId: string, params: BashToolParamsLike, ...rest: unknown[]): Promise<unknown>
}

/** 模型未显式给出（undefined / null / 非正数）时补默认；显式给的合法值原样保留 */
export function applyDefaultBashTimeout<TParams extends BashToolParamsLike>(
  params: TParams,
  defaultSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): TParams {
  const timeout = params.timeout
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) return params
  return { ...params, timeout: defaultSeconds }
}

/** 给工具描述追加默认超时说明，模型才知道「不传也会在 N 秒后被终止」并主动为长命令传更大值 */
export function describeDefaultBashTimeout(description: string, defaultSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS): string {
  const minutes = Math.round(defaultSeconds / 60)
  return `${description} If timeout is omitted it defaults to ${defaultSeconds} seconds (${minutes} minutes) and the command is terminated with a timeout result; pass a larger explicit timeout for legitimately long-running commands, and never rely on the tool to wait indefinitely.`
}

/**
 * 包装 Pi 的 bash 工具定义：execute 前补默认 timeout，description 追加说明。
 * 只对 name === 'bash' 生效，其他工具原样返回，调用方可以无脑 map。
 */
export function withDefaultBashTimeout<TDefinition extends BashToolDefinitionLike>(
  definition: TDefinition,
  defaultSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): TDefinition {
  if (definition.name !== 'bash') return definition
  const originalExecute = definition.execute
  const wrapped: BashToolDefinitionLike = {
    ...definition,
    description: describeDefaultBashTimeout(definition.description, defaultSeconds),
    execute(toolCallId: string, params: BashToolParamsLike, ...rest: unknown[]): Promise<unknown> {
      return originalExecute.call(definition, toolCallId, applyDefaultBashTimeout(params, defaultSeconds), ...rest)
    },
  }
  return wrapped as TDefinition
}
