# 05 · 风格卡、模板卡与自定义

五条路（风格卡 / 模板卡 / 沿用旧 PPT / 自定义派生 / 和用户一起创造）都产出同一份 `design.json`，后面每页 SVG 只认这份 token，不再自由发挥配色。

## `design.json`

```json
{
  "source": "style-card",
  "id": "sujian",
  "name": "素笺",
  "colors": {
    "bg": "#FFFFFF", "surface": "#F5F7FA", "text": "#1F2329", "muted": "#8A94A6",
    "brand": "#2F6FED", "accent": "#F28C28", "line": "#E1E5EB"
  },
  "fonts": {
    "title": "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif",
    "body": "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"
  },
  "shape": { "radius": 16, "cardStroke": true, "decor": "thin-top-bar" },
  "background": { "type": "color" },
  "footer": { "text": "三季度经营汇报", "pageNumber": true },
  "locked": true
}
```

- `colors` 七个键必填：`bg` 页面底色、`surface` 卡片底色、`text` 正文、`muted` 次要文字与页脚、`brand` 主色（标题强调、色条、序号）、`accent` 点睛色（只给焦点数字、一个按钮、一条曲线）、`line` 描边与分隔线。
- `shape.decor` 是这套风格的固定装饰，每页都出现一次，位置固定。五个起点：`thin-top-bar`（顶部 8px 色条）、`left-band`（左侧 16px 色带）、`corner-circle`（右上大圆）、`dot-grid`（右下点阵）、`none`。**这是起点不是清单**：共创时可以自创装饰——写成 `custom`，并加 `decorSpec`（一句话描述 + 一段可整段复制的 SVG 片段，例如「右上 45° 斜切金色色带」），每页照抄同一段。
- `background.type` 为 `image` 时带 `dataUri` 与 `safeArea`（见模板卡）。
- `locked: true` 之后不允许再改配色与字体；用户要换风格就重开一份 design.json 并重做所有页。**唯一例外**：视觉复核指出对比度不够时，允许把 `text` / `muted` 调深一档（只能更深、不能换色相），并在 README 写明改前改后的值；`brand` / `accent` / `bg` / `surface` 不动。

## 六张风格卡

每张给：气质、适用场景、七色、字体、形状语言、装饰、封面构图建议、避免事项。

### 1 · 素笺（sujian）— 办公通用，最保守

- 气质：干净、克制，像一份排得好的公文。适合周报、制度、培训、内部汇报。
- 七色：bg `#FFFFFF` · surface `#F5F7FA` · text `#1F2329` · muted `#8A94A6` · brand `#2F6FED` · accent `#F28C28` · line `#E1E5EB`
- 字体：标题与正文同栈无衬线。
- 形状：圆角 16，卡片带 1px 描边，无投影。装饰 `thin-top-bar`。
- 封面：左对齐，主标题 64，副标题 24，右下角一个 brand 色小方块。
- 避免：大面积深色、渐变、超过两种强调色。

### 2 · 远洋蓝（ocean）— 商务稳重

- 气质：可信、专业。适合经营汇报、方案提案、投资人材料。
- 七色：bg `#EAF1FB` · surface `#FFFFFF` · text `#0B2545` · muted `#5F7391` · brand `#1F5FBF` · accent `#F28C28` · line `#D3DEED`
- 字体：无衬线；标题 bold。
- 形状：圆角 20，卡片无描边靠底色区分，关键数字卡用 brand 实底白字。装饰 `left-band`。
- 封面：深色 brand 满版底，标题白字居左下，右上角一个浅蓝大圆（fill-opacity 0.25）。
- 避免：黑色文字直接压在 brand 底上。

### 3 · 墨石（ink）— 极简高对比

- 气质：锋利、有态度。适合发布会、战略宣讲、产品介绍。
- 七色：bg `#111418` · surface `#1C2129` · text `#F3F4F6` · muted `#9AA3B2` · brand `#2BD4BD` · accent `#FFD166` · line `#2C333D`
- 字体：无衬线；标题可到 72 做大字报。
- 形状：圆角 12，卡片深灰无描边，大量留白。装饰 `dot-grid`。
- 封面：全黑底，一句话标题占三行，brand 色一条 4px 竖线在标题左侧。
- 避免：小字号灰字（正文最小 20），花哨渐变。

### 4 · 暖沙（sand）— 杂志感

- 气质：温和、有质感。适合品牌故事、文化培训、生活方式类内容。
- 七色：bg `#F6F1EA` · surface `#FFFFFF` · text `#3B2F2A` · muted `#8C7B73` · brand `#C46A3C` · accent `#6B7F52` · line `#E6DCD2`
- 字体：标题衬线（`Noto Serif CJK SC, Songti SC, SimSun, serif`），正文无衬线。
- 形状：圆角 24，卡片带 1px 描边，图片圆角同 24。装饰 `corner-circle`（右上 `#EAD9C8`，fill-opacity 0.6）。
- 封面：标题衬线居中，下方一条 brand 色短横线 60×4。
- 避免：饱和亮色、深色满版。

