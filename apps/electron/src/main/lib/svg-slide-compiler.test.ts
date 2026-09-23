import { describe, expect, test } from 'bun:test'
import {
  compileSvgSlide,
  estimateTextWidthPx,
  gradientAngle,
  imageIntrinsicSize,
  normalizeSvgColor,
  parseSvgTransform,
  pathDataBox,
  roundRectAdjustment,
} from './svg-slide-compiler'

/**
 * 受限 SVG → OfficeCLI 原生对象的编译契约。数值口径来自 2026-09-14 的 OfficeCLI 试验：
 * 1px = 0.75pt；roundRect 的 adj = 圆角 / 短边 × 100000；gradient 写成 "C1-C2-ANGLE"；
 * 文字框 margin=0 / autoFit=none / valign=top / wordWrap=false（框宽只是估算，关掉折行才不会把「91%」拆成两行），
 * 多行用 "\n" 分段、lineSpacing 用倍数。
 */
const OPTIONS = { slideParent: '/slide[3]', mediaDir: 'C:/deck/media', mediaPrefix: 'p03' }

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1280 720" width="1280" height="720">${inner}</svg>`
}

function pt(px: number): string {
  return `${Math.round(px * 0.75 * 100) / 100}pt`
}

function cmd(result: ReturnType<typeof compileSvgSlide>, index = 0) {
  const command = result.commands[index]
  if (!command) throw new Error(`缺少第 ${index + 1} 条命令`)
  return command
}

function media(result: ReturnType<typeof compileSvgSlide>, index = 0) {
  const file = result.media[index]
  if (!file) throw new Error(`缺少第 ${index + 1} 个媒体文件`)
  return file
}

describe('颜色与几何换算', () => {
  test('给定各种写法的颜色，当归一化时，则统一成 #RRGGBB，none 保持 none', () => {
    expect(normalizeSvgColor('#1f5fbf')).toBe('#1F5FBF')
    expect(normalizeSvgColor('#fff')).toBe('#FFFFFF')
    expect(normalizeSvgColor('rgb(11, 37, 69)')).toBe('#0B2545')
    expect(normalizeSvgColor('white')).toBe('#FFFFFF')
    expect(normalizeSvgColor('none')).toBe('none')
    expect(normalizeSvgColor('url(#x)')).toBeUndefined()
  })

  test('给定圆角与尺寸，当算 adj 时，则按短边比例 × 100000 并封顶 50000', () => {
    expect(roundRectAdjustment(24, 400, 200)).toBe(12000)
    expect(roundRectAdjustment(500, 400, 200)).toBe(50000)
    expect(roundRectAdjustment(0, 400, 200)).toBe(0)
  })

  test('给定渐变方向，当算角度时，则左→右为 0、上→下为 90', () => {
    expect(gradientAngle(0, 0, 1, 0)).toBe(0)
    expect(gradientAngle(0, 0, 0, 1)).toBe(90)
    expect(gradientAngle(1, 0, 0, 0)).toBe(180)
  })

  test('给定中英混排，当估宽时，则汉字按 1em、拉丁按不足 1em 计算且不为零', () => {
    expect(estimateTextWidthPx('营收', 20)).toBe(40)
    expect(estimateTextWidthPx('abcd', 20)).toBeLessThan(estimateTextWidthPx('四个汉字', 20))
    expect(estimateTextWidthPx('1234', 20)).toBe(48)
  })
})

