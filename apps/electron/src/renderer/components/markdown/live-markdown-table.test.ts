import { describe, expect, it } from 'bun:test'
import {
  deleteLiveMarkdownTableColumn,
  deleteLiveMarkdownTableRow,
  getLiveMarkdownTableCell,
  insertLiveMarkdownTableColumn,
  insertLiveMarkdownTableRow,
  isLiveMarkdownTableSeparator,
  liveMarkdownTableCellToDraft,
  liveMarkdownTableDraftToCell,
  liveMarkdownTableKeyAction,
  moveLiveMarkdownTableColumn,
  moveLiveMarkdownTableRow,
  nextLiveMarkdownTableCell,
  parseLiveMarkdownTable,
  serializeLiveMarkdownTable,
  setLiveMarkdownTableAlignment,
  setLiveMarkdownTableCell,
  shouldRenderLiveMarkdownBlockPreview,
  splitLiveMarkdownTableRow,
  type LiveMarkdownTable,
} from './live-markdown-table'

const BS = String.fromCharCode(92)

const SAMPLE = [
  '| 姓名 | 城市 | 分数 |',
  '| --- | :---: | ---: |',
  '| 张三 | 北京 | 90 |',
  '| 李四 | 上海 | 85 |',
].join('\n')

function sample(): LiveMarkdownTable {
  return parseLiveMarkdownTable(SAMPLE)!
}

describe('表格渲染态开关', () => {
  it('Given 光标只是落在表格里，When 判定，Then 表格保持渲染态', () => {
    expect(shouldRenderLiveMarkdownBlockPreview('table', true, false)).toBe(true)
  })

  it('Given 用户从右键「编辑源码」进入，When 判定，Then 表格切回源码', () => {
    expect(shouldRenderLiveMarkdownBlockPreview('table', true, true)).toBe(false)
  })

  it('Given 非表格块且光标在块内，When 判定，Then 显示源码（其他块行为不变）', () => {
    expect(shouldRenderLiveMarkdownBlockPreview('other', true)).toBe(false)
    expect(shouldRenderLiveMarkdownBlockPreview('other', false)).toBe(true)
  })
})

describe('切行 — 无损', () => {
  it('Given 普通行，When 切，Then 去掉首尾竖线并 trim 每格', () => {
    expect(splitLiveMarkdownTableRow('|  a | b  |')).toEqual(['a', 'b'])
  })

  it('Given 没有首尾竖线的写法，When 切，Then 同样切对', () => {
    expect(splitLiveMarkdownTableRow('a | b')).toEqual(['a', 'b'])
  })

  it('Given 转义竖线，When 切，Then 还原成字面竖线且不分格', () => {
    expect(splitLiveMarkdownTableRow(`| a ${BS}| b | c |`)).toEqual(['a | b', 'c'])
  })

  it('Given 其他转义（\\* 与 \\$），When 切，Then 反斜杠原样保留——旧实现会吞掉它', () => {
    expect(splitLiveMarkdownTableRow(`| ${BS}*不是强调${BS}* | ${BS}$5 和 ${BS}$6 |`))
      .toEqual([`${BS}*不是强调${BS}*`, `${BS}$5 和 ${BS}$6`])
  })

  it('Given 双反斜杠后紧跟竖线，When 切，Then 竖线仍是分隔符（与 cmark-gfm 一致）', () => {
    expect(splitLiveMarkdownTableRow(`| a${BS}${BS}| b |`)).toEqual([`a${BS}${BS}`, 'b'])
  })

  it('Given 行尾是转义竖线且无收尾竖线，When 切，Then 不把它当收尾符', () => {
    expect(splitLiveMarkdownTableRow(`a | b${BS}|`)).toEqual(['a', 'b|'])
  })

  it('Given 分隔行，When 判定，Then 认出；只有一列的不算', () => {
    expect(isLiveMarkdownTableSeparator('| --- | :---: |')).toBe(true)
    expect(isLiveMarkdownTableSeparator('| --- |')).toBe(false)
  })

  it('Given 短横线少于三个的分隔格（GFM 合法），When 判定，Then 同样认出', () => {
    expect(isLiveMarkdownTableSeparator('| -- | --- |')).toBe(true)
    expect(isLiveMarkdownTableSeparator('| :-- | --: |')).toBe(true)
    expect(isLiveMarkdownTableSeparator('| - | :-: |')).toBe(true)
    expect(isLiveMarkdownTableSeparator('-|-')).toBe(true)
  })

  it('Given 不是纯短横线加冒号的格子，When 判定，Then 不算分隔行', () => {
    expect(isLiveMarkdownTableSeparator('| : | --- |')).toBe(false)
    expect(isLiveMarkdownTableSeparator('| :: | --- |')).toBe(false)
    expect(isLiveMarkdownTableSeparator('| -a- | --- |')).toBe(false)
    expect(isLiveMarkdownTableSeparator('|  | --- |')).toBe(false)
    expect(isLiveMarkdownTableSeparator('| - - | --- |')).toBe(false)
  })
})