### 5 · 松涛（pine）— 清新自然

- 气质：舒展、可亲。适合教育、健康、环保、公共服务。
- 七色：bg `#EEF5EF` · surface `#FFFFFF` · text `#1F3D2B` · muted `#6E8577` · brand `#3C8D5A` · accent `#E8C547` · line `#D6E4D9`
- 字体：无衬线。
- 形状：圆角 28，卡片无描边，图标用圆形底衬。装饰 `corner-circle`（右上 `#D6E4D9`）。
- 封面：浅绿底，标题左上，右侧三个错落的圆形装饰。
- 避免：红色警示以外的任何暖色大面积使用。

### 6 · 霓虹夜（neon）— 科技感

- 气质：前沿、动感。适合技术分享、产品发布、数据主题。
- 七色：bg `#0F1220` · surface `#181C2E` · text `#E6E8F2` · muted `#8B90AD` · brand `#7C5CFF` · accent `#2EE6D6` · line `#2A2F4A`
- 字体：无衬线；数字用 bold 大字。
- 形状：圆角 16，卡片带 1px `line` 描边，允许一处 brand→accent 线性渐变用于焦点卡片或标题下划线。装饰 `thin-top-bar`（渐变色条）。
- 封面：深底，标题白字，标题下一条渐变线 320×6。
- 避免：发光与模糊（契约禁止 filter），超过一处渐变。

## 推荐规则

| 主题关键词 | 首推 | 备选 |
|---|---|---|
| 经营、财务、汇报、方案、投资 | 远洋蓝 | 素笺 |
| 周报、制度、流程、培训 | 素笺 | 松涛 |
| 发布会、战略、愿景 | 墨石 | 霓虹夜 |
| 品牌、文化、故事、生活 | 暖沙 | 松涛 |
| 教育、健康、环保、公益 | 松涛 | 素笺 |
| 技术、产品、数据、AI | 霓虹夜 | 墨石 |

标准模式：推荐一张并列出其余五张的一句话特征，用 `AskUserQuestion` 让用户选；快速模式直接用首推。

## 模板卡（随包模板包）

本 Skill 目录下 `templates/<id>/` 每包两个文件：

- `pack.json`：与 `design.json` 同结构，多两个键：`background.file`（`bg.svg`）与 `safeArea`（内容允许区域）。
- `bg.svg`：1280×720 的底图，根节点内只有一个 `<g id="tpl-bg">`。

用法：读 `pack.json` 生成 `design.json`（`source: "template-pack"`）；写每页 SVG 时把 `bg.svg` 里 `<g id="tpl-bg">…</g>` 整段复制到页面最前面（改 id 为 `tpl-bg-pNN`），内容元素只放在 `safeArea` 内。

随包三套：`clean-blue`（简报蓝，办公通用）、`deep-navy`（深海，商务）、`warm-sand`（暖沙，人文）。

用户自己的模板包放工作目录 `ppt-templates/<id>/`，结构完全相同（`pack.json` + `bg.svg`），Step 3 先扫它再扫随包的；Skill 升级只替换本 Skill 目录，不会碰工作目录。

## 用户风格库（`ppt-styles/`，Skill 升级不覆盖）

定制出来的风格别只活在当次的 `design.json` 里。保存成风格卡后，下次 Step 3 列在六张卡前面，标「你保存的」。

**什么时候存**：SKILL.md Step 5 第 7 条——风格来自沿用旧 PPT、自定义，或用户中途改过 token，标准模式交付前问一句；快速模式只提示；用户任何时候说「记住这套风格 / 存成风格卡」立即存。

**存成什么**：`<工作目录>/ppt-styles/<id>.json`，`<id>` 用短英文或拼音（如 `an-ye-qing`），内容 = 当前 `design.json` 去掉 `locked`，再加五个键：

```json
{
  "id": "an-ye-qing",
  "name": "暗夜青",
  "source": "user-style",
  "basedOn": "ink",
  "note": "深底青绿点睛，适合技术分享",
  "createdAt": "2026-09-14",
  "preview": "an-ye-qing.svg",
  "colors": { "bg": "#0F1418", "surface": "#1A2128", "text": "#EAF2F2", "muted": "#8FA3A8", "brand": "#2BD4BD", "accent": "#FFD166", "line": "#28323A" },
  "fonts": { "title": "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif", "body": "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif" },
  "shape": { "radius": 12, "cardStroke": false, "decor": "dot-grid" },
  "background": { "type": "color" },
  "footer": { "text": "", "pageNumber": true }
}
```

