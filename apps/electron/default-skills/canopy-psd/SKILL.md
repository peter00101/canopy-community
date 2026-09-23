---
name: canopy-psd
description: Canopy 的 PSD（Photoshop 分层文件）制作与修改总控。当用户要做海报、封面、Banner、社媒配图、UI 稿、多画板分层设计稿，要把设计交付成可在 Photoshop 里继续编辑的 .psd（文字层、矢量形状层、调整层、画板、智能对象都是原生对象），或要读取 / 修改一份已有 .psd（改文字、换图、显隐图层、单独导出某一层）时使用。用内置的 PsdInspect / PsdCompose / PsdEdit 工具，不需要用户装 Photoshop 或 Python。
group: canopy
version: "1.0.1"
---

# Canopy PSD 总控

## 这个 Skill 做什么

把「做一份分层设计稿」拆成可检查的几步，最后交付 **Photoshop 能打开、图层齐全、文字可编辑** 的 `.psd`，外加一张同名的 `-preview.png`：

| 步 | 产物 | 用户能控制什么 |
|---|---|---|
| 0 引擎 | 默认内置，不探测不问 | 只在任务确实要高保真时选装不装 psd-tools |
| 0.5 需求 | 一次问清 | 尺寸 / 用途 / 风格 / 文案 / 素材 |
| 1 图层规划 | 图层清单（自下而上） | 分几层、哪些要单独可动 |
| 2 逐层绘制 | 每个视觉元素一份 SVG（或图片） | 颜色、形状、留白 |
| 3 合成 | `PsdCompose` → `.psd` + 预览图 | — |
| 4 自检 | `PsdInspect` 看图 | 文字溢出、重叠、留白不均 |
| 5 修改 | `PsdEdit` 改字 / 换图 / 调层 | 一句话改一处 |

**硬规矩**
- 只用 `PsdCompose` / `PsdEdit` 生成和修改 PSD，只用 `PsdInspect` 读图层信息；**不要**写 Python / PIL / psd-tools 脚本，也不要自己写脚本去解析 PSD 二进制（图层类型、参数、效果以 `PsdInspect` 的结果为准，它读不出的就如实说读不出），不要让用户装 Photoshop。装不装 psd-tools 按下面「Step 0」走，**不要擅自 `pip install`**。
- 每个独立视觉元素一层：背景、装饰、主体、文字各自成层，用户才能在 Photoshop 里单独移动、换色、删掉。
- 文字**永远用 `text` 图层**，不要画进 SVG——画进去就不能改字了。
- 几何元素（按钮、色块、圆、多边形、简单路径）**优先用 `shape` 图层**，它在 Photoshop 里是可拖锚点、可改填充描边的矢量形状；只有渐变 / 滤镜 / 复杂插画才用 `svg`。
- 调色（压暗、去色、反相、色相偏移、色罩）用 `adjustment` 图层而不是改素材本身——用户能随时关掉或改参数；只想调某一层就加 `clipToBelow: true`。
- 多尺寸 / 多页交付用 `artboard`：一份文件里放几块画板，每块自带尺寸与底色，子层坐标相对画板。
- 用户给的照片 / 产品图想保留原图质量、以后可替换：`image` 加 `smartObject: true`。
- 做完必须 `PsdInspect`（或看 `PsdCompose` 返回的图）再交付；看图判断，不要凭规格猜。
- 素材文件（图片 / SVG / 蒙版）先放进当前工作目录再引用；工具只能读写会话授权目录内的文件。

## Step 0：渲染引擎——默认内置，不必探测也不必问

Canopy 随包自带 PSD 引擎（读写 / 文字渲染 / 合成全在），**默认直接用，不探测环境、不问用户**。用户机器上装了 Python + psd-tools 时，Canopy 会自己探测并自动切到高保真引擎；每次 `PsdInspect` / `PsdCompose` 的结果里都写着本次用的引擎，缺 psd-tools 时会提醒一句。你不需要自己去跑 `python -c "import psd_tools"`。

