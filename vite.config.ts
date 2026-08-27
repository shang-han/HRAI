import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * 样式文件变更时不做 HMR 注入，直接整页重载：
 * Electron 的窗口拖拽区（-webkit-app-region）在样式热更后
 * 会失效（拖不动窗口），整页重载才能恢复。
 * 注意：只 return [] 会被 vite 当作"已处理"静默吞掉，页面不会更新；
 * 必须主动下发 full-reload 才能真正自动刷新。仅影响开发模式。
 */
function fullReloadOnStyleChange(): Plugin {
  return {
    name: 'full-reload-on-style-change',
    handleHotUpdate(ctx) {
      if (/\.css$/.test(ctx.file)) {
        ctx.server.ws.send({ type: 'full-reload' })
        return []
      }
    }
  }
}

// Vite 只负责渲染进程 (renderer)
// 主进程 (main) 和 preload 由 esbuild 构建 (build-main.mjs)
export default defineConfig({
  plugins: [react(), fullReloadOnStyleChange()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
