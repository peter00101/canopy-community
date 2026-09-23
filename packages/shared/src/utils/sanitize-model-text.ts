import type { ChannelModel } from '../types/channel'

/**
 * 模型 id / 显示名里的「不可见字符」清洗。
 *
 * 背景（2026-08-24 维护者报障）：new-api 系服务端的 anthropic `/v1/models` 端点会把
 * 上游渠道的脏模型 id 原样透传出来，实测内嵌 U+202E（RLO）一类 bidi 控制符——
 * 浏览器按 bidi 算法把后续字符逐字反向渲染，UI 上呈现为「镜像文字」；拿这种 id
 * 去发 messages 请求，服务端对外名单里没有这个名字，必 404。
 *
 * 清洗范围（全部是「渲染不可见、但会改变显示或让请求失败」的字符）。
 * 源码里不写这些码点的字面量/转义（AI 工具链写入易被折坏），用码点表构造：
 */
const INVISIBLE_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 控制符
  [0x007f, 0x009f], // DEL + C1 控制符
  [0x00ad, 0x00ad], // 软连字符
  [0x061c, 0x061c], // 阿拉伯字母标记（ALM，bidi）
  [0x200b, 0x200d], // 零宽空格 / 零宽不连字 / 零宽连字
  [0x200e, 0x200f], // LRM / RLM（bidi）
  [0x202a, 0x202e], // LRE / RLE / PDF / LRO / RLO（bidi，维护者报障的 U+202E 在此）
  [0x2060, 0x2064], // 词连接符与不可见运算符
  [0x2066, 0x2069], // LRI / RLI / FSI / PDI（bidi 隔离符）
  [0xfeff, 0xfeff], // BOM / 零宽不换行空格
]

const INVISIBLE_TEXT_CONTROLS_RE = new RegExp(
  '[' +
    INVISIBLE_CODEPOINT_RANGES.map(([start, end]) =>
      start === end
        ? String.fromCharCode(start)
        : String.fromCharCode(start) + '-' + String.fromCharCode(end),
    ).join('') +
    ']',
  'g',
)

/**
 * 剥除字符串中的 bidi 控制符 / 零宽字符 / C0C1 控制符 / 软连字符，并 trim。
 *
 * 用于模型 id 与显示名：拉取入库前、用户手动粘贴时统一过一遍。
 */
export function stripInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_TEXT_CONTROLS_RE, '').trim()
}

/**
 * 清洗一组渠道模型：
 * - id 剥除不可见字符；洗后为空的条目丢弃（整个 id 都是控制符，没有可用信息）
 * - name 剥除不可见字符；洗后为空回退为洗后的 id
 * - 洗后同 id 去重（保留先出现的条目——服务端脏数据可能让多个条目洗出同一个 id）
 *
 * 其余字段（enabled / source）原样保留。
 */
export function sanitizeChannelModels(models: ChannelModel[]): ChannelModel[] {
  const seen = new Set<string>()
  const result: ChannelModel[] = []
  for (const model of models) {
    const id = stripInvisibleCharacters(model.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = stripInvisibleCharacters(model.name)
    result.push({ ...model, id, name: name || id })
  }
  return result
}
