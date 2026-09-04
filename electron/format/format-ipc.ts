/**
 * 格式模板库 IPC 注册（P2 第 5 步）
 *
 * 薄薄一层转发：把 createFormatHandlers 生成的 { channel: handler } 注册到 ipcMain。
 * 真正的逻辑都在 format-handlers.ts（不依赖 electron，可单测）。
 *
 * 唯一的额外职责：给 format:exportAll / format:importAll 套一层系统文件对话框。
 * 原因：handlers 层刻意不 import electron，没法自己弹 dialog；而 file:export 的
 * 过滤器表里没有 json，复用不了。所以对话框在这里注入，handlers 只认 filePath。
 */

import { ipcMain } from 'electron'
import { SkeletonStore } from './skeleton-store'
import { createFormatHandlers, FormatHandlerOptions, FormatHandler } from './format-handlers'

export interface FormatIpcDialogs {
  /** 弹保存框拿导出路径；用户取消返回 null */
  saveJson: (defaultPath: string) => Promise<string | null>
  /** 弹打开框拿导入路径；用户取消返回 null */
  openJson: () => Promise<string | null>
}

export interface FormatIpcOptions extends FormatHandlerOptions {
  dialogs?: FormatIpcDialogs
}

export function registerFormatIpc(store: SkeletonStore, opts: FormatIpcOptions = {}): void {
  const handlers = createFormatHandlers(store, opts)

  // dialogs 只在主进程启动时注入；没注入时这两个通道退化为「必须显式传 filePath」
  if (opts.dialogs) {
    const { saveJson, openJson } = opts.dialogs
    const exportAll = handlers['format:exportAll'] as FormatHandler
    const importAll = handlers['format:importAll'] as FormatHandler

    handlers['format:exportAll'] = async (arg?: { filePath?: string }) => {
      const filePath = arg?.filePath || (await saveJson('hr-format-templates.json'))
      if (!filePath) return { success: false, message: '用户取消' }
      return exportAll({ filePath })
    }

    handlers['format:importAll'] = async (arg?: { filePath?: string }) => {
      const filePath = arg?.filePath || (await openJson())
      if (!filePath) return { success: false, message: '用户取消' }
      return importAll({ filePath })
    }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args))
  }
}
