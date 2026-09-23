import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// helperPath() 只在生产路径里碰 electron.app；这里全部走 options.helperPath 注入，mock 只为让模块能加载。
mock.module('electron', () => ({ app: { isPackaged: false } }))

type NativeHost = typeof import('./mac-agent-island-native-host')

let host: NativeHost
let fixtureDir: string

/**
 * 用 sh 脚本冒充 Swift helper：按 stdout JSONL 协议先睡 `delaySec` 秒再上报各行，
 * 每打完一行就 touch 一个同名 `.sent` 标记文件（测试据此等「helper 确实已经说完」，
 * 不依赖固定 sleep——新建脚本首次 exec 会过系统扫描，本机实测冷启动能超过 600ms），
 * 之后阻塞读 stdin 直到收到 shutdown（与真 helper 的生命周期一致，退出即触发 exit 事件）。
 * `ignoreTerm` 让脚本无视 SIGTERM，用来复现「dispose 之后 helper 仍把 ready 打出来」的时序。
 */
function writeFakeHelper(name: string, lines: string[], delaySec = 0, ignoreTerm = false): string {
  const path = join(fixtureDir, name)
  const script = [
    '#!/bin/sh',
    ignoreTerm ? "trap '' TERM" : ':',
    delaySec > 0 ? `sleep ${delaySec}` : ':',
    ...lines.map((line) => `printf '%s\\n' '${line}'`),
    `: > '${path}.sent'`,
    'while IFS= read -r line; do',
    '  case "$line" in *shutdown*) exit 0;; esac',
    'done',
    '',
  ].join('\n')
  writeFileSync(path, script, 'utf-8')
  chmodSync(path, 0o755)
  return path
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 每 20ms 轮询一次条件，超过 `timeoutMs` 仍不成立就抛错（时序类断言一律用它，不用固定 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）：${label}`)
    await sleep(20)
  }
}

function helperHasSpoken(helperPath: string): boolean {
  return existsSync(`${helperPath}.sent`)
}

interface Probe {
  ready: number
  unavailable: string[]
  events: unknown[]
}

function startWith(helperPath: string, readyTimeoutMs: number): Probe {
  const probe: Probe = { ready: 0, unavailable: [], events: [] }
  const started = host.startMacAgentIslandNativeHost({
    helperPath,
    readyTimeoutMs,
    onReady: () => { probe.ready += 1 },
    onEvent: (event) => { probe.events.push(event) },
    onUnavailable: (reason) => { probe.unavailable.push(reason) },
  })
  expect(started).toBe(true)
  return probe
}

const READY_LINE = '{"type":"ready","protocol":1}'

/**
 * 真 spawn 假 helper 的用例统一放宽单测超时。bun 默认 5s，而用例内部的 waitFor 预算本身就是 5s 一段、
 * 有的用例串两段：机器一忙（新建脚本首次 exec 过系统扫描能拖到数秒），先撞上的是 bun 的 5s 线，
 * 表现为偶发的 `this test timed out after 5000ms`（2026-09-17 成套连跑 27 轮里红过 2 次，单跑全绿）。
 * 断言的是时序语义不是墙钟，放宽外层上限不改变被测行为；内部 waitFor 超时仍会给出具体卡在哪一步。
 */
const SPAWN_TEST_TIMEOUT_MS = 20_000

describe.skipIf(process.platform !== 'darwin')('mac 灵动岛原生 helper 就绪等待', () => {
  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'canopy-island-host-'))
    host = await import('./mac-agent-island-native-host')
  })

  afterEach(async () => {
    host.disposeMacAgentIslandNativeHost()
    // dispose 后 helper 收到 shutdown 即退出；等一拍让 exit 事件落地，避免串到下一例。
    await sleep(150)
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  test('helper 在上限内上报 ready：onReady 恰好一次、host 进入就绪态、snapshot 可发', async () => {
    const helper = writeFakeHelper('ready-in-time', [READY_LINE], 0.3)
    const probe = startWith(helper, 5_000)

    expect(host.isMacAgentIslandNativeHostReady()).toBe(false)
    await waitFor(() => probe.ready > 0, 5_000, 'onReady')

    expect(probe.ready).toBe(1)
    expect(probe.unavailable).toEqual([])
    expect(host.isMacAgentIslandNativeHostReady()).toBe(true)
    expect(host.publishMacAgentIslandSnapshot({
      type: 'snapshot',
      protocol: 1,
      revision: 1,
      state: { visible: false, presentation: 'compact', hovered: false, expanded: false, pill: null, sessions: [] },
    } as never)).toBe(true)
  }, SPAWN_TEST_TIMEOUT_MS)

  test('helper 慢于上限：先按超时禁用；dispose 之后才到的 ready 一律忽略，不再出现假的「已就绪」', async () => {
    // 上限 300ms，helper 至少 600ms 后才 ready，且无视 SIGTERM：ready 必然落在 dispose 之后，
    // 正是 0.18.92 / 0.18.97 首启日志「先禁用、后又打出已就绪」的时序。
    const helper = writeFakeHelper('ready-too-late', [READY_LINE], 0.6, true)
    const probe = startWith(helper, 300)

    await waitFor(() => probe.unavailable.length > 0, 5_000, 'onUnavailable')
    expect(probe.unavailable).toEqual(['native helper did not report ready within 300ms'])
    expect(host.isMacAgentIslandNativeHostReady()).toBe(false)
    expect(probe.ready).toBe(0)

    await waitFor(() => helperHasSpoken(helper), 5_000, 'helper 迟到的 ready 已打出')
    await sleep(100)
    expect(probe.ready).toBe(0)
    expect(host.isMacAgentIslandNativeHostReady()).toBe(false)
    expect(host.publishMacAgentIslandSnapshot({ type: 'snapshot' } as never)).toBe(false)
  }, SPAWN_TEST_TIMEOUT_MS)

  test('就绪后的 intent 事件透传给 onEvent，ready 之前的 snapshot 发送返回 false', async () => {
    const helper = writeFakeHelper('ready-then-intent', [READY_LINE, '{"type":"intent","name":"dismiss"}'], 0.3)
    const probe = startWith(helper, 5_000)

    expect(host.publishMacAgentIslandSnapshot({ type: 'snapshot' } as never)).toBe(false)
    await waitFor(() => probe.events.length > 0, 5_000, 'onEvent')

    expect(probe.ready).toBe(1)
    expect(probe.events).toEqual([{ type: 'intent', name: 'dismiss' }])
  }, SPAWN_TEST_TIMEOUT_MS)

  test('协议号不匹配：按不可用禁用，不算就绪', async () => {
    const helper = writeFakeHelper('wrong-protocol', ['{"type":"ready","protocol":99}'])
    const probe = startWith(helper, 5_000)

    await waitFor(() => probe.unavailable.length > 0, 5_000, 'onUnavailable')
    expect(probe.ready).toBe(0)
    expect(probe.unavailable).toEqual(['unsupported native helper protocol: 99'])
    expect(host.isMacAgentIslandNativeHostReady()).toBe(false)
  }, SPAWN_TEST_TIMEOUT_MS)

  test('helper 上报 fatal：按不可用禁用并带上原因', async () => {
    const helper = writeFakeHelper('fatal', ['{"type":"fatal","message":"boom"}'])
    const probe = startWith(helper, 5_000)

    await waitFor(() => probe.unavailable.length > 0, 5_000, 'onUnavailable')
    expect(probe.ready).toBe(0)
    expect(probe.unavailable).toEqual(['native helper fatal: boom'])
  }, SPAWN_TEST_TIMEOUT_MS)

  test('helper 路径不存在：同步返回 false 并给出原因', () => {
    const probe: Probe = { ready: 0, unavailable: [], events: [] }
    const started = host.startMacAgentIslandNativeHost({
      helperPath: join(fixtureDir, 'missing-helper'),
      onReady: () => { probe.ready += 1 },
      onEvent: () => {},
      onUnavailable: (reason) => { probe.unavailable.push(reason) },
    })
    expect(started).toBe(false)
    expect(probe.unavailable[0]).toStartWith('native helper missing: ')
  })
})