describe('解析', () => {
  it('Given 带对齐的表格，When 解析，Then 表头 / 对齐 / 正文各就各位', () => {
    expect(sample()).toEqual({
      header: ['姓名', '城市', '分数'],
      alignments: [null, 'center', 'right'],
      rows: [['张三', '北京', '90'], ['李四', '上海', '85']],
    })
  })

  it('Given 列数不齐，When 解析，Then 按最宽补空格子', () => {
    const table = parseLiveMarkdownTable('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |')!
    expect(table.header).toEqual(['a', 'b', ''])
    expect(table.rows).toEqual([['1', '', ''], ['1', '2', '3']])
    expect(table.alignments).toEqual([null, null, null])
  })

  it('Given 分隔格只有一两个短横线，When 解析，Then 左 / 右 / 居中对齐照常读出', () => {
    const table = parseLiveMarkdownTable('| 城市 | 金额 | 备注 |\n| :-- | -: | :-: |\n| 北京 | 12 | 无 |')!
    expect(table.alignments).toEqual(['left', 'right', 'center'])
    expect(table.rows).toEqual([['北京', '12', '无']])
  })

  it('Given 只有表头没有正文，When 解析，Then 仍是合法表格', () => {
    expect(parseLiveMarkdownTable('| a | b |\n| --- | --- |')?.rows).toEqual([])
  })

  it('Given 第二行不是分隔行，When 解析，Then 返回 null', () => {
    expect(parseLiveMarkdownTable('| a | b |\n| 1 | 2 |')).toBeNull()
  })
})

