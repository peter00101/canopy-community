# 04 · SVG 契约

每页一张 SVG，既是预览也是进 PPTX 的成品，所以**只用 PowerPoint 与 WPS 的 SVG 渲染器都稳定支持的子集**。浏览器里好看不算数。

## 画布

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 1280 720" width="1280" height="720">
```

- 坐标单位 px，原点左上；不写根节点 `transform`。
- 文件名 `slides/pNN.svg`，NN 两位页码；封面备选 `p01a.svg` / `p01b.svg`。
- 文件自包含：不引用外部 CSS、字体、图片、脚本。

## 允许的元素

| 元素 | 用途 | 备注 |
|---|---|---|
| `rect` | 底色、卡片、色条 | 圆角用 `rx`，同一份 PPT 圆角只用一个值 |
| `circle` `ellipse` | 装饰、时间线节点、图标 | |
| `line` `polyline` `polygon` `path` | 分隔线、箭头、简单图标、图表折线 | `path` 只用 M L H V C Q Z，不用 A（弧）以外的复杂命令也尽量少用 |
| `text` `tspan` | 全部文字 | 见文字规则 |
| `g` | 分组 | 允许 `transform="translate(x y)"`，不用 rotate / scale / skew |
| `defs` `linearGradient` `radialGradient` `stop` | 渐变 | 每份 PPT 渐变不超过 3 个定义 |
| `clipPath` | 图片圆角或裁切 | 只用 `rect` / `circle` 作裁剪形 |
| `image` | 用户图片、模板底图 | `href` 只用 data URI（base64），先用 `Read` 读图确认尺寸 |

## 禁止的元素与写法

- `foreignObject`、`style`、`script`、`filter`、`mask`、`pattern`、`use`、`symbol`、`marker`、`textPath`、`switch`。
- CSS class 与 `style=""` 属性，一律用表现属性（`fill=`、`font-size=` …）。
- 外链：`href="http…"`、`@import`、Web 字体。
- 阴影、模糊、发光：用第二个略深的 `rect` 错位 4px 模拟投影，或干脆不用。
- 半透明叠加只用 `fill-opacity` / `stroke-opacity`，不用 `opacity` 套在 `g` 上。

## 文字规则

1. **手工断行**：SVG 不会自动换行。多行用 `tspan`，每行一个：

```xml
<text x="72" y="220" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
      font-size="22" fill="#333333">
  <tspan x="72" dy="0">营收 1.28 亿元，同比增长 12%，</tspan>
  <tspan x="72" dy="34">增长主要来自华东大客户续约。</tspan>
</text>
```

2. **行高**：`dy` = 字号 × 1.5（正文）或 × 1.25（标题）。
3. **字宽表**（估算每行最多字数）：

| 字号 | 每 100px 汉字数 | 每 100px 英文字符数 |
|---|---|---|
| 18 | 5.5 | 10 |
| 22 | 4.5 | 8 |
| 28 | 3.5 | 6.5 |
| 36 | 2.7 | 5 |
| 48 | 2 | 3.7 |
| 64 | 1.5 | 2.8 |

一行可容纳的字数 = 可用宽度 ÷ 100 × 表中数值，向下取整再减 1 留余量。中英混排按汉字算。

4. **字体栈**固定两套：
   - 标题：`"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`，`font-weight="bold"`；
   - 正文同栈不加粗。风格卡指定衬线时用 `"Noto Serif CJK SC", "Songti SC", SimSun, serif`。
   不用 Web 字体、不用系统里可能没有的字体名。
5. `text-anchor` 只用 `start` / `middle` / `end`；数字用 `end` 对齐右边缘时注意小数点。
6. 特殊字符转义：`&amp;` `&lt;` `&gt;`；引号在属性里用 `&quot;`。
7. 页码与页脚：`font-size="14"`，`fill` 用 `muted`，放在 `y="700"`。

## 图片规则

