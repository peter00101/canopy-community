import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // 音频文件永不内联成 data: URI：通知音经 fetch/XHR 加载后交 Web Audio 解码，
    // 两条路径都受 CSP connect-src 管辖（白名单无 data:）——默认的 4096 字节内联
    // 阈值曾让 11 个小音效文件双路被拦、静默无声（0.17.43 修复）。
    assetsInlineLimit: (filePath: string) =>
      /\.(mp3|wav|ogg|m4a|flac)$/i.test(filePath) ? false : undefined,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // Chromium can resolve localhost to IPv4 while Vite binds only ::1 on macOS.
    // Use the same explicit IPv4 loopback address as Electron's dev windows.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
  },
})
