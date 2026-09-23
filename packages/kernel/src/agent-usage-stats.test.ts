import { describe, expect, test } from 'bun:test'
import {
  addTotals,
  aggregateAgentUsage,
  collectUsageFromContent,
  createEmptyTotals,
  isWithinRange,
  localDayKey,
  parseUsageLine,
  totalTokensOf,
  type UsageTotals,
} from './agent-usage-stats'

/** 造一条 assistant 落盘行，字段名与真实 JSONL 一致（实测自 12 个真实会话）。 */
function assistantLine(
  model: string | null,
  usage: Record<string, number>,
  extra: { createdAt?: number; provider?: string; channelId?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [], ...(model === null ? {} : { model }), usage },
    parent_tool_use_id: null,
    ...(extra.createdAt !== undefined ? { _createdAt: extra.createdAt } : {}),
    ...(extra.provider !== undefined ? { _channelProvider: extra.provider } : {}),
    ...(extra.channelId !== undefined ? { _channelId: extra.channelId } : {}),
  })
}

/** 用本地时区构造一个确定的时刻，避免测试随运行机器时区飘 */
function localTime(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime()
}

describe('parseUsageLine：从 JSONL 行提取 assistant 用量', () => {
  test('Given 带 model 与 usage 的 assistant 行 When 解析 Then 四项 token 与调用数都对', () => {
    const line = assistantLine('deepseek-v4-pro', {
      input_tokens: 460,
      output_tokens: 206,
      cache_read_input_tokens: 17920,
      cache_creation_input_tokens: 32,
    })
    expect(parseUsageLine(line)).toEqual({
      modelId: 'deepseek-v4-pro',
      usage: { inputTokens: 460, outputTokens: 206, cacheReadTokens: 17920, cacheCreationTokens: 32, calls: 1 },
    })
  })

  test('Given 用户消息与工具结果行 When 解析 Then 一律返回 null', () => {
    expect(parseUsageLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull()
    expect(parseUsageLine(JSON.stringify({ type: 'result', usage: { input_tokens: 100 } }))).toBeNull()
  })

  test('Given result 行带 usage When 解析 Then 不计入——它是单轮最后一次调用值，累加会低估', () => {
    // 实测：同批会话 assistant 106 条 / result 40 条，result.usage 等于该轮最后一次 assistant
    const line = JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 18173, output_tokens: 49 } })
    expect(parseUsageLine(line)).toBeNull()
  })

  test('Given 没有 usage 的 assistant When 解析 Then 返回 null', () => {
    expect(parseUsageLine(JSON.stringify({ type: 'assistant', message: { content: [], model: 'x' } }))).toBeNull()
  })

  test('Given 四项全 0 的空壳 assistant When 解析 Then 返回 null，不虚增调用次数', () => {
    const line = assistantLine('gpt-5.5', { input_tokens: 0, output_tokens: 0 })
    expect(parseUsageLine(line)).toBeNull()
  })

  test('Given 缺 model 字段 When 解析 Then 归入「未记录模型」而不是丢弃用量', () => {
    const parsed = parseUsageLine(assistantLine(null, { input_tokens: 120, output_tokens: 8 }))
    expect(parsed?.modelId).toBe('(未记录模型)')
    expect(parsed?.usage.inputTokens).toBe(120)
  })

  test('Given 落盘被截断的半行 When 解析 Then 返回 null 而不是抛错', () => {
    expect(parseUsageLine('{"type":"assistant","message":{"usage":{"input_tok')).toBeNull()
  })

  test('Given 负数或非数字的 token 值 When 解析 Then 按 0 处理', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 100 } },
    })
    expect(parseUsageLine(line)?.usage).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, cacheCreationTokens: 0, calls: 1,
    })
  })

  test('Given 不含 assistant 标记的长行 When 解析 Then 走字符串预筛直接跳过', () => {
    expect(parseUsageLine('{"type":"user","message":{"content":"' + 'x'.repeat(5000) + '"}}')).toBeNull()
  })
})

