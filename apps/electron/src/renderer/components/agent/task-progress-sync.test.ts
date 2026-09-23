import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@canopy/shared'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { collectLiveRunTaskActivities } from './AgentMessages'
import { shouldRetainTaskProgress } from './TaskProgressOverlay'
import { aggregateTaskItems, getTaskProgressCounts, type TaskItem } from './task-progress'

// ===== 夹具：一轮 run 的真实消息形态 =====

const RUN = { runGeneration: 7, startedAt: 1_000 }

function marked(message: Record<string, unknown>, run = RUN): SDKMessage {
  return { ...message, _canopyLiveRunGeneration: run.runGeneration, _canopyLiveRunStartedAt: run.startedAt } as unknown as SDKMessage
}

function taskCreate(id: string, subject: string, run = RUN): SDKMessage {
  return marked({
    type: 'assistant',
    uuid: `a-${id}`,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject } }] },
  }, run)
}

function taskCreateResult(id: string, subject: string, run = RUN): SDKMessage {
  return marked({
    type: 'user',
    uuid: `r-${id}`,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ task: { id, subject, status: 'pending' } }) }] },
  }, run)
}

function taskUpdate(callId: string, taskId: string, status: string, run = RUN): SDKMessage {
  return marked({
    type: 'assistant',
    uuid: `a-${callId}`,
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: callId, name: 'TaskUpdate', input: { taskId, status } }] },
  }, run)
}

function compactBoundary(): SDKMessage {
  return marked({ type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' })
}

function userInput(text: string): SDKMessage {
  return { type: 'user', uuid: `u-${text}`, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } as unknown as SDKMessage
}

function item(id: string, status: TaskItem['status']): TaskItem {
  return { id, subject: id, status }
}

describe('任务进度卡同步：当前 run 的任务汇总（收上游 #2076）', () => {
  test('Given 上下文压缩把一个 run 拆成两段 When 汇总任务 Then 压缩前建的任务仍在进度卡上', () => {
    const messages = [
      userInput('把两件事做完'),
      taskCreate('toolu_A', '读取需求'),
      taskCreateResult('toolu_A', '读取需求'),
      taskCreate('toolu_B', '写实现'),
      taskCreateResult('toolu_B', '写实现'),
      compactBoundary(),
      taskUpdate('toolu_C', 'toolu_B', 'in_progress'),
    ]

    const items = aggregateTaskItems(collectLiveRunTaskActivities(messages, undefined, RUN), false)
    expect(items.map((task) => [task.id, task.status])).toEqual([
      ['toolu_A', 'pending'],
      ['toolu_B', 'in_progress'],
    ])
  })

  test('Given 旧 run 的 TaskUpdate 迟到混进 liveMessages When 汇总 Then 不会把旧状态套到新任务上', () => {
    const oldRun = { runGeneration: 6, startedAt: 900 }
    const messages = [
      userInput('继续'),
      taskCreate('toolu_A', '读取需求'),
      taskCreateResult('toolu_A', '读取需求'),
      taskUpdate('toolu_OLD', 'toolu_A', 'completed', oldRun),
    ]

    const items = aggregateTaskItems(collectLiveRunTaskActivities(messages, undefined, RUN), false)
    expect(items).toEqual([{ id: 'toolu_A', subject: '读取需求', status: 'pending', activeForm: undefined }])
  })

  test('Given TaskCreate 结果还没回来 When 汇总 Then 已按 toolCallId 建项，结果到达后键不变、不出现重复任务', () => {
    const pending = aggregateTaskItems(collectLiveRunTaskActivities([userInput('开始'), taskCreate('toolu_A', '读取需求')], undefined, RUN), false)
    const settled = aggregateTaskItems(collectLiveRunTaskActivities([
      userInput('开始'),
      taskCreate('toolu_A', '读取需求'),
      taskCreateResult('toolu_A', '读取需求'),
      taskUpdate('toolu_C', 'toolu_A', 'completed'),
    ], undefined, RUN), false)
    expect(pending.map((task) => task.id)).toEqual(['toolu_A'])
    expect(settled.map((task) => [task.id, task.status])).toEqual([['toolu_A', 'completed']])
  })

  test('Given 会话还没有流状态 When 汇总 Then 不筛 run，照常汇总', () => {
    const activities: ToolActivity[] = collectLiveRunTaskActivities([userInput('开始'), taskCreate('toolu_A', '读取需求')], undefined, undefined)
    expect(activities.map((activity) => activity.toolUseId)).toEqual(['toolu_A'])
  })
})

describe('任务进度卡同步：统计口径与收起时机（收上游 #2076）', () => {
  test('Given 一个完成、一个失败、一个取消 When 统计 Then 已完成只数 1 个，但已无活动任务', () => {
    const counts = getTaskProgressCounts([item('a', 'completed'), item('b', 'error'), item('c', 'cancelled')])
    expect(counts).toEqual({ completed: 1, terminal: 3, total: 3, hasActive: false })
  })

  test('Given 还有待办任务 When 统计 Then 仍有活动任务', () => {
    expect(getTaskProgressCounts([item('a', 'completed'), item('b', 'pending')]).hasActive).toBe(true)
  })

  test('Given run 结束时任务还标着进行中 When 按终态聚合 Then 退回待办并清掉「正在 xxx」文案', () => {
    const activities: ToolActivity[] = [{
      toolUseId: 'toolu_A',
      toolName: 'TaskUpdate',
      input: { taskId: 'toolu_A', status: 'in_progress', activeForm: '正在写实现' },
      done: true,
    }]
    expect(aggregateTaskItems(activities, false)[0]).toMatchObject({ status: 'in_progress', activeForm: '正在写实现' })
    expect(aggregateTaskItems(activities, true)[0]).toMatchObject({ status: 'pending', activeForm: undefined })
  })

  test('Given 任务全勾完但 Agent 还在写总结 When 判定是否开始收起倒计时 Then 不收起；run 结束后才开始', () => {
    expect(shouldRetainTaskProgress(true, true)).toBe(false)
    expect(shouldRetainTaskProgress(false, true)).toBe(true)
    expect(shouldRetainTaskProgress(false, false)).toBe(false)
  })
})