describe('形状映射', () => {
  test('给定普通矩形，当编译时，则得到 rect 形状、坐标按 0.75 换算、无描边', () => {
    const result = compileSvgSlide(svg('<rect x="40" y="140" width="1200" height="540" fill="#FFFFFF"/>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.commands).toHaveLength(1)
    expect(cmd(result)).toMatchObject({
      command: 'add', parent: '/slide[3]', type: 'shape',
      props: { geometry: 'rect', x: pt(40), y: pt(140), width: pt(1200), height: pt(540), fill: '#FFFFFF', line: 'none' },
    })
  })

  test('给定圆角矩形带描边与透明度，当编译时，则 roundRect + adj + line 三段式 + opacity', () => {
    const result = compileSvgSlide(svg('<rect x="0" y="0" width="400" height="200" rx="24" fill="#FFFFFF" fill-opacity="0.6" stroke="#D3DEED" stroke-width="1"/>'), OPTIONS)
    expect(cmd(result).props).toMatchObject({ geometry: 'roundRect', adj: 'adj:val 12000', opacity: '0.6', line: '#D3DEED:0.75' })
  })

  test('给定虚线描边，当编译时，则 line 带 :dash', () => {
    const result = compileSvgSlide(svg('<rect x="0" y="0" width="100" height="100" fill="none" stroke="#000000" stroke-width="2" stroke-dasharray="4 2"/>'), OPTIONS)
    expect(cmd(result).props.line).toBe('#000000:1.5:dash')
    expect(cmd(result).props.fill).toBe('none')
  })

  test('给定引用线性渐变的矩形，当编译时，则 gradient 写成 C1-C2-角度', () => {
    const result = compileSvgSlide(svg('<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7C5CFF"/><stop offset="1" stop-color="#2EE6D6"/></linearGradient></defs><rect x="0" y="0" width="100" height="50" fill="url(#g1)"/>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(cmd(result).props.gradient).toBe('7C5CFF-2EE6D6-0')
    expect(cmd(result).props.fill).toBeUndefined()
  })

  test('给定圆与椭圆，当编译时，则都成 ellipse 且外接框正确', () => {
    const result = compileSvgSlide(svg('<circle cx="100" cy="100" r="40" fill="#F28C28"/><ellipse cx="300" cy="100" rx="60" ry="20" fill="#000"/>'), OPTIONS)
    expect(cmd(result).props).toMatchObject({ geometry: 'ellipse', x: pt(60), y: pt(60), width: pt(80), height: pt(80) })
    expect(cmd(result, 1).props).toMatchObject({ geometry: 'ellipse', x: pt(240), y: pt(80), width: pt(120), height: pt(40) })
  })

  test('给定水平线与垂直线，当编译时，则成描边宽度厚的薄矩形；斜线裁成矢量小图', () => {
    const ok = compileSvgSlide(svg('<line x1="40" y1="684" x2="1240" y2="684" stroke="#DCE3ED" stroke-width="1"/><line x1="10" y1="0" x2="10" y2="100" stroke="#000" stroke-width="2"/>'), OPTIONS)
    expect(ok.supported).toBe(true)
    expect(cmd(ok).props).toMatchObject({ geometry: 'rect', x: pt(40), y: pt(683.5), width: pt(1200), height: pt(1), fill: '#DCE3ED', line: 'none' })
    expect(cmd(ok, 1).props).toMatchObject({ x: pt(9), y: pt(0), width: pt(2), height: pt(100) })
    const diagonal = compileSvgSlide(svg('<line x1="0" y1="0" x2="100" y2="100" stroke="#000"/>'), OPTIONS)
    expect(diagonal.supported).toBe(true)
    expect(diagonal.fragments.join()).toContain('斜线')
    expect(cmd(diagonal).type).toBe('picture')
  })

  test('给定 g 的 translate，当编译子元素时，则偏移叠加进坐标', () => {
    const result = compileSvgSlide(svg('<g transform="translate(100 50)"><rect x="10" y="20" width="30" height="40" fill="#000"/></g>'), OPTIONS)
    expect(cmd(result).props).toMatchObject({ x: pt(110), y: pt(70) })
  })
})

describe('文字映射', () => {
  test('给定单行标题，当编译时，则文字框顶边 = 基线 − 0.88 字号，字号换成 pt，加粗与颜色齐', () => {
    const result = compileSvgSlide(svg('<text x="40" y="84" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="36" font-weight="bold" fill="#111418">三季度营收 1.28 亿</text>'), OPTIONS)
    expect(result.supported).toBe(true)
    const props = cmd(result).props
    expect(cmd(result).type).toBe('textbox')
    expect(props.text).toBe('三季度营收 1.28 亿')
    expect(props.font).toBe('Microsoft YaHei')
    expect(props.size).toBe('27')
    expect(props.bold).toBe('true')
    expect(props.color).toBe('#111418')
    expect(props.x).toBe(pt(40))
    expect(props.y).toBe(pt(84 - 36 * 0.88))
    expect(props).toMatchObject({ margin: '0', autoFit: 'none', wordWrap: 'false', valign: 'top', align: 'left' })
    expect(Number.parseFloat(props.width ?? '0')).toBeGreaterThanOrEqual(estimateTextWidthPx('三季度营收 1.28 亿', 36) * 1.08 * 0.75)
    expect(props.lineSpacing).toBeUndefined()
  })

  test('给定 tspan 手工断行的正文，当编译时，则用换行拼成多段并按 dy 算行距倍数', () => {
    const result = compileSvgSlide(svg('<text x="72" y="220" font-size="22" fill="#333333"><tspan x="72" dy="0">第一行</tspan><tspan x="72" dy="33">第二行</tspan><tspan x="72" dy="33">第三行</tspan></text>'), OPTIONS)
    const props = cmd(result).props
    expect(props.text).toBe('第一行\n第二行\n第三行')
    expect(props.lineSpacing).toBe('1.5x')
    expect(Number.parseFloat(props.height ?? '0')).toBeCloseTo((2 * 33 + 22 * (0.88 + 0.4)) * 0.75, 1)
  })

  test('给定 text-anchor 为 end 与 middle，当编译时，则对齐方式与左边界随之调整', () => {
    const result = compileSvgSlide(svg('<text x="1240" y="700" font-size="14" text-anchor="end" fill="#8A94A6">05 / 08</text><text x="640" y="300" font-size="20" text-anchor="middle">居中</text>'), OPTIONS)
    const end = cmd(result).props
    expect(end.align).toBe('right')
    expect(Number.parseFloat(end.x ?? '0') + Number.parseFloat(end.width ?? '0')).toBeCloseTo(1240 * 0.75, 1)
    const middle = cmd(result, 1).props
    expect(middle.align).toBe('center')
    expect(Number.parseFloat(middle.x ?? '0') + Number.parseFloat(middle.width ?? '0') / 2).toBeCloseTo(640 * 0.75, 1)
  })

  test('给定各行 x 不一致的悬挂缩进，当编译时，则每行单独一个文字框、各自保持起点与基线', () => {
    const result = compileSvgSlide(svg('<text x="72" y="220" font-size="22"><tspan x="72" dy="0">a</tspan><tspan x="120" dy="30">b</tspan></text>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.commands).toHaveLength(2)
    expect(cmd(result, 0).props).toMatchObject({ text: 'a', x: pt(72), y: pt(220 - 22 * 0.88) })
    expect(cmd(result, 1).props).toMatchObject({ text: 'b', x: pt(120), y: pt(250 - 22 * 0.88) })
    expect(cmd(result, 1).props.lineSpacing).toBeUndefined()
    expect(result.stats.textboxes).toBe(2)
  })

  test('给定文字里的 XML 实体，当编译时，则解码为真实字符', () => {
    const result = compileSvgSlide(svg('<text x="0" y="20" font-size="16">A &amp; B &lt;C&gt;</text>'), OPTIONS)
    expect(cmd(result).props.text).toBe('A & B <C>')
  })
})

describe('矢量小图（元素级退回）', () => {
  test('给定带描边的斜线，当编译时，则裁成小图并按 2 倍描边外扩、裁到画布内', () => {
    const result = compileSvgSlide(svg('<line x1="0" y1="0" x2="100" y2="50" stroke="#000" stroke-width="4"/>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.fragments.join()).toContain('斜线')
    expect(cmd(result).props).toMatchObject({ x: pt(0), y: pt(0), width: pt(109), height: pt(59) })
  })

  test('给定旋转的 <g>，当编译时，则整组裁成一张小图，包围盒按旋转后的角点算', () => {
    const result = compileSvgSlide(svg('<g transform="rotate(45 100 100)"><rect x="50" y="50" width="100" height="100" fill="#000"/></g>'), OPTIONS)
    expect(result.commands).toHaveLength(1)
    expect(result.fragments.join()).toContain('旋转')
    expect(cmd(result).props).toMatchObject({ x: pt(28), y: pt(28), width: pt(144), height: pt(144) })
    expect(Buffer.from(media(result).bytes).toString('utf-8')).toContain('rotate(45 100 100)')
  })

  test('给定引用渐变的 path 与带属性的祖先 <g>，当编译时，则小图带上 defs 与祖先开标签、位置随祖先平移', () => {
    const result = compileSvgSlide(svg('<defs><linearGradient id="g1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><g transform="translate(20 10)" fill="url(#g1)"><path d="M0 0 L10 0 L10 10 Z"/></g>'), OPTIONS)
    const fragmentSvg = Buffer.from(media(result).bytes).toString('utf-8')
    expect(fragmentSvg).toContain('<linearGradient')
    expect(fragmentSvg).toContain('id="g1"')
    expect(fragmentSvg).toContain('<g transform="translate(20 10)" fill="url(#g1)">')
    expect(fragmentSvg).toContain('viewBox="0 0 12 12"')
    expect(fragmentSvg).toContain('<g transform="translate(-19 -9)">')
    expect(cmd(result).props).toMatchObject({ x: pt(19), y: pt(9) })
  })

  test('给定径向渐变填充的矩形，当编译时，则该矩形裁成小图而不是丢掉渐变', () => {
    const result = compileSvgSlide(svg('<defs><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs><rect x="0" y="0" width="10" height="10" fill="url(#r)"/>'), OPTIONS)
    expect(result.stats.fragments).toBe(1)
    expect(result.fragments.join()).toContain('非线性渐变')
    expect(Buffer.from(media(result).bytes).toString('utf-8')).toContain('<radialGradient')
  })

  test('给定 transform 列表与 path d，当解析时，则矩阵与包围盒按 SVG 语义算', () => {
    expect(parseSvgTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20])
    const rotated = parseSvgTransform('rotate(90)')
    expect(rotated?.[0]).toBeCloseTo(0, 6)
    expect(rotated?.[1]).toBeCloseTo(1, 6)
    expect(parseSvgTransform('translate(10) scale(2)')).toEqual([2, 0, 0, 2, 10, 0])
    expect(parseSvgTransform('foo(1)')).toBeNull()
    expect(pathDataBox('M10 10 h20 v10 z')).toEqual({ x0: 10, y0: 10, x1: 30, y1: 20 })
    expect(pathDataBox('M0 0 C 0 100 100 100 100 0')).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 })
    expect(pathDataBox('M10 10 A5 5 0 0 1 20 10')).toEqual({ x0: 5, y0: 5, x1: 25, y1: 15 })
    expect(pathDataBox('M0 0 L')).toBeNull()
  })
})

describe('图片与不支持的元素', () => {
  const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  test('给定 data URI 图片，当编译时，则解出字节、命名文件并把 src 指向媒体目录', () => {
    // preserveAspectRatio=none：拉伸铺满，图片框就是原生图片框（meet / slice 的换算见下面的用例）
    const result = compileSvgSlide(svg(`<image x="850" y="140" width="390" height="260" preserveAspectRatio="none" href="data:image/png;base64,${PNG_1X1}"/>`), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.media).toHaveLength(1)
    expect(media(result).fileName).toBe('p03-img1.png')
    expect(media(result).bytes.length).toBeGreaterThan(20)
    expect(cmd(result)).toMatchObject({ type: 'picture', props: { src: 'C:/deck/media/p03-img1.png', x: pt(850), y: pt(140), width: pt(390), height: pt(260) } })
  })

  /** 只有文件头的 PNG：编译器只读 IHDR 拿尺寸，不解码像素 */
  const pngHeader = (width: number, height: number): string => {
    const header = Buffer.alloc(33)
    header.write('\x89PNG\r\n\x1a\n', 0, 'binary')
    header.writeUInt32BE(13, 8)
    header.write('IHDR', 12, 'ascii')
    header.writeUInt32BE(width, 16)
    header.writeUInt32BE(height, 20)
    return header.toString('base64')
  }

  test('给定 slice 与 meet 的图片，当编译时，则按位图原始尺寸算可见区：slice 用 crop 切掉溢出，meet 缩到内容框', () => {
    const slice = compileSvgSlide(svg(`<image x="100" y="100" width="100" height="50" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${pngHeader(100, 100)}"/>`), OPTIONS)
    expect(slice.supported).toBe(true)
    expect(slice.stats).toMatchObject({ pictures: 1, fragments: 0 })
    expect(cmd(slice).props).toMatchObject({ x: pt(100), y: pt(100), width: pt(100), height: pt(50), crop: '0,25,0,25' })
    const meet = compileSvgSlide(svg(`<image x="100" y="100" width="100" height="50" href="data:image/png;base64,${pngHeader(100, 100)}"/>`), OPTIONS)
    expect(cmd(meet).props).toMatchObject({ x: pt(125), y: pt(100), width: pt(50), height: pt(50) })
    expect(cmd(meet).props.crop).toBeUndefined()
    expect(imageIntrinsicSize(Buffer.from(pngHeader(640, 360), 'base64'), 'image/png')).toEqual({ width: 640, height: 360 })
  })

  test('给定圆角矩形或圆形 clip-path 的图片，当编译时，则编成带形状的原生图片；path 裁切才退成矢量小图', () => {
    const rounded = compileSvgSlide(svg(`<defs><clipPath id="c"><rect x="0" y="0" width="80" height="40" rx="8"/></clipPath></defs><image x="0" y="0" width="80" height="40" preserveAspectRatio="none" clip-path="url(#c)" href="data:image/png;base64,${pngHeader(80, 40)}"/>`), OPTIONS)
    expect(rounded.stats).toMatchObject({ pictures: 1, fragments: 0 })
    expect(cmd(rounded).props).toMatchObject({ geometry: 'roundRect', adj: 'adj:val 20000', width: pt(80), height: pt(40) })
    const circle = compileSvgSlide(svg(`<defs><clipPath id="k"><circle cx="40" cy="40" r="30"/></clipPath></defs><image x="0" y="0" width="80" height="80" preserveAspectRatio="none" clip-path="url(#k)" href="data:image/png;base64,${pngHeader(80, 80)}"/>`), OPTIONS)
    expect(cmd(circle).props).toMatchObject({ geometry: 'ellipse', x: pt(10), y: pt(10), width: pt(60), height: pt(60), crop: '12.5,12.5,12.5,12.5' })
    const pathClip = compileSvgSlide(svg(`<defs><clipPath id="p"><path d="M0 0 L10 0 L10 10 Z"/></clipPath></defs><image x="0" y="0" width="10" height="10" clip-path="url(#p)" href="data:image/png;base64,${PNG_1X1}"/>`), OPTIONS)
    expect(pathClip.stats).toMatchObject({ pictures: 0, fragments: 1 })
    expect(pathClip.fragments.join()).toContain('clip-path')
    expect(Buffer.from(media(pathClip).bytes).toString('utf-8')).toContain('<clipPath')
  })

  test('给定 path，当编译时，则 path 裁成矢量小图、其余元素照常原生、z 序保持', () => {
    const result = compileSvgSlide(svg('<rect x="0" y="0" width="10" height="10" fill="#000"/><path d="M0 0 L10 10" fill="#000"/><text x="0" y="20" font-size="10">t</text>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.commands.map((c) => c.type)).toEqual(['shape', 'picture', 'textbox'])
    expect(result.fragments).toEqual(['<path> → 矢量小图 p03-vec1.svg'])
    expect(result.stats).toMatchObject({ shapes: 1, textboxes: 1, pictures: 0, fragments: 1 })
    const fragmentSvg = Buffer.from(media(result).bytes).toString('utf-8')
    expect(fragmentSvg).toContain('<path')
    expect(fragmentSvg).toContain('d="M0 0 L10 10"')
    expect(fragmentSvg).toContain('viewBox="0 0 11 11"')
  })

  test('给定外链图片与 use，当编译时，则外链图片只记警告跳过，use 才整页判为不支持', () => {
    const external = compileSvgSlide(svg('<image x="0" y="0" width="10" height="10" href="https://example.com/a.png"/>'), OPTIONS)
    expect(external.supported).toBe(true)
    expect(external.commands).toHaveLength(0)
    expect(external.warnings.join()).toContain('外链')
    const use = compileSvgSlide(svg('<use href="#a"/>'), OPTIONS)
    expect(use.supported).toBe(false)
    expect(use.reasons.join()).toContain('<use>')
  })

  test('给定 style 属性与越界元素，当编译时，则只记警告不拒绝', () => {
    const result = compileSvgSlide(svg('<rect x="1200" y="0" width="200" height="10" fill="#000" style="opacity:.5"/>'), OPTIONS)
    expect(result.supported).toBe(true)
    expect(result.warnings.join()).toContain('style')
    expect(result.warnings.join()).toContain('越出画布')
  })

  test('给定非 16:9 画布，当编译时，则判为不支持', () => {
    const result = compileSvgSlide('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect width="10" height="10"/></svg>', OPTIONS)
    expect(result.supported).toBe(false)
    expect(result.reasons.join()).toContain('16:9')
  })
})
