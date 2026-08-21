/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // 语义色 token：全部指向 theme.css 中的 CSS 变量（唯一颜色来源），
      // 深浅色自动切换，组件无需再写 dark: 前缀。
      colors: {
        primary: 'var(--color-primary)',
        primaryHover: 'var(--color-primary-hover)',
        primaryLight: 'var(--color-primary-light)',
        primarySoft: 'var(--color-primary-soft)',
        accent: 'var(--color-accent)',
        accentSoft: 'var(--color-accent-soft)',
        danger: 'var(--color-danger)',
        warning: 'var(--color-warning)',
        success: 'var(--color-success)',
        canvas: 'var(--color-canvas)',
        surface: 'var(--color-surface)',
        surfaceSubtle: 'var(--color-surface-subtle)',
        line: 'var(--color-line)',
        ink: 'var(--color-ink)',
        inkSecondary: 'var(--color-ink-secondary)',
        inkMuted: 'var(--color-ink-muted)',
      },
      fontFamily: {
        sans: ['Noto Sans SC', 'Microsoft YaHei', 'system-ui', 'sans-serif']
      }
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
}
