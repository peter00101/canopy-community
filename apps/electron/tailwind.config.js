/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}',
    // @canopy/ui 以源码形式被 renderer 引用，其类名同样需要扫描生成
    '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  // 主题 class 由运行时根据设置拼接到 <html>，Tailwind 无法从 TSX 静态扫描到。
  // 必须 safelist，否则 @layer base 中对应的 CSS 变量块会在构建时被裁掉。
  safelist: [
    'theme-ocean-light',
    'theme-ocean-dark',
    'theme-forest-light',
    'theme-forest-dark',
    'theme-slate-light',
    'theme-slate-dark',
    'theme-terminal-dark',
    'theme-latte-light',
    'theme-lavender-light',
    'theme-ink-dark',
    'theme-spruce-light',
    'theme-spruce-dark',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        dialog: {
          DEFAULT: 'hsl(var(--dialog))',
          foreground: 'hsl(var(--dialog-foreground))',
        },
        tooltip: {
          DEFAULT: 'hsl(var(--tooltip) / <alpha-value>)',
          foreground: 'hsl(var(--tooltip-foreground) / <alpha-value>)',
          muted: 'hsl(var(--tooltip-muted) / <alpha-value>)',
        },
        'content-area': 'hsl(var(--content-area) / <alpha-value>)',
        // ===== 配色体系（globals.css「palette contract」）=====
        // accent-2 第二色相：当前项 / 选中态 / chip；四个状态色各带 soft 底；fg-2/fg-3 次要文字实色；line-1/2/3 三档线
        'accent-2': {
          DEFAULT: 'hsl(var(--accent-2) / <alpha-value>)',
          foreground: 'hsl(var(--accent-2-foreground) / <alpha-value>)',
          soft: 'hsl(var(--accent-2-soft) / <alpha-value>)',
          'soft-foreground': 'hsl(var(--accent-2-soft-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
          soft: 'hsl(var(--success-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
          soft: 'hsl(var(--warning-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          foreground: 'hsl(var(--danger-foreground) / <alpha-value>)',
          soft: 'hsl(var(--danger-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          foreground: 'hsl(var(--info-foreground) / <alpha-value>)',
          soft: 'hsl(var(--info-soft) / <alpha-value>)',
        },
        'fg-2': 'hsl(var(--fg-2) / <alpha-value>)',
        'fg-3': 'hsl(var(--fg-3) / <alpha-value>)',
        'palette-1': 'hsl(var(--palette-1) / <alpha-value>)',
        'palette-2': 'hsl(var(--palette-2) / <alpha-value>)',
        'palette-3': 'hsl(var(--palette-3) / <alpha-value>)',
        'palette-4': 'hsl(var(--palette-4) / <alpha-value>)',
        'palette-5': 'hsl(var(--palette-5) / <alpha-value>)',
        'palette-6': 'hsl(var(--palette-6) / <alpha-value>)',
        'line-1': 'hsl(var(--line-1) / <alpha-value>)',
        'line-2': 'hsl(var(--line-2) / <alpha-value>)',
        'line-3': 'hsl(var(--line-3) / <alpha-value>)',
      },
      // ===== 字体栈：Inter Variable 优先，回退 SF Pro Text / 系统中文字体 =====
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'PingFang SC',
          'Segoe UI',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
      },
      // ===== 圆角：覆写 shadcn 标准三档，全部由 --radius 派生 =====
      // 改一处 --radius 即可整站统一调圆角节奏，无需 grep 替换 300+ 处 rounded-*
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        DEFAULT: 'calc(var(--radius) - 2px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + var(--radius-xl-extra, 2px))',
        '2xl': 'calc(var(--radius) + var(--radius-2xl-extra, 4px))',
      },
      // ===== 阴影：覆写 Tailwind 内置的 sm/md/lg/xl/DEFAULT =====
      // 现有 78 处 shadow-md / shadow-lg 等代码无需改动，自动吃多层柔阴影 + 主题自适应
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-xl)',
      },
      // ===== 动效语汇：三档时长 + 两条缓动，真源在 globals.css 的 :root =====
      // 既有的 duration-150 / duration-200 等数值类名照常可用，不做强行替换；
      // 新代码写 duration-fast / duration-normal / ease-standard 这类语义档。
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        'out-soft': 'var(--ease-out-soft)',
        standard: 'var(--ease-standard)',
      },
      keyframes: {
        'slide-in-from-top': {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-in-from-bottom': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'slide-out-to-right': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(100%)' },
        },
        'preview-slide-out': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(100%)' },
        },
      },
      animation: {
        'in': 'slide-in-from-top 0.3s ease-out',
        'out': 'slide-out-to-right 0.2s ease-in',
        'preview-slide-out': 'preview-slide-out 0.25s ease-out forwards',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('tailwindcss-animate'),
  ],
}
