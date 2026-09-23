# 07 · 合成与交付

## 一次调用：`OfficeSlidesFromSvg`（可编辑与高保真都走它）

```text
OfficeSlidesFromSvg {
  filePath: "<绝对路径>/ppt/<slug>/deck.pptx",     // 不能已存在
  svgPaths: ["<绝对路径>/ppt/<slug>/slides/p01.svg", "…/p02.svg", …],   // 按页序
  mode: "native"                                   // 可编辑 PPTX；高保真贴图用 "picture"
}
```

- `native`：矩形 / 圆角矩形 / 圆 / 水平垂直线 / 文字（含悬挂缩进）/ 线性渐变 / data URI 图片（含 slice 与圆角、圆形 clip-path，编成裁剪 + 形状的原生图片，可直接换图）编成 PowerPoint 原生对象，用户能逐字改。原生画不了的元素（`path` / `polyline` / `polygon`、斜线与箭头、旋转缩放的组、径向渐变、滤镜）**原位嵌成矢量小图**，层次不变、页面其余仍可编辑；返回结果逐页列出原生对象数与小图清单（哪个元素、为什么），**原样写进 README**。只有 `use` / `foreignObject` / `style` / `script` 会让整页退回贴图。
- `picture`：每页一张矢量图贴满整页，PowerPoint 2016 以上与新版 WPS 直接渲染，排版最稳但文字不可逐字改；README 里写明用户可在 PowerPoint 右键图片「转换为形状」拆简单页。
- 内嵌图片会落到 `deck.pptx` 同目录的 `media/`；返回文案里的警告（越出画布、忽略的 style / filter）也写进 README。
- 想让更多页保持原生：写 SVG 时按 04 末尾「原生编译友好写法」来。

### 改了某页之后

删掉旧的 `deck.pptx`（Bash `rm`），改好对应 `slides/pNN.svg`，再调一次 `OfficeSlidesFromSvg` 整份重生成——几秒钟，且比逐页替换稳。别用下面的 OfficeBatch 单页替换去改原生页（一页里有几十个对象）。

## 手工路线（工具不可用时的备份知识）

### 步骤

1. 建文件（不能已存在）：

```text
OfficeCreate { filePath: "<绝对路径>/ppt/<slug>/deck.pptx" }
```

2. 一个 `OfficeBatch` 把所有页加进去，每页两条命令，按页码顺序：

```json
{
  "filePath": "<绝对路径>/ppt/<slug>/deck.pptx",
  "commands": [
    { "command": "add", "parent": "/", "type": "slide" },
    { "command": "add", "parent": "/slide[1]", "type": "picture",
      "props": { "src": "<绝对路径>/ppt/<slug>/slides/p01.svg", "x": "0", "y": "0", "width": "13.333in", "height": "7.5in" } },
    { "command": "add", "parent": "/", "type": "slide" },
    { "command": "add", "parent": "/slide[2]", "type": "picture",
      "props": { "src": "<绝对路径>/ppt/<slug>/slides/p02.svg", "x": "0", "y": "0", "width": "13.333in", "height": "7.5in" } }
  ]
}
```

- 新建的 pptx 是 13.333in × 7.5in（16:9），与 1280×720 同比例，整页贴图不留边。
- `src` 必须是绝对路径；批处理是原子的，任一条失败整批回滚，看清错误里的第几条再改。
- 页数多时也放同一个批里，不要一页一批。

3. 验证：`OfficeInspect mode=outline` 看页数等于 `outline.json`；再走 06 的视觉复核。

### 替换某一页

```json
{
  "filePath": "<绝对路径>/ppt/<slug>/deck.pptx",
  "commands": [
    { "command": "remove", "path": "/slide[5]/picture[1]" },
    { "command": "add", "parent": "/slide[5]", "type": "picture",
      "props": { "src": "<绝对路径>/ppt/<slug>/slides/p05.svg", "x": "0", "y": "0", "width": "13.333in", "height": "7.5in" } }
  ]
}
```

### 备注与页码

用户要演讲备注时，每页 `add` 之后再加一条 `{ "command": "set", "path": "/slide[N]", "props": { "notes": "…" } }`；备注来自 `outline.json` 的 `key_message` 与 `content`。写不进去时不要卡住，把备注写进 README。

## 可编辑 PPTX

当前版本先按高保真出片，并在 README 写明：文字可编辑的原生版本待 Canopy 后续能力上线；急用时可用内置 Office 工具按同一份 `outline.json` 和 `design.json` 重排一版原生文本框（排版会比 SVG 版朴素）。

## 网页 PPT

用户在 Step 0 选了网页 PPT：把 `outline.json`、`design.json`、`research/notes.md` 的路径交给 guizang-ppt-skill，按它的流程出单文件 HTML；风格卡映射到它的两种风格（暖沙 → 电子杂志风，其余 → 瑞士风）。不再合成 PPTX。

## 只要 SVG

交付 `slides/` 目录与 `qa/contact.png`，README 说明每页文件名与标题。

## README.md 模板

```markdown
# <主题> · 交付说明

- 产物：deck.pptx（8 页）· slides/p01～p08.svg · qa/contact.png
- 风格：远洋蓝（风格卡）/ 模板包 deep-navy / 沿用 <文件名> 的底图
- 图片：用户提供 3 张（slides/p04、p06）/ 未使用图片
- 调研：来源 6 个，见 research/notes.md；「待核」项：第 5 页的 2027 年预测

## 每页
1. 封面 · 三季度经营汇报
2. 目录
3. 三季度营收 1.28 亿，同比增长 12%
…

## 怎么改
- 改文字或数据：编辑对应 slides/pNN.svg，然后让我「重新合成第 N 页」。
- 换风格：需要重做全部页面，告诉我换哪张风格卡。
- 想在 PowerPoint 里直接改字：右键页面图片 →「转换为形状」，简单页可拆成文本框与形状；或让我出一版原生可编辑版本（排版更朴素）。

## 未做
- 用户未提供图片，第 4 页用图形代替。
- 第 5 页 2027 年预测未找到原始来源，标记为待核。
```

## 交付前最后检查

- `outline.json` 的页数、`slides/` 文件数、pptx 页数三者相等。
- `qa/contact.png` 已经亲眼看过，问题页都修过并复核。
- README 的「未做」如实，不写「全部完成」。
- 临时文件（封面备选、preview 目录）已删。
