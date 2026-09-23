import { describe, expect, test } from 'bun:test'
import { rewriteTutorialImagePaths, stripTutorialImages } from './tutorial-image-paths'

/**
 * 教程内容是以字符串交给渲染层的，没有随行的基准目录，相对图片路径无从解析，
 * 所以主进程必须在返回前改写成绝对路径。这里钉住改写的三个易错点：
 * Windows 反斜杠、生产路径里的空格、图注。
 *
 * 剥离侧额外覆盖 HTML `<img>`：改写只认 markdown 形态（HTML 形态会被渲染层的
 * DOMPurify 剥掉 `C:` 开头的 src，见 tutorial-image-paths.ts 的说明），
 * 但剥离必须两种都吃干净，否则教程里一旦混进 HTML 图，附件就会漏给模型。
 */

const WIN_DIR = 'C:\\Program Files\\Canopy\\resources\\tutorial-images'
const WIN_BASE = 'C:/Program Files/Canopy/resources/tutorial-images'

describe('rewriteTutorialImagePaths：markdown 形态', () => {
  test('Given Windows 反斜杠目录 When 改写 Then 输出正斜杠绝对路径并用角括号包裹', () => {
    // 反斜杠在 markdown 里是转义符，空格会截断裸 URL——两者都必须处理掉
    expect(rewriteTutorialImagePaths('![总览](tutorial-images/overview.png)', WIN_DIR))
      .toBe(`![总览](<${WIN_BASE}/overview.png>)`)
  })

  test('Given 带图注的引用 When 改写 Then 图注原样保留', () => {
    expect(rewriteTutorialImagePaths('![输入框](tutorial-images/input-box.png "五个触发符")', '/opt/res/tutorial-images'))
      .toBe('![输入框](</opt/res/tutorial-images/input-box.png> "五个触发符")')
  })

  test('Given 一篇里多张图 When 改写 Then 全部替换', () => {
    const md = '![a](tutorial-images/a.png)\n正文\n![b](tutorial-images/b.png "注")\n'
    const out = rewriteTutorialImagePaths(md, '/r/tutorial-images')
    expect(out).toContain('(</r/tutorial-images/a.png>)')
    expect(out).toContain('(</r/tutorial-images/b.png> "注")')
    expect(out).not.toContain('(tutorial-images/')
  })

  test('Given 外链与其他目录的图 When 改写 Then 原样不动', () => {
    const md = '![外链](https://example.com/x.png)\n![别处](other/y.png)'
    expect(rewriteTutorialImagePaths(md, '/r/tutorial-images')).toBe(md)
  })

  test('Given 目录末尾带斜杠 When 改写 Then 不产生双斜杠', () => {
    expect(rewriteTutorialImagePaths('![a](tutorial-images/a.png)', '/r/tutorial-images/'))
      .toBe('![a](</r/tutorial-images/a.png>)')
  })

  test('Given 已改写过的内容 When 再次改写 Then 幂等不叠加', () => {
    const once = rewriteTutorialImagePaths('![a](tutorial-images/a.png)', '/r/tutorial-images')
    expect(rewriteTutorialImagePaths(once, '/r/tutorial-images')).toBe(once)
  })
})

describe('stripTutorialImages', () => {
  test('Given markdown 与 HTML 两种图片 When 剥离 Then 都被整段删除', () => {
    const md = '前\n\n![a](tutorial-images/a.png "注")\n\n<img src="tutorial-images/b.png" width="300">\n\n后'
    expect(stripTutorialImages(md)).toBe('前\n\n后')
  })

  test('Given 改写为绝对路径后的内容 When 剥离 Then 附件里不残留本机路径', () => {
    // 欢迎对话把教程当附件喂给模型；若剥不干净，模型会读到一串本机绝对路径
    const abs = rewriteTutorialImagePaths('![a](tutorial-images/a.png "注")\n\n正文', WIN_DIR)
    expect(abs).toContain('Program Files') // 前置断言：确实改写过，避免本例空跑
    const stripped = stripTutorialImages(abs)
    expect(stripped).toBe('正文')
    expect(stripped).not.toContain('Program Files')
  })
})
