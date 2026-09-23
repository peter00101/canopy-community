import { describe, expect, it } from 'bun:test'
import { interpretScreenshotRun } from './officecli-service'

/**
 * `view <file> screenshot` 的判定与 JSON 信封无关：stdout 只有输出路径，页数在 stderr。
 * 0.18.75 首版把它塞进 runOfficeCliJson，parseEnvelope 把那行路径当成失败文本，
 * 于是「PNG 已写出、工具却报失败」——0.18.85 的 canopy-ppt 样例里模型因此去找
 * Python / Playwright 自渲染。这批用例钉住新判定：只看超时、退出码、文件是否落盘。
 */
describe('interpretScreenshotRun — 截图命令的成败判定', () => {
  const base = { stdout: 'C:\\out\\contact.png\n', stderr: '[pages] total=8\n', code: 0, timedOut: false, outputWritten: true }

  it('Given 退出码 0 且 PNG 已落盘，When 判定，Then 成功并带上 stderr 里的页数', () => {
    const result = interpretScreenshotRun(base)
    expect(result.success).toBe(true)
    expect(result.message).toBe('已渲染 8 页')
  })

  it('Given stdout 只有输出路径（0.18.75 误判成失败的形态），When 判定，Then 不再把路径当错误', () => {
    const result = interpretScreenshotRun({ ...base, stderr: '' })
    expect(result.success).toBe(true)
    expect(result.message).toBe('已渲染')
  })

  it('Given 超时，When 判定，Then 失败并提示改用单页', () => {
    const result = interpretScreenshotRun({ ...base, timedOut: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('超时')
    expect(result.message).toContain('page')
  })

  it('Given 退出码非 0，When 判定，Then 失败并带上 stderr 原文', () => {
    const result = interpretScreenshotRun({ ...base, code: 1, stderr: 'Unsupported file', outputWritten: false })
    expect(result.success).toBe(false)
    expect(result.message).toContain('Unsupported file')
  })

  it('Given 退出码 0 但文件没写出来，When 判定，Then 失败并说明未写出', () => {
    const result = interpretScreenshotRun({ ...base, outputWritten: false, stderr: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('未写出截图文件')
  })

  it('Given 退出码为 null（被信号杀掉）、无任何输出且未超时，When 判定，Then 按失败处理并报出退出码', () => {
    const result = interpretScreenshotRun({ ...base, code: null, stdout: '', stderr: '', outputWritten: false })
    expect(result.success).toBe(false)
    expect(result.message).toContain('退出码 null')
  })

  it('Given 退出码非 0 但 stderr 有话说，When 判定，Then 优先转述 stderr 而不是退出码', () => {
    const result = interpretScreenshotRun({ ...base, code: null, outputWritten: false })
    expect(result.success).toBe(false)
    expect(result.message).toContain('[pages] total=8')
  })
})