只有下面这种情况才值得问：**结果提示缺 psd-tools，且用户的任务确实要高保真**——读别人用 Photoshop 做的、带复杂混合模式 / 大量图层效果 / 曲线色阶类调整层的文件，预览与 Photoshop 差得多会误导判断。这时调用 `AskUserQuestion` 问一次，给两个选项：
1. 「安装 psd-tools」——说清楚：装进本机当前 Python（需要 Python 3.9+，Windows 上矢量描边组件需要 3.11+），约 120 MB，命令 `python -m pip install "psd-tools[composite]"`（国内慢就加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`）；用户选了才执行，装完**直接再调一次 PSD 工具**即可，Canopy 会自动重新探测，不用重启
2. 「用内置引擎继续」——按现状做，交付时说明预览为近似渲染

其余情况（Canopy 自己生成的文件、普通海报 / Banner / 社媒图）内置引擎足够，**不要打断用户**；本机没有 Python 时也不要引导去装 Python，直接内置引擎做完并在交付时补一句。问过一次之后本轮不要再问第二次。

## Step 0.5：先问清需求（一次问完，别分多轮）

尺寸与用途（海报 1080×1920 / 公众号头图 900×383 / 小红书 1242×1660 / A4 300dpi 2480×3508 / 用户自定）；风格（简约 / 国潮 / 科技 / 手绘 / 沿用用户模板）；文案（标题、副标题、正文、落款）；素材（用户给图 / 用 SVG 画 / 纯色渐变）；交付要求（是否要透明背景、多画板、参考线）。用户说「你看着办」就按下面默认值走，并在交付时说明。

默认：1080×1920、72 dpi、白底、字体 Microsoft YaHei（Windows）/ PingFang SC（mac）。

## Step 1：图层规划

先列清单再动手，格式（自下而上）：

```
0 背景：fill 纯色 / 渐变 SVG（铺满）
1 装饰：shape 几何色块（ellipse / rect 圆角 / polygon），opacity 0.6，可加 outerGlow
2 主体：用户图片（image，smartObject: true）或手绘 SVG（如立体圆柱体：顶面椭圆 + 渐变柱身 + 投影分三层更好改）
3 调色：adjustment（如 brightness/contrast 压暗主体，clipToBelow: true）
4 标题：text，fontSize 96，bold，dropShadow
5 副标题：text
6 按钮 / 标签：shape rect + radius + stroke，文字另起 text 层
7 落款 / 二维码：image
```

复杂稿用 `group` 分组（「主视觉」「文案」「装饰」），Photoshop 里折叠整齐；多尺寸交付（封面 + 内页、横版 + 竖版）用 `artboard`，每块画板一组清单。

## Step 2：逐层画 SVG（规格见 `references/01-spec.md`）

- 每份 SVG **声明与目标区域一致的 `width` / `height`**；铺满画布的层就用文档尺寸，局部元素用元素尺寸再给 `left` / `top`。
- 允许渐变、透明度、滤镜（`feGaussianBlur` 等）、`clipPath`——栅格化后都保真；不要用外链图片和 `<text>`（文字走 text 图层）。
- 手绘立体感：叠 2～3 个渐变形状（亮面 / 暗面 / 高光）比一个复杂滤镜稳。
- 想让用户以后能改形状：把 SVG 源文件也留在项目目录里，交付时告诉用户。

## Step 3：合成

小稿直接内联 `spec`；层多或 SVG 长就写成 `spec.json` 文件再传 `specPath`（相对路径以 spec 文件所在目录为基准）。返回的图片就是合成结果。

## Step 4：自检（必做）

看图核对：文字是否溢出画布或文本框（工具会提醒）、元素是否重叠、四边留白是否均匀、对比度是否够。有问题改规格后 `overwrite: true` 重新合成，或用 `PsdEdit` 局部改。想单看某一层（比如确认主体抠得干不干净、按钮描边对不对）：`PsdInspect` 传 `layer`（id 或名字），返回那一层自己的像素（透明背景）。

## Step 5：修改已有 PSD

先 `PsdInspect` 拿图层 id / 名字，再一次 `PsdEdit` 把所有操作一起给（顺序执行）：`setText` 改字（仍是可编辑文字层）、`replaceImage` 换图、`setVisible` / `setOpacity` / `setBlendMode`、`move`、`rename`、`remove`、`setEffects`、`addLayer`（可加 shape / adjustment / artboard / 智能对象）。默认写回原文件；用户没说要覆盖时给 `outputPath` 另存。用户要「某一层单独导出成 PNG」：`PsdInspect` 传 `layer` 看到的就是它，再用 Write 之外的方式——直接告诉用户预览 PNG 路径或让用户在 Photoshop 里导出；工具不负责落地单层 PNG 文件。

## 交付时怎么说

给用户：文件路径、画板 / 图层清单（自上而下，说明哪些是矢量形状、调整层、智能对象——用户在 Photoshop 里能继续改）、字体名（Photoshop 缺字体会提示替换，文字不丢）、预览图是近似渲染（图层效果与调整层以 Photoshop 实时结果为准）、SVG 源文件位置（如有）。**不要**提上游库或实现细节。

## 边界（如实告诉用户）

- 不支持 `.psb`（超大文档）；CMYK 文件按 RGB 近似显示。
- `shape` 的 `path` 只认 M L H V C Q Z（圆弧 A 与简写 S / T 请改写成三次贝塞尔）；写不进矢量时会自动退成普通像素层并提醒。
- 调整层只开放常用十种；曲线 / 色阶 / 可选颜色等 Photoshop 自己做的调整层读进来会保留在文件里，但预览不渲染它们。
- Photoshop 专有特性（智能滤镜、3D）用 `PsdEdit` 重写文件时可能丢失——改这类文件请另存到新路径并提醒用户核对。
- 文字层由 Canopy 预渲染像素，Photoshop 打开可能提示「更新文字图层」，点确认即可。