describe('collectUsageFromContent：汇总一份会话正文', () => {
  test('Given 多条不同模型的 assistant When 汇总 Then 总量与按模型明细都正确', () => {
    const content = [
      assistantLine('gpt-5.5', { input_tokens: 100, output_tokens: 10 }),
      assistantLine('deepseek-v4-pro', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 50 }),
      assistantLine('gpt-5.5', { input_tokens: 300, output_tokens: 30 }),
      JSON.stringify({ type: 'user', message: { content: '忽略我' } }),
    ].join('\n')

    const { totals, byModel } = collectUsageFromContent(content)
    expect(totals).toEqual({ inputTokens: 600, outputTokens: 60, cacheReadTokens: 50, cacheCreationTokens: 0, calls: 3 })
    expect(byModel.get('gpt-5.5')).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 2 })
    expect(byModel.get('deepseek-v4-pro')?.calls).toBe(1)
  })

  test('Given 含空行与尾随换行的正文 When 汇总 Then 不受影响', () => {
    const content = '\n' + assistantLine('m', { input_tokens: 5 }) + '\n\n'
    expect(collectUsageFromContent(content).totals.calls).toBe(1)
  })

  test('Given 空正文 When 汇总 Then 得到零值且不抛错', () => {
    const { totals, byModel } = collectUsageFromContent('')
    expect(totals).toEqual(createEmptyTotals())
    expect(byModel.size).toBe(0)
  })
})

