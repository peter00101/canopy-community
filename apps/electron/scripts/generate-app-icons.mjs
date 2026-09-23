/**
 * 应用图标生成脚本
 *
 * 从内嵌的品牌 SVG（紫色渐变圆角方块 + 白色 C 树冠）渲染出：
 * - resources/icon.png   1024×1024（macOS dock / Linux / 品牌素材）
 * - resources/icon.ico   Windows 多尺寸（PNG-in-ICO，Vista+）
 * - resources/icon.icns  macOS 多尺寸（PNG-in-ICNS）
 *
 * 用法：node scripts/generate-app-icons.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources')

// C 树冠 mark 沿用 canopy-logos/icon.svg 的几何（64 视图 ×16 映射到 1024），
// 线宽略加粗以保证 16px 下仍可辨识。
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9F6FFF"/>
      <stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="204" fill="url(#bg)"/>
  <path d="M704 256 A320 320 0 1 0 704 768" stroke="#FFFFFF" stroke-width="92" stroke-linecap="round" fill="none"/>
  <path d="M576 448 Q672 320 800 352" stroke="#FFFFFF" stroke-width="46" stroke-linecap="round" fill="none"/>
  <path d="M576 448 Q608 544 576 640" stroke="#FFFFFF" stroke-width="46" stroke-linecap="round" fill="none"/>
</svg>`

const svgBuffer = Buffer.from(SVG)

async function renderPng(size) {
  return sharp(svgBuffer, { density: 300 }).resize(size, size).png().toBuffer()
}

/** ICO 容器：目录头 + 每尺寸 PNG 数据（Vista+ 原生支持 PNG-in-ICO） */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dirSize = 16 * entries.length
  let offset = 6 + dirSize
  const dirs = []
  for (const { size, data } of entries) {
    const dir = Buffer.alloc(16)
    dir.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1) // height
    dir.writeUInt8(0, 2) // palette
    dir.writeUInt8(0, 3) // reserved
    dir.writeUInt16LE(1, 4) // planes
    dir.writeUInt16LE(32, 6) // bpp
    dir.writeUInt32LE(data.length, 8)
    dir.writeUInt32LE(offset, 12)
    offset += data.length
    dirs.push(dir)
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)])
}

/** ICNS 容器：'icns' 魔数 + 各尺寸 PNG 块 */
function buildIcns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

const png1024 = await renderPng(1024)
writeFileSync(join(outDir, 'icon.png'), png1024)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoEntries = []
for (const size of icoSizes) {
  icoEntries.push({ size, data: await renderPng(size) })
}
writeFileSync(join(outDir, 'icon.ico'), buildIco(icoEntries))

const icnsTypes = [
  ['ic11', 32],   // 16@2x
  ['ic12', 64],   // 32@2x
  ['ic07', 128],
  ['ic13', 256],  // 128@2x
  ['ic08', 256],
  ['ic14', 512],  // 256@2x
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
]
const icnsEntries = []
for (const [type, size] of icnsTypes) {
  icnsEntries.push({ type, data: await renderPng(size) })
}
writeFileSync(join(outDir, 'icon.icns'), buildIcns(icnsEntries))

console.log('generated: icon.png (1024), icon.ico (%s), icon.icns (%s chunks)', icoSizes.join('/'), icnsTypes.length)
