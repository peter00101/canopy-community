import { describe, expect, test } from 'bun:test'
import {
  TASK_PROGRESS_CLEARANCE_PX,
  TASK_PROGRESS_OVERLAY_BOTTOM_PX,
  TASK_PROGRESS_OVERLAY_GAP_PX,
  TASK_PROGRESS_OVERLAY_HEIGHT_PX,
  TASK_PROGRESS_RESERVE_CLASS,
  getTaskProgressReserveClass,
} from './task-progress-reserve'

/** `ConversationContent` 自带的底部 padding（`py-4`），也是修复前唯一的净空 */
const CONVERSATION_CONTENT_PADDING_BOTTOM_PX = 16

describe('任务进度浮层的尾部预留', () => {
  test('Given 浮层在展示任务进度 When 求预留类 Then 给出 pb 类', () => {
    expect(getTaskProgressReserveClass(true)).toBe(TASK_PROGRESS_RESERVE_CLASS)
  })

  test('Given 浮层未展示（只剩回到底部箭头或什么都没有）When 求预留类 Then 不预留', () => {
    expect(getTaskProgressReserveClass(false)).toBeUndefined()
  })

  test('回归锁：净空必须盖住浮层整条带，否则尾部内容又会被压住', () => {
    // 浮层占据「距底 22px 起、40px 高」这条带；净空不足就是维护者 2026-08-22 报的遮挡
    expect(TASK_PROGRESS_CLEARANCE_PX).toBeGreaterThanOrEqual(
      TASK_PROGRESS_OVERLAY_BOTTOM_PX + TASK_PROGRESS_OVERLAY_HEIGHT_PX,
    )
    expect(TASK_PROGRESS_CLEARANCE_PX).toBe(
      TASK_PROGRESS_OVERLAY_BOTTOM_PX + TASK_PROGRESS_OVERLAY_HEIGHT_PX + TASK_PROGRESS_OVERLAY_GAP_PX,
    )
  })

  test('回归锁：修复前的 16px padding 确实不够，缺口正是实测被盖住的 46px', () => {
    expect(CONVERSATION_CONTENT_PADDING_BOTTOM_PX).toBeLessThan(
      TASK_PROGRESS_OVERLAY_BOTTOM_PX + TASK_PROGRESS_OVERLAY_HEIGHT_PX,
    )
    expect(
      TASK_PROGRESS_OVERLAY_BOTTOM_PX
      + TASK_PROGRESS_OVERLAY_HEIGHT_PX
      - CONVERSATION_CONTENT_PADDING_BOTTOM_PX,
    ).toBe(46)
  })

  test('类名与常量不许漂移（Tailwind 只认字面量，改常量必须同步改类）', () => {
    expect(TASK_PROGRESS_RESERVE_CLASS).toBe(`pb-[${TASK_PROGRESS_CLEARANCE_PX}px]`)
  })
})
