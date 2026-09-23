/**
 * 品牌 Logo 变体生成脚本
 *
 * 以 C 树冠 mark（与应用图标一致的几何）为基础，按配色生成全部变体，
 * 直接覆盖三处消费方的同名文件：
 * - src/renderer/assets/bots/canopy-logos/  设置页「应用图标」「品牌 Logo 下载」展示
 * - resources/canopy-logos/                 品牌素材下载（满幅方形原版）
 * - resources/canopy-logos/dock/            macOS dock.setIcon 专用（圆角 + 透明边距）
 * - src/renderer/assets/models/canopy.png   聊天头像与内置渠道 logo（渐变主视觉）
 *
 * macOS Dock 不会给自定义图标套系统圆角模板，圆角与留白必须烘焙进位图，
 * 因此 dock/ 版本套用与 generate-app-icons.mjs 默认图标一致的几何：
 * 64 视图中内容缩入 (4,4)..(60,60)、rx 12.75 的圆角方块（即 1024 下留白 64、rx 204）。
 *
 * 用法：node scripts/generate-brand-logos.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 512
const DOCK_SIZE = 1024

/** C 树冠 mark 路径（64 viewBox，×8 到 512） */
function markPaths(stroke, mainWidth = 5.5, twigWidth = 2.75) {
  return `
  <path d="M44 16 A20 20 0 1 0 44 48" stroke="${stroke}" stroke-width="${mainWidth}" stroke-linecap="round" fill="none"/>
  <path d="M36 28 Q42 20 50 22" stroke="${stroke}" stroke-width="${twigWidth}" stroke-linecap="round" fill="none"/>
  <path d="M36 28 Q38 34 36 40" stroke="${stroke}" stroke-width="${twigWidth}" stroke-linecap="round" fill="none"/>`
}

/** 背景底板：满幅方形（品牌素材）或 Dock 圆角方块（留白 + rx，与默认应用图标一致） */
function bgRect(fill, dock) {
  return dock
    ? `<rect x="4" y="4" width="56" height="56" rx="12.75" fill="${fill}"/>`
    : `<rect width="64" height="64" fill="${fill}"/>`
}

/** 纯色 / 渐变底 + 单色 C */
function solidSvg(bg, stroke, dock = false) {
  const fill = Array.isArray(bg)
    ? `url(#bg)`
    : bg
  const defs = Array.isArray(bg)
    ? `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs>`
    : ''
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  ${defs}
  ${bgRect(fill, dock)}
  ${markPaths(stroke)}
</svg>`
}

/** 透明底：无背景，仅品牌紫 mark（无底板可圆角，Dock 版与原版一致） */
function transparentSvg() {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  ${markPaths('#7C3AED')}
</svg>`
}

/** 赛博朋克：深夜底 + 霓虹渐变描边 */
function cyberpunkSvg(dock = false) {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="neon" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FF2EE6"/>
      <stop offset="1" stop-color="#00E5FF"/>
    </linearGradient>
  </defs>
  ${bgRect('#0B0B16', dock)}
  ${markPaths('url(#neon)')}
</svg>`
}

/** 未来质感：金属银渐变底 + 深灰 mark */
function futuristicSvg(dock = false) {
  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E4E4EC"/>
      <stop offset="0.5" stop-color="#B7B7C4"/>
      <stop offset="1" stop-color="#8E8E9E"/>
    </linearGradient>
  </defs>
  ${bgRect('url(#metal)', dock)}
  ${markPaths('#3A3A46')}
</svg>`
}

