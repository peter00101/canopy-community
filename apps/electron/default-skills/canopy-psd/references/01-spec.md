# PsdCompose 规格（JSON）

```jsonc
{
  "width": 1080, "height": 1920,      // 必填，像素
  "dpi": 72,                          // 可选
  "background": "#ffffff",            // 可选；null = 透明
  "guides": [{ "direction": "vertical", "position": 540 }],   // 可选参考线
  "layers": [                         // 必填，自下而上
    { "type": "fill",  "name": "背景", "color": "#0b1020" },
    { "type": "svg",   "name": "光晕", "svg": "<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'>…</svg>", "opacity": 0.7, "blendMode": "screen" },
    { "type": "image", "name": "产品图", "source": "assets/product.png", "left": 140, "top": 520, "width": 800, "fit": "contain",
      "effects": { "dropShadow": { "color": "#000000", "opacity": 0.5, "angle": 120, "distance": 20, "size": 30 } } },
    { "type": "group", "name": "文案", "children": [
      { "type": "text", "name": "标题", "text": "夏日限定\n新品上市", "font": "Microsoft YaHei", "fontSize": 96, "bold": true,
        "color": "#ffffff", "align": "center", "left": 90, "top": 160, "width": 900, "lineHeight": 1.2,
        "effects": { "stroke": { "color": "#0b1020", "size": 4 } } },
      { "type": "text", "name": "副标题", "text": "6 月 1 日 全渠道发售", "fontSize": 40, "color": "#ffd166", "align": "center", "left": 90, "top": 420, "width": 900 }
    ] }
  ]
}
```

## 通用字段（每层都可用）

| 字段 | 说明 |
|---|---|
| `name` | 图层名，Photoshop 面板显示；建议中文可读 |
| `hidden` | 默认 false |
| `opacity` | 0~1 |
| `blendMode` | normal / multiply / screen / overlay / darken / lighten / color dodge / color burn / hard light / soft light / difference / exclusion / linear dodge / hue / saturation / color / luminosity |
| `effects` | `dropShadow` `innerShadow` { color, opacity, angle, distance, size }，`outerGlow` { color, opacity, size }，`stroke` { color, size, position, opacity }，`gradientOverlay` { colors[], angle, opacity }。写进 PSD 由 Photoshop 渲染；预览图里五种都近似画出（描边位置、渐变细节以 Photoshop 为准） |
| `mask` | `{ "source": "mask.png" }`（白显黑隐）或 `{ "rect": { left, top, width, height } }`，可加 `feather` |
| `clipToBelow` | 剪贴蒙版：只在下一层的不透明区域内显示（如把图片剪进圆形；调整层加它就只调下一层） |

## 图层类型

- `image`：`source`（png / jpg / webp / gif / svg / tif / bmp / avif），`left` `top`，可选 `width` `height` 缩放，`fit` contain / cover / fill；`smartObject: true` 时把原文件整个嵌进 PSD 成为**智能对象**（Photoshop 里双击可编辑 / 替换内容，缩放不损画质；svg / avif 不能嵌，按普通像素层写入）。
- `svg`：`svg`（内联标记）或 `source`（文件）；`left` `top`；不给 `width` `height` 时按 SVG 自身尺寸栅格化。
- `fill`：`color`，可选 `left` `top` `width` `height`（默认铺满）与 `radius` 圆角。
- `shape`：**Photoshop 原生矢量形状层**（锚点可拖、填充 / 描边可改）。`shape` 取 `rect`（`left` `top` `width` `height`，可选 `radius` 圆角）/ `ellipse`（外接框同上）/ `polygon`（`points: [[x, y], …]`）/ `path`（`d`：SVG path 数据，支持 M L H V C Q Z 与小写相对形式，不支持 S T A）；`fill` 颜色（默认黑，`null` = 无填充），`stroke: { color, width }`。按钮、色块、几何装饰优先用它而不是 SVG——用户在 Photoshop 里能继续改形状。
- `adjustment`：**调整层**，作用于它下面所有图层（加 `clipToBelow` 只作用于下一层，加 `mask` 限定区域）。`adjustment` 取：`brightness/contrast`（`brightness` -150～150，`contrast` -50～100）、`hue/saturation`（`hue` -180～180，`saturation` / `lightness` -100～100）、`black & white`、`invert`、`posterize`（`levels` 2～255）、`threshold`（`level` 1～255）、`exposure`（`exposure` -20～20，`offset` -0.5～0.5，`gamma` 0.01～9.99）、`vibrance`（`vibrance` / `saturation` -100～100）、`photo filter`（`color`，`density` 0～100）、`solid color`（`color`，Photoshop 里是纯色填充层，常配 `mask` 或 `opacity` 做色罩）。预览图按近似算法渲染，Photoshop 里按原参数实时计算。
- `artboard`：**画板**，一个文件里放多块画板（多尺寸 / 多页）。`left` `top` `width` `height`（画板在文档里的位置）、`background`（底色，默认白，`null` 透明）、`children`（自下而上，**坐标相对画板左上角**）。文档 `width` / `height` 要能装下所有画板，超出部分会被裁掉。
- `text`：`text`（支持 `\n`）、`font`（系统字体家族名）、`fontSize`（像素）、`color`、`bold` `italic`、`align`、`left` `top`、`width`（文本框宽，超出自动换行；不给就到画布右边）、`lineHeight`（倍数）、`letterSpacing`（像素）。
- `group`：`children`（自下而上），`opened`。

## 形状 / 调整 / 画板示例

```jsonc
{
  "width": 2160, "height": 1080, "background": null,
  "layers": [
    { "type": "artboard", "name": "封面", "left": 0, "top": 0, "width": 1080, "height": 1080, "background": "#0b1020", "children": [
      { "type": "shape", "name": "圆形色块", "shape": "ellipse", "left": 240, "top": 240, "width": 600, "height": 600, "fill": "#ff6b3d" },
      { "type": "adjustment", "name": "压暗色块", "adjustment": "brightness/contrast", "brightness": -30, "clipToBelow": true },
      { "type": "image", "name": "产品图", "source": "assets/product.png", "left": 340, "top": 300, "width": 400, "smartObject": true },
      { "type": "text", "name": "标题", "text": "新品上市", "fontSize": 96, "bold": true, "color": "#ffffff", "align": "center", "left": 90, "top": 880, "width": 900 }
    ] },
    { "type": "artboard", "name": "内页", "left": 1080, "top": 0, "width": 1080, "height": 1080, "children": [
      { "type": "shape", "name": "按钮", "shape": "rect", "left": 340, "top": 900, "width": 400, "height": 96, "radius": 48, "fill": "#ff6b3d", "stroke": { "color": "#ffffff", "width": 3 } },
      { "type": "adjustment", "name": "整体去色", "adjustment": "black & white", "opacity": 0.5 }
    ] }
  ]
}
```

## 相对路径基准

用 `specPath` 时相对 spec 文件所在目录；内联 `spec` 时相对当前工作目录。所有文件必须在会话授权目录内。

## 常用尺寸

| 用途 | 尺寸 |
|---|---|
| 竖版海报 / 手机壁纸 | 1080×1920 |
| 小红书封面 | 1242×1660 |
| 公众号头图 | 900×383 |
| 横版 Banner | 1920×1080 |
| A4 印刷 | 2480×3508（300 dpi） |
| 名片 | 1063×638（300 dpi） |