- 先 `Read` 图片确认原始宽高，按比例计算目标尺寸，不拉伸。
- 圆角或裁切用 `clipPath`：

```xml
<defs><clipPath id="clip-p05"><rect x="850" y="140" width="390" height="540" rx="24"/></clipPath></defs>
<image x="850" y="140" width="390" height="540" preserveAspectRatio="xMidYMid slice"
       clip-path="url(#clip-p05)" href="data:image/jpeg;base64,…"/>
```

- `id` 全局唯一，带页码前缀，避免多页合成后冲突。
- data URI 体积：单张图片不超过 800KB（base64 后约 1.1MB），超过就让用户提供压缩版或改用两栏小图。
- 模板底图（模板卡 / 沿用旧 PPT）作为第一层：`<image x="0" y="0" width="1280" height="720" href="data:…"/>`，其上元素不遮挡底图的品牌区域（`pack.json` 的 `safeArea` 之外不放内容）。

## 简单图表怎么画（不用图表库）

- 柱状图：每根柱一个 `rect`，高度 = 值 ÷ 最大值 × 绘图区高；柱顶标数值；底部标类目；不画网格线，只画一条基线。
- 折线图：`polyline` 连点，点用 `circle r="5"`，关键点标数值。
- 饼图 / 环图：用不超过 4 段的 `path`（`A` 命令）画扇形；PowerPoint 支持基本弧线，但超过 4 段先改成横向条形图更稳。
- 所有数值来自 `outline.json` 的 `content`，画完在图旁写一句解读。

## 一页的骨架

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <!-- 1 底色或模板底图 -->
  <rect x="0" y="0" width="1280" height="720" fill="#F5F7FA"/>
  <!-- 2 标题区 0~120 -->
  <text x="40" y="84" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
        font-size="36" font-weight="bold" fill="#111418">三季度营收 1.28 亿，同比增长 12%</text>
  <!-- 3 卡片与内容 -->
  <rect x="40" y="140" width="1200" height="260" rx="16" fill="#FFFFFF" stroke="#E1E5EB"/>
  …
  <!-- 4 页脚 -->
  <text x="1240" y="700" text-anchor="end" font-size="14" fill="#8A94A6"
        font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">05 / 08</text>
</svg>
```

## 原生编译友好写法（想让哪部分在 PowerPoint 里可逐字编辑就照做）

`OfficeSlidesFromSvg` 的 `native` 模式把下面这些编成原生对象：`rect`（含 `rx` 圆角）、`circle`、`ellipse`、水平或垂直的 `line`、`text` / `tspan`（含悬挂缩进，逐行成框）、`linearGradient` 填充、data URI `image`（`meet` / `slice` / `none`，以及用单个 `rect` / `circle` / `ellipse` 做的 `clip-path` 圆角或圆形裁切，都编成「裁剪 + 形状」的原生图片，用户能在 PowerPoint 里直接换图）、只含 `translate` 的 `g`。

其余写法**不会整页放弃**：那个元素会连同它的祖先 `g` 和页面 defs 被裁成一张只框住它的矢量小图，贴回原位，层次不变。小图里的内容不能逐字改，页面其余照常可编辑。会变成小图的有：`path` / `polyline` / `polygon`（饼图、折线、图标）、斜线、带 `marker` 的箭头、用 `path` 做裁切形的图片、`radialGradient` 或图案填充、带 `rotate` / `scale` 的 `g`、带整体 `opacity` 的 `g`、`filter` / `mask`。

所以：标题、正文、数字卡、卡片底、色条一律用原生写法；图表、图标、装饰放心用 `path`。只有 `use` / `foreignObject` / `style` / `script` 会让整页退回贴图，契约本来就禁止它们。

## 写完一页后

- 用 `Read` 读回该文件，检查：只用了允许的元素、没有 `style` / `class`、每个 `id` 唯一、所有坐标在边界内、每行字数不超字宽表。
- 有 `&`、`<` 未转义会让整页在 PowerPoint 里变空白，这是最常见的失败原因。