/** 变体定义：文件名与两处消费目录的现有命名保持一致 */
const VARIANTS = [
  { file: 'canopy-black.png', svg: (dock) => solidSvg('#171717', '#FFFFFF', dock) },
  { file: 'canopy-white.png', svg: (dock) => solidSvg('#FFFFFF', '#7C3AED', dock) },
  { file: 'canopy-blue.png', svg: (dock) => solidSvg('#1E3A8A', '#FFFFFF', dock) },
  { file: 'canopy-purple.png', svg: (dock) => solidSvg('#6D28D9', '#FFFFFF', dock) },
  { file: 'canopy-gradient.png', svg: (dock) => solidSvg(['#9F6FFF', '#7C3AED'], '#FFFFFF', dock) },
  { file: 'canopy-transparent.png', svg: () => transparentSvg() },
  { file: 'canopy-coral.png', svg: (dock) => solidSvg('#FF6F61', '#FFFFFF', dock) },
  { file: 'canopy-veri-peri.png', svg: (dock) => solidSvg('#6667AB', '#FFFFFF', dock) },
  { file: 'canopy-viva-magenta.png', svg: (dock) => solidSvg('#BB2649', '#FFFFFF', dock) },
  { file: 'canopy-mocha-mousse.png', svg: (dock) => solidSvg('#A47864', '#FFFFFF', dock) },
  { file: 'canopy-emerald.png', svg: (dock) => solidSvg('#009B77', '#FFFFFF', dock) },
  { file: 'canopy-cyberpunk.png', svg: (dock) => cyberpunkSvg(dock) },
  { file: 'canopy-futuristic.png', svg: (dock) => futuristicSvg(dock) },
]

async function renderPng(svg, size = SIZE) {
  return sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toBuffer()
}

/** 8bit 像素版：低分辨率渲染后最近邻放大，得到像素化效果 */
async function render8bit() {
  const low = await sharp(Buffer.from(solidSvg('#171717', '#FFFFFF')), { density: 72 })
    .resize(24, 24)
    .png()
    .toBuffer()
  return sharp(low).resize(SIZE, SIZE, { kernel: 'nearest' }).png().toBuffer()
}

/** 8bit Dock 版：像素画栅格缩入圆角方块（底板圆角平滑，像素质感保留） */
async function render8bitDock(eightBit) {
  const inner = Math.round(DOCK_SIZE * 56 / 64)
  const margin = (DOCK_SIZE - inner) / 2
  const radius = Math.round(inner * 12.75 / 56)
  const mask = await sharp(Buffer.from(
    `<svg width="${inner}" height="${inner}"><rect width="${inner}" height="${inner}" rx="${radius}" fill="#fff"/></svg>`
  )).png().toBuffer()
  const scaled = await sharp(eightBit).resize(inner, inner, { kernel: 'nearest' }).png().toBuffer()
  return sharp(scaled)
    .composite([{ input: mask, blend: 'dest-in' }])
    .extend({ top: margin, bottom: margin, left: margin, right: margin, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

const targets = [
  join(root, 'src/renderer/assets/bots/canopy-logos'),
  join(root, 'resources/canopy-logos'),
]
const dockDir = join(root, 'resources/canopy-logos/dock')
mkdirSync(dockDir, { recursive: true })

for (const { file, svg } of VARIANTS) {
  const buf = await renderPng(svg(false))
  for (const dir of targets) {
    writeFileSync(join(dir, file), buf)
  }
  writeFileSync(join(dockDir, file), await renderPng(svg(true), DOCK_SIZE))
}

const eightBit = await render8bit()
for (const dir of targets) {
  writeFileSync(join(dir, 'canopy-8bit.png'), eightBit)
}
writeFileSync(join(dockDir, 'canopy-8bit.png'), await render8bitDock(eightBit))

// 聊天头像 / 内置渠道 logo：渐变主视觉
const avatar = await renderPng(solidSvg(['#9F6FFF', '#7C3AED'], '#FFFFFF'))
writeFileSync(join(root, 'src/renderer/assets/models/canopy.png'), avatar)

// 未知模型的兜底头像（欢迎对话等无模型消息使用）：中性黑底
const fallback = await renderPng(solidSvg('#171717', '#FFFFFF'))
writeFileSync(join(root, 'src/renderer/assets/models/default.png'), fallback)

console.log('generated %d logo variants × %d targets + %d dock variants + chat avatar + fallback', VARIANTS.length + 1, targets.length, VARIANTS.length + 1)