describe('序列化', () => {
  it('Given 无原始源码，When 序列化，Then 输出紧凑 GFM 并带对齐', () => {
    expect(serializeLiveMarkdownTable(sample())).toBe([
      '| 姓名 | 城市 | 分数 |',
      '| --- | :---: | ---: |',
      '| 张三 | 北京 | 90 |',
      '| 李四 | 上海 | 85 |',
    ].join('\n'))
  })

  it('Given 任意表格，When 序列化再解析，Then 往返一致', () => {
    const table: LiveMarkdownTable = {
      header: ['a|b', `c${BS}`],
      alignments: ['left', null],
      rows: [[`x ${BS}* y`, '第一行\n第二行'], ['', '$x$']],
    }
    const reparsed = parseLiveMarkdownTable(serializeLiveMarkdownTable(table))!
    expect(reparsed.header).toEqual(['a|b', `c${BS}`])
    expect(reparsed.alignments).toEqual(['left', null])
    expect(reparsed.rows).toEqual([[`x ${BS}* y`, '第一行<br>第二行'], ['', '$x$']])
  })

  it('Given 单元格值里有竖线，When 序列化，Then 竖线被转义不会多出一列', () => {
    const table = setLiveMarkdownTableCell(sample(), { row: 1, column: 0 }, 'A|B')
    const line = serializeLiveMarkdownTable(table).split('\n')[2]!
    expect(line).toBe(`| A${BS}|B | 北京 | 90 |`)
    expect(splitLiveMarkdownTableRow(line)).toHaveLength(3)
  })

  it('Given 用户自己写了 \\| ，When 序列化，Then 不再多加反斜杠（否则反而断格）', () => {
    const table = setLiveMarkdownTableCell(sample(), { row: 1, column: 0 }, `A${BS}|B`)
    const line = serializeLiveMarkdownTable(table).split('\n')[2]!
    expect(line).toBe(`| A${BS}|B | 北京 | 90 |`)
    expect(splitLiveMarkdownTableRow(line)).toHaveLength(3)
  })

  it('Given 手工对齐排版的表格只改一格，When 带原始源码序列化，Then 其他行一个空格都不动', () => {
    const source = [
      '| 姓名   | 城市   |',
      '| ------ | ------ |',
      '| 张三   | 北京   |',
      '| 李四   | 上海   |',
    ].join('\n')
    const table = setLiveMarkdownTableCell(parseLiveMarkdownTable(source)!, { row: 2, column: 1 }, '深圳')
    expect(serializeLiveMarkdownTable(table, source)).toBe([
      '| 姓名   | 城市   |',
      '| ------ | ------ |',
      '| 张三   | 北京   |',
      '| 李四 | 深圳 |',
    ].join('\n'))
  })

  it('Given 手工排版的表格上下移动行，When 带原始源码序列化，Then 移动的行保留原排版', () => {
    const source = '| a  | b  |\n|----|----|\n| 1  | 2  |\n| 3  | 4  |'
    const moved = moveLiveMarkdownTableRow(parseLiveMarkdownTable(source)!, 0, 1)
    expect(serializeLiveMarkdownTable(moved, source)).toBe('| a  | b  |\n|----|----|\n| 3  | 4  |\n| 1  | 2  |')
  })

  it('Given 列结构变了（插列），When 带原始源码序列化，Then 整表按紧凑格式重写', () => {
    const source = '| a  | b  |\n|----|----|\n| 1  | 2  |'
    const next = insertLiveMarkdownTableColumn(parseLiveMarkdownTable(source)!, 2)
    expect(serializeLiveMarkdownTable(next, source)).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 | 2 |  |')
  })

  it('Given 改了对齐，When 带原始源码序列化，Then 分隔行重写', () => {
    const next = setLiveMarkdownTableAlignment(sample(), 0, 'center')
    expect(serializeLiveMarkdownTable(next, SAMPLE).split('\n')[1]).toBe('| :---: | :---: | ---: |')
  })

  it('Given 列表里缩进的表格，When 重写，Then 每行保留缩进，不会被挪出列表', () => {
    const source = '  | a | b |\n  | --- | --- |\n  | 1 | 2 |'
    const next = insertLiveMarkdownTableRow(parseLiveMarkdownTable(source)!, 1)
    expect(serializeLiveMarkdownTable(next, source)).toBe('  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n  |  |  |')
  })
})

