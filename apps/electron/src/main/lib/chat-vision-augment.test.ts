import { describe, expect, test } from 'bun:test'
import type { FileAttachment } from '@canopy/shared'
import {
  appendImageDescriptionBlocks,
  fillVisionDescriptions,
  MAX_VISION_IMAGES,
  renderVisionDescription,
  VISION_PLACEHOLDER,
  type VisionDescriber,
} from './chat-vision-augment'

function makeImage(id: string, overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id,
    filename: `${id}.png`,
    mediaType: 'image/png',
    localPath: `conv/${id}.png`,
    size: 1024,
    ...overrides,
  }
}

function makeDocument(id: string): FileAttachment {
  return {
    id,
    filename: `${id}.pdf`,
    mediaType: 'application/pdf',
    localPath: `conv/${id}.pdf`,
    size: 2048,
  }
}

describe('视觉补齐：描述生成 fillVisionDescriptions', () => {
  test('为无缓存的图片附件并行生成描述并回填', async () => {
    const calls: string[] = []
    const describer: VisionDescriber = async (att) => {
      calls.push(att.id)
      return `描述-${att.id}`
    }

    const attachments = [makeImage('a'), makeImage('b')]
    const result = await fillVisionDescriptions(attachments, describer, '看看这两张图')

    expect(calls.sort()).toEqual(['a', 'b'])
    expect(result?.map((att) => att.visionDescription)).toEqual(['描述-a', '描述-b'])
    // 原数组不被修改
    expect(attachments[0]?.visionDescription).toBeUndefined()
  })

  test('已有缓存的图片跳过生成（历史重发不重复调用视觉模型）', async () => {
    const calls: string[] = []
    const describer: VisionDescriber = async (att) => {
      calls.push(att.id)
      return '新描述'
    }

    const attachments = [makeImage('cached', { visionDescription: '旧描述' }), makeImage('fresh')]
    const result = await fillVisionDescriptions(attachments, describer, undefined)

    expect(calls).toEqual(['fresh'])
    expect(result?.[0]?.visionDescription).toBe('旧描述')
    expect(result?.[1]?.visionDescription).toBe('新描述')
  })

  test('超过上限的图片不调用视觉模型（控制成本）', async () => {
    const calls: string[] = []
    const describer: VisionDescriber = async (att) => {
      calls.push(att.id)
      return `描述-${att.id}`
    }

    const attachments = Array.from({ length: MAX_VISION_IMAGES + 3 }, (_, i) => makeImage(`img-${i}`))
    const result = await fillVisionDescriptions(attachments, describer, undefined)

    expect(calls.length).toBe(MAX_VISION_IMAGES)
    const described = result?.filter((att) => att.visionDescription).length ?? 0
    expect(described).toBe(MAX_VISION_IMAGES)
  })

  test('单图失败不影响其他图片，失败图不写缓存', async () => {
    const describer: VisionDescriber = async (att) => {
      if (att.id === 'bad') throw new Error('视觉模型超时')
      return `描述-${att.id}`
    }

    const result = await fillVisionDescriptions([makeImage('bad'), makeImage('good')], describer, undefined)

    expect(result?.[0]?.visionDescription).toBeUndefined()
    expect(result?.[1]?.visionDescription).toBe('描述-good')
  })

  test('描述器返回 undefined 时不回填（走占位逻辑）', async () => {
    const describer: VisionDescriber = async () => undefined
    const attachments = [makeImage('a')]
    const result = await fillVisionDescriptions(attachments, describer, undefined)
    // 无任何新描述 → 原样返回入参引用（调用方以引用比较判断是否写回）
    expect(result).toBe(attachments)
  })

  test('文档附件与空列表不触发视觉调用', async () => {
    const calls: string[] = []
    const describer: VisionDescriber = async (att) => {
      calls.push(att.id)
      return '不应出现'
    }

    const docsOnly = [makeDocument('doc')]
    expect(await fillVisionDescriptions(docsOnly, describer, undefined)).toBe(docsOnly)
    expect(await fillVisionDescriptions(undefined, describer, undefined)).toBeUndefined()
    expect(await fillVisionDescriptions([], describer, undefined)).toEqual([])
    expect(calls).toEqual([])
  })

  test('上报进度：先 0/total，随完成递增到 total/total', async () => {
    const progress: Array<[number, number]> = []
    const describer: VisionDescriber = async () => '描述'
    await fillVisionDescriptions(
      [makeImage('a'), makeImage('b')],
      describer,
      undefined,
      undefined,
      (done, total) => progress.push([done, total]),
    )

    expect(progress[0]).toEqual([0, 2])
    expect(progress.at(-1)).toEqual([2, 2])
  })
})

describe('视觉补齐：描述注入 appendImageDescriptionBlocks', () => {
  test('单图注入 <image index="1"> 块，格式与 <file> 注入一致', () => {
    const text = appendImageDescriptionBlocks('看这张图', [
      makeImage('a', { filename: 'photo.png', visionDescription: '一只橘猫趴在键盘上' }),
    ])

    expect(text).toBe('看这张图\n<image index="1" name="photo.png">\n一只橘猫趴在键盘上\n</image>')
  })

  test('多图 index 递增，无描述的图片注入占位文本', () => {
    const text = appendImageDescriptionBlocks('对比一下', [
      makeImage('a', { filename: '1.png', visionDescription: '第一张' }),
      makeImage('b', { filename: '2.png' }),
    ])

    expect(text).toContain('<image index="1" name="1.png">\n第一张\n</image>')
    expect(text).toContain(`<image index="2" name="2.png">\n${VISION_PLACEHOLDER}\n</image>`)
  })

  test('文档附件不产生 <image> 块，纯文本消息原样返回', () => {
    expect(appendImageDescriptionBlocks('你好', [makeDocument('doc')])).toBe('你好')
    expect(appendImageDescriptionBlocks('你好', undefined)).toBe('你好')
    expect(appendImageDescriptionBlocks('你好', [])).toBe('你好')
  })
})

describe('视觉补齐：结果渲染 renderVisionDescription', () => {
  test('完整字段渲染为多行描述', () => {
    const rendered = renderVisionDescription({
      answer: '这是一张架构图',
      observations: ['三层结构', '有数据库图标'],
      limitations: ['分辨率较低'],
      extractedText: 'API Gateway',
    })

    expect(rendered).toBe('这是一张架构图\n关键观察：三层结构；有数据库图标\n图中文字：API Gateway')
  })

  test('容忍字段缺失：只有 answer 时输出单行', () => {
    expect(renderVisionDescription({ answer: '一张照片' })).toBe('一张照片')
  })

  test('observations 超过 8 条时截断', () => {
    const observations = Array.from({ length: 12 }, (_, i) => `观察${i + 1}`)
    const rendered = renderVisionDescription({ observations })
    expect(rendered).toContain('观察8')
    expect(rendered).not.toContain('观察9')
  })

  test('全部字段为空或非法类型时返回 undefined', () => {
    expect(renderVisionDescription({})).toBeUndefined()
    expect(renderVisionDescription({ answer: '   ' })).toBeUndefined()
    expect(renderVisionDescription({ answer: 42, observations: '不是数组' })).toBeUndefined()
  })
})