describe('时间维度：本地时区分组与范围过滤', () => {
  test('Given 消息带 _createdAt 与 _channelProvider When 解析 Then 一并提取出来', () => {
    const at = localTime(2026, 9, 9, 21)
    const parsed = parseUsageLine(assistantLine('m', { input_tokens: 10 }, { createdAt: at, provider: 'deepseek' }))
    expect(parsed?.createdAt).toBe(at)
    expect(parsed?.provider).toBe('deepseek')
  })

  test('Given 晚上 9 点的调用 When 求日期键 Then 归本地当天，而不是 UTC 的第二天', () => {
    // 东八区 21:00 的 UTC 时间已经是次日 13:00 前一天…用 toISOString 会错开一天
    const at = localTime(2026, 9, 9, 21)
    expect(localDayKey(at)).toBe('2026-09-09')
    const d = new Date(at)
    expect(localDayKey(at)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  })

  test('Given 闭区间范围 When 判定 Then 两端都算在内、区间外排除', () => {
    const since = localTime(2026, 9, 8)
    const until = localTime(2026, 9, 10)
    expect(isWithinRange(since, { since, until })).toBe(true)
    expect(isWithinRange(until, { since, until })).toBe(true)
    expect(isWithinRange(since - 1, { since, until })).toBe(false)
    expect(isWithinRange(until + 1, { since, until })).toBe(false)
  })

  test('Given 没有时间戳的老记录 When 有筛选 Then 排除；无筛选 Then 计入', () => {
    expect(isWithinRange(undefined, {})).toBe(true)
    expect(isWithinRange(undefined, { since: 1 })).toBe(false)
  })

  test('Given 跨三天的会话 When 按范围筛 Then 只统计范围内那几天', () => {
    const content = [
      assistantLine('m', { input_tokens: 100 }, { createdAt: localTime(2026, 9, 7), provider: 'deepseek' }),
      assistantLine('m', { input_tokens: 200 }, { createdAt: localTime(2026, 9, 8), provider: 'deepseek' }),
      assistantLine('m', { input_tokens: 400 }, { createdAt: localTime(2026, 9, 9), provider: 'openai-responses' }),
    ].join('\n')

    const all = collectUsageFromContent(content)
    expect(all.totals.inputTokens).toBe(700)
    expect([...all.byDay.keys()].sort()).toEqual(['2026-09-07', '2026-09-08', '2026-09-09'])
    // 没有 _channelId 的记录按 provider 归堆，key 前缀标明这是退化形态
    expect([...all.byChannel.keys()].sort()).toEqual(['provider:deepseek', 'provider:openai-responses'])

    const recent = collectUsageFromContent(content, { since: localTime(2026, 9, 8) })
    expect(recent.totals.inputTokens).toBe(600)
    expect(recent.totals.calls).toBe(2)
    expect([...recent.byDay.keys()].sort()).toEqual(['2026-09-08', '2026-09-09'])
  })

  test('Given 已筛掉大部分记录 When 汇总 Then 时间跨度仍反映全量，供 UI 决定可选范围', () => {
    const content = [
      assistantLine('m', { input_tokens: 100 }, { createdAt: localTime(2026, 9, 1) }),
      assistantLine('m', { input_tokens: 100 }, { createdAt: localTime(2026, 9, 9) }),
    ].join('\n')
    const filtered = collectUsageFromContent(content, { since: localTime(2026, 9, 9) })
    expect(filtered.totals.calls).toBe(1)
    expect(filtered.earliestAt).toBe(localTime(2026, 9, 1))
    expect(filtered.latestAt).toBe(localTime(2026, 9, 9))
  })

  test('Given 缺 _channelProvider 的记录 When 汇总 Then 归入「未记录渠道」而不是丢弃', () => {
    const content = assistantLine('m', { input_tokens: 50 }, { createdAt: localTime(2026, 9, 9) })
    const entry = collectUsageFromContent(content).byChannel.get('provider:(未记录渠道)')
    expect(entry?.totals.inputTokens).toBe(50)
    expect(entry?.channelId).toBeUndefined()
  })

  test('Given 带 _channelId 的记录 When 汇总 Then 按渠道实例分组并保留 id 供 UI 查名字', () => {
    const content = [
      assistantLine('m', { input_tokens: 100 }, { provider: 'deepseek', channelId: 'ch-a' }),
      assistantLine('m', { input_tokens: 200 }, { provider: 'deepseek', channelId: 'ch-b' }),
      assistantLine('m', { input_tokens: 400 }, { provider: 'deepseek', channelId: 'ch-a' }),
    ].join('\n')
    const byChannel = collectUsageFromContent(content).byChannel
    expect(byChannel.get('ch-a')?.totals.inputTokens).toBe(500)
    expect(byChannel.get('ch-a')?.channelId).toBe('ch-a')
    expect(byChannel.get('ch-b')?.totals.calls).toBe(1)
  })

  test('Given 同一 provider 下既有带 id 又有不带 id 的记录 When 汇总 Then 分成两行，不混为一谈', () => {
    // 早期记录没有 channelId，无法确认属于哪个实例，合并进去会张冠李戴
    const content = [
      assistantLine('m', { input_tokens: 100 }, { provider: 'deepseek', channelId: 'ch-a' }),
      assistantLine('m', { input_tokens: 200 }, { provider: 'deepseek' }),
    ].join('\n')
    const byChannel = collectUsageFromContent(content).byChannel
    expect([...byChannel.keys()].sort()).toEqual(['ch-a', 'provider:deepseek'])
  })
})

describe('缓存读取 / 缓存写入：各维度口径一致', () => {
  /** 一份跨两天、两个模型、两个渠道的会话，缓存读写数字互不相同，方便逐项核对 */
  function cacheSessionContent(): string {
    return [
      assistantLine('deepseek-v4-pro', {
        input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5,
      }, { createdAt: localTime(2026, 9, 8), provider: 'deepseek', channelId: 'ch-ds' }),
      assistantLine('gpt-5.5', {
        input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0,
      }, { createdAt: localTime(2026, 9, 9), provider: 'openai-responses', channelId: 'ch-tree' }),
      assistantLine('deepseek-v4-pro', {
        input_tokens: 400, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 70,
      }, { createdAt: localTime(2026, 9, 9), provider: 'deepseek', channelId: 'ch-ds' }),
    ].join('\n')
  }

  test('给定带缓存读写的多条记录 当汇总单个会话 则总览、按日期、按模型、按渠道的缓存字段各自求和都等于总计', () => {
    const { totals, byModel, byDay, byChannel } = collectUsageFromContent(cacheSessionContent())
    expect(totals).toEqual({ inputTokens: 700, outputTokens: 70, cacheReadTokens: 4000, cacheCreationTokens: 75, calls: 3 })

    expect(byModel.get('deepseek-v4-pro')).toEqual({
      inputTokens: 500, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 75, calls: 2,
    })
    expect(byDay.get('2026-09-09')).toEqual({
      inputTokens: 600, outputTokens: 60, cacheReadTokens: 3000, cacheCreationTokens: 70, calls: 2,
    })
    expect(byChannel.get('ch-tree')?.totals.cacheReadTokens).toBe(3000)

    for (const dimension of [
      [...byModel.values()],
      [...byDay.values()],
      [...byChannel.values()].map((entry) => entry.totals),
    ]) {
      const sum = createEmptyTotals()
      for (const bucket of dimension) addTotals(sum, bucket)
      expect(sum).toEqual(totals)
    }
  })

  test('给定缺缓存字段的老记录与新记录混在一起 当汇总 则老记录缓存按 0 计，各维度不出现 NaN', () => {
    const content = [
      // 老记录：usage 里只有输入输出，没有两个缓存字段
      assistantLine('m', { input_tokens: 300, output_tokens: 30 }, { createdAt: localTime(2026, 9, 9), provider: 'deepseek' }),
      assistantLine('m', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 }, { createdAt: localTime(2026, 9, 9), provider: 'deepseek' }),
    ].join('\n')
    const { totals, byModel, byDay, byChannel } = collectUsageFromContent(content)
    const expected = { inputTokens: 400, outputTokens: 40, cacheReadTokens: 900, cacheCreationTokens: 0, calls: 2 }
    expect(totals).toEqual(expected)
    expect(byModel.get('m')).toEqual(expected)
    expect(byDay.get('2026-09-09')).toEqual(expected)
    expect(byChannel.get('provider:deepseek')?.totals).toEqual(expected)
    expect(totalTokensOf(totals)).toBe(1340)
  })

  test('给定缓存字段为 null 或字符串的坏记录 当解析 则按 0 处理而不是整条丢弃', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: '12' } },
    })
    expect(parseUsageLine(line)?.usage).toEqual({
      inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 1,
    })
  })

  test('给定只有缓存读取、没有非缓存输入的记录 当解析 则照样计入，不被当成空壳', () => {
    const parsed = parseUsageLine(assistantLine('m', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 2048 }))
    expect(parsed?.usage.cacheReadTokens).toBe(2048)
    expect(parsed?.usage.calls).toBe(1)
  })

  test('给定多个会话 当跨会话聚合 则 total、byModel、byChannel、byDay、bySession 的缓存字段逐项一致', () => {
    const contents: Record<string, string> = {
      'session-a': cacheSessionContent(),
      'session-b': [
        assistantLine('gpt-5.5', {
          input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 400,
        }, { createdAt: localTime(2026, 9, 9), provider: 'openai-responses', channelId: 'ch-tree' }),
        // 老记录，缺缓存字段、缺时间与渠道
        assistantLine('gpt-5.5', { input_tokens: 7, output_tokens: 3 }),
      ].join('\n'),
      'session-empty': '',
    }
    const stats = aggregateAgentUsage(
      {},
      (id) => contents[id] ?? '',
      () => [
        { id: 'session-a', title: '会话 A', updatedAt: 2 },
        { id: 'session-b', title: '会话 B', updatedAt: 1 },
        { id: 'session-empty', title: '空会话', updatedAt: 0 },
      ],
    )

    expect(stats.total).toEqual({
      inputTokens: 708, outputTokens: 75, cacheReadTokens: 34_000, cacheCreationTokens: 475, calls: 5,
    })
    expect(stats.sessionCount).toBe(3)
    expect(stats.countedSessionCount).toBe(2)

    const gpt = stats.byModel.find((row) => row.modelId === 'gpt-5.5')
    expect(gpt).toMatchObject({ inputTokens: 208, cacheReadTokens: 33_000, cacheCreationTokens: 400, calls: 3 })
    const tree = stats.byChannel.find((row) => row.channelId === 'ch-tree')
    expect(tree).toMatchObject({ cacheReadTokens: 33_000, cacheCreationTokens: 400, calls: 2 })
    const sessionB = stats.bySession.find((row) => row.sessionId === 'session-b')
    expect(sessionB).toMatchObject({ inputTokens: 8, cacheReadTokens: 30_000, cacheCreationTokens: 400, calls: 2 })

    // 每个维度逐项相加都回到总计（按日期不含无时间戳的老记录，单独扣掉它）
    const sumOf = (rows: readonly UsageTotals[]): UsageTotals => {
      const sum = createEmptyTotals()
      for (const row of rows) addTotals(sum, row)
      return sum
    }
    expect(sumOf(stats.byModel)).toEqual(stats.total)
    expect(sumOf(stats.byChannel)).toEqual(stats.total)
    expect(sumOf(stats.bySession)).toEqual(stats.total)
    expect(sumOf(stats.byDay)).toEqual({ ...stats.total, inputTokens: 701, outputTokens: 72, calls: 4 })
  })
})

describe('用量算术', () => {
  test('Given 一组用量 When 求合计 Then 等于四项之和（缓存读也算花掉的 token）', () => {
    expect(totalTokensOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 8, calls: 1 })).toBe(15)
  })

  test('Given 两组用量 When 累加 Then 逐项相加且调用数累计', () => {
    const target = createEmptyTotals()
    addTotals(target, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, calls: 1 })
    addTotals(target, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, calls: 1 })
    expect(target).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44, calls: 2 })
  })
})