describe('输入框草稿', () => {
  it('Given 单元格里的 <br> 各种写法，When 转草稿，Then 都变成真换行', () => {
    expect(liveMarkdownTableCellToDraft('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd')
  })

  it('Given 草稿里的换行与首尾空白，When 转回单元格，Then 去首尾空白、换行交给序列化写 <br>', () => {
    expect(liveMarkdownTableDraftToCell('  a\r\nb  ')).toBe('a\nb')
  })
})

describe('单元格与行列操作', () => {
  it('Given 表头格与正文格，When 读写，Then 坐标 row 0 是表头', () => {
    const table = setLiveMarkdownTableCell(sample(), { row: 0, column: 1 }, '地区')
    expect(getLiveMarkdownTableCell(table, { row: 0, column: 1 })).toBe('地区')
    expect(getLiveMarkdownTableCell(setLiveMarkdownTableCell(table, { row: 2, column: 2 }, '99'), { row: 2, column: 2 })).toBe('99')
  })

  it('Given 越界坐标，When 写入，Then 原表不变（不会凭空长出一列）', () => {
    const table = sample()
    expect(setLiveMarkdownTableCell(table, { row: 1, column: 3 }, 'x')).toBe(table)
    expect(setLiveMarkdownTableCell(table, { row: 3, column: 0 }, 'x')).toBe(table)
  })

  it('Given 正文第 1 行，When 在其上方 / 末尾插入，Then 行数 +1 且新行全空、列数不变', () => {
    const above = insertLiveMarkdownTableRow(sample(), 0)
    expect(above.rows[0]).toEqual(['', '', ''])
    expect(above.rows[1]).toEqual(['张三', '北京', '90'])
    expect(insertLiveMarkdownTableRow(sample(), 2).rows[2]).toEqual(['', '', ''])
  })

  it('Given 表格，When 删除正文行直到删空，Then 表头保留且仍能序列化', () => {
    const empty = deleteLiveMarkdownTableRow(deleteLiveMarkdownTableRow(sample(), 0), 0)
    expect(empty.rows).toEqual([])
    expect(parseLiveMarkdownTable(serializeLiveMarkdownTable(empty))?.header).toEqual(['姓名', '城市', '分数'])
  })

  it('Given 第一行上移 / 最后一行下移，When 移动，Then 原样返回', () => {
    const table = sample()
    expect(moveLiveMarkdownTableRow(table, 0, -1)).toBe(table)
    expect(moveLiveMarkdownTableRow(table, 1, 1)).toBe(table)
    expect(moveLiveMarkdownTableRow(table, 1, -1).rows[0]).toEqual(['李四', '上海', '85'])
  })

  it('Given 插入列，When 在左侧插，Then 表头 / 对齐 / 每一行同步插入', () => {
    const table = insertLiveMarkdownTableColumn(sample(), 1)
    expect(table.header).toEqual(['姓名', '', '城市', '分数'])
    expect(table.alignments).toEqual([null, null, 'center', 'right'])
    expect(table.rows[1]).toEqual(['李四', '', '上海', '85'])
  })

  it('Given 只剩两列，When 删列，Then 拒绝（再删就不是表格了）', () => {
    const two = deleteLiveMarkdownTableColumn(sample(), 2)
    expect(two.header).toEqual(['姓名', '城市'])
    expect(two.alignments).toEqual([null, 'center'])
    expect(deleteLiveMarkdownTableColumn(two, 0)).toBe(two)
  })

  it('Given 移动列，When 右移第一列，Then 对齐跟着列走', () => {
    const table = moveLiveMarkdownTableColumn(sample(), 0, 1)
    expect(table.header).toEqual(['城市', '姓名', '分数'])
    expect(table.alignments).toEqual(['center', null, 'right'])
    expect(table.rows[0]).toEqual(['北京', '张三', '90'])
    expect(moveLiveMarkdownTableColumn(table, 2, 1)).toBe(table)
  })

  it('Given 设置对齐，When 设为默认，Then 该列回到 null', () => {
    expect(setLiveMarkdownTableAlignment(sample(), 2, null).alignments).toEqual([null, 'center', null])
  })
})

describe('键盘', () => {
  it('Given 输入法正在选字，When 按回车 / Tab，Then 不接管', () => {
    expect(liveMarkdownTableKeyAction('Enter', false, true, 13)).toBeNull()
    expect(liveMarkdownTableKeyAction('Tab', false, false, 229)).toBeNull()
  })

  it('Given 普通按键，When 判定，Then Enter 提交 / Shift+Enter 交给换行 / Esc 取消 / Tab 前后跳', () => {
    expect(liveMarkdownTableKeyAction('Enter', false, false, 13)).toBe('commit')
    expect(liveMarkdownTableKeyAction('Enter', true, false, 13)).toBeNull()
    expect(liveMarkdownTableKeyAction('Escape', false, false, 27)).toBe('cancel')
    expect(liveMarkdownTableKeyAction('Tab', false, false, 9)).toBe('next')
    expect(liveMarkdownTableKeyAction('Tab', true, false, 9)).toBe('previous')
    expect(liveMarkdownTableKeyAction('a', false, false, 65)).toBeNull()
  })

  it('Given 表头最后一格，When Tab，Then 换到正文第一行第一格', () => {
    expect(nextLiveMarkdownTableCell(sample(), { row: 0, column: 2 }, false))
      .toEqual({ cell: { row: 1, column: 0 }, appendRow: false })
  })

  it('Given 整张表最后一格，When Tab，Then 要求在末尾加一行并落到新行第一格', () => {
    expect(nextLiveMarkdownTableCell(sample(), { row: 2, column: 2 }, false))
      .toEqual({ cell: { row: 3, column: 0 }, appendRow: true })
  })

  it('Given 第一格，When Shift+Tab，Then 停在原地；其余格退回上一格', () => {
    expect(nextLiveMarkdownTableCell(sample(), { row: 0, column: 0 }, true).cell).toEqual({ row: 0, column: 0 })
    expect(nextLiveMarkdownTableCell(sample(), { row: 1, column: 0 }, true).cell).toEqual({ row: 0, column: 2 })
  })
})
