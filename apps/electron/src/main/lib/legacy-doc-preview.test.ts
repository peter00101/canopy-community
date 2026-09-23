import { describe, expect, test } from 'bun:test'
import { legacyDocPlainText, renderLegacyDocHtml } from './legacy-doc-preview'

const TAB = String.fromCharCode(9)

describe('旧版 Word 预览 HTML', () => {
  test('Given word-extractor 的真实输出形态（表格行以制表符结尾） When 渲染 Then 段落与表格各自还原', () => {
    const body = [
      '旧版 Word 文档预览样例',
      '下面是一张表格：',
      `项目${TAB}负责人${TAB}进度${TAB}`,
      `预览补全${TAB}Canopy${TAB}进行中${TAB}`,
      '',
      '第二节',
      '',
    ].join('\n')
    const html = renderLegacyDocHtml({ body })
    expect(html).toContain('<p>旧版 Word 文档预览样例</p><p>下面是一张表格：</p><div class="office-table-wrap"><table><tbody>')
    expect(html).toContain('<tr><td>项目</td><td>负责人</td><td>进度</td></tr><tr><td>预览补全</td><td>Canopy</td><td>进行中</td></tr>')
    expect(html).toContain('</table></div><p>第二节</p>')
    expect(html).toContain('仅显示文字与表格，不含图片和排版')
  })

  test('Given 表格各行列数不齐 When 渲染 Then 按最宽一行补空单元格', () => {
    const html = renderLegacyDocHtml({ body: `a${TAB}b${TAB}c${TAB}\nd${TAB}` })
    expect(html).toContain('<tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td></td><td></td></tr>')
  })

  test('Given 文字里有 HTML 与脚本 When 渲染 Then 全部转义，不产出任何标签', () => {
    const html = renderLegacyDocHtml({ body: `<script>alert(1)</script>\n<img src=x onerror=alert(1)>${TAB}"引号"&${TAB}` })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('<td>&quot;引号&quot;&amp;</td>')
  })

  test('Given 页眉 / 脚注 / 尾注有内容 When 渲染 Then 追加对应小节；为空的小节不出现', () => {
    const html = renderLegacyDocHtml({ body: '正文', headers: '公司页眉', footnotes: '  ', endnotes: '尾注一' })
    expect(html).toContain('<h4>页眉与页脚</h4><p>公司页眉</p>')
    expect(html).toContain('<h4>尾注</h4><p>尾注一</p>')
    expect(html).not.toContain('脚注</h4>')
  })

  test('Given 正文为空 When 渲染 Then 给出空内容提示', () => {
    expect(renderLegacyDocHtml({ body: '\n\n' })).toContain('没有可提取的文字内容')
  })

  test('Given 各部分文字 When 取纯文本 Then 按正文 / 页眉 / 脚注 / 尾注顺序以空行连接，跳过空部分', () => {
    expect(legacyDocPlainText({ body: '正文\n', headers: '', footnotes: '脚注', endnotes: undefined })).toBe('正文\n\n脚注')
  })
})