- `basedOn`：派生自哪张风格卡的 id、`template-pack:<id>`、`old-ppt`，或 `null`；`note` 是一句话特征，下次推荐时照念；`preview` 是同目录一张 1280×720 预览——把这次的封面 `p01.svg` 用 Bash `cp` 原样复制过去。
- 底图型风格（沿用旧 PPT）把 `background.dataUri` 与 `safeArea` 一起存进去，单张控制在 300KB 内。
- 同名 `<id>` 已存在时先用 `AskUserQuestion` 问「覆盖还是另存」，不要默默覆盖。
- 用 `Write` 写 JSON；写完 `ls ppt-styles/` 确认，并在交付里说一句「已存为风格卡「暗夜青」，下次做 PPT 直接选它」。

**下次怎么用**：Step 3 列出时按 `note` 推荐；选中后把 JSON 里的 token 原样写成 `design.json`（`source: "user-style"`，`id` 照抄，加 `locked: true`），后面流程不变。用户要改，就在这张卡的基础上派生，交付时再问要不要另存。

## 沿用用户的旧 PPT

1. 让用户给 .pptx 路径；`OfficeInspect mode=outline` 看页数。
2. 选最干净的一页当底图（优先内容页里元素最少的一页，其次末页）：`OfficeInspect mode=screenshot page=N outPath=<绝对路径>/ppt/<slug>/template/bg.png`。
3. `Read` 这张 PNG：记下品牌色（取标题条或色块的颜色）、Logo 位置、页脚位置，据此写 `safeArea`（避开 Logo 与页脚）。
4. `design.json` 的 `background` 写 `{ "type": "image", "dataUri": "data:image/png;base64,…", "safeArea": { … } }`；`colors.brand` 用截图取到的主色，其余按最接近的风格卡填。
5. 底图 PNG 会内嵌进每一页 SVG，单张控制在 300KB 内；太大就让用户提供更小的导出。
6. 如实告诉用户：这是「像素级沿用底图」，不是复用其母版；要真正复用母版请在 PowerPoint 里编辑原文件。

## 自定义（从现成的派生）

用户给了一点输入、又不想从头设计时，从最接近的东西派生，快：

- 用户给主色：以它为 `brand`，`accent` 取其互补或邻近的暖色，其余从最接近的风格卡继承。
- 用户给参考图：`Read` 看图，描述它的配色、字体气质、留白程度，映射到最接近的风格卡并改 `brand`。
- 用户只说感觉（「大气」「活泼」「稳重」）：按推荐规则表映射，并在回复里说明选了哪张、为什么。
- 派生结果同样写成完整的 `design.json`（`source: "derived"`），并在 README 记录来源；交付时按 SKILL.md Step 5 第 7 条问要不要存成风格卡。

**用户对派生结果也不满意、或一开始就说「都不要，我们一起设计」→ 进下面的共创模式，不要再往六张卡上套。**

## 和用户一起创造（共创模式）

风格卡、模板包、五种装饰、十二种页型都是起点，不是天花板。用户想要独一份的时候，Agent 是设计搭子，不是菜单：

1. **听清楚**：主题、场合、给谁看、喜欢与讨厌的颜色、有没有品牌手册 / 参考图 / 一句话感觉。有参考图就 `Read` 看，把看到的写成词（色相、明暗、留白、字重、气质）。
2. **出 2～3 个原创方向**（不从六张卡里挑，也不给它们换皮）：每个方向给一句气质、七色（照 `colors` 七个键）、字体气质（衬线 / 无衬线 / 混排，落到契约允许的字体栈上）、形状语言（圆角多大、卡片有无描边、留白密度）、一个新装饰点子（写成 `decorSpec`）、封面构图。用 `AskUserQuestion` 让用户挑一个，或说「A 的色 + B 的装饰」。
3. **落成 `design.json`**（`source: "co-created"`，`basedOn: null`），做**封面二选一**给用户看；用户要改就改，几轮都行，直到点头再 `locked: true`。
4. **定稿即沉淀**：交付前一定问要不要存成风格卡（「用户风格库」）；装饰或底图复杂到值得复用时，再问要不要顺手打成模板包——把定稿封面的背景层抽成 `ppt-templates/<id>/bg.svg`（根节点内只放一个 `<g id="tpl-bg">`），`pack.json` 照 design.json 的结构加 `background.file` 与 `safeArea`。
5. **页型也可以新创**：03 的十二种是起点，用户想要没见过的版式就一起画，先写清结构再动手，密度与间距硬规则照过。

只有三条不让步：契约允许的元素与字体栈、对比度与密度硬规则、数字不编造。其余都是用户说了算。

## 封面二选一

标准模式写两版封面：A 版按风格卡的封面构图建议，B 版换一种构图（居中 vs 左下、满版色 vs 浅底）。用 `OfficeCreate` 建临时 `preview/cover.pptx`，两页各贴一版，`OfficeInspect mode=screenshot grid=2` 截成一张给用户看，`AskUserQuestion` 让用户选，选定后把它改名为 `p01.svg`，删掉另一版与临时文件。
