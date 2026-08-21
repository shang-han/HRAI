import React, { useEffect, useState } from 'react'
import { Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { MinusOutlined, BorderOutlined, CopyOutlined, CloseOutlined } from '@ant-design/icons'
import iconPng from '../assets/icon.png'

/**
 * 自绘标题栏：图标 + 系统名称 + 中文菜单 + 窗口控制按钮，同一行。
 * 整行可拖拽移动窗口（-webkit-app-region: drag），交互元素 no-drag。
 * 双击空白处 = 最大化/还原。
 */
const TitleBar: React.FC = () => {
  // 窗口最大化状态：图标在"最大化(口)"与"还原(双矩形)"之间切换
  const [maximized, setMaximized] = useState(false)
  // 页面全屏状态：菜单文案在"切换全屏"与"退出全屏"之间切换
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    window.electronAPI.app.isMaximized().then(setMaximized).catch(() => {})
    return window.electronAPI.app.onMaximizedChange(setMaximized)
  }, [])

  useEffect(() => {
    const update = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  /** 菜单项：右侧显示快捷键提示 */
  const withShortcut = (label: string, shortcut?: string) =>
    shortcut
      ? (
        <span className="flex items-center justify-between gap-8">
          <span>{label}</span>
          <span className="text-inkMuted text-xs">{shortcut}</span>
        </span>
      )
      : label

  // 原生菜单被移除后，注册全局快捷键（仅拦截本应用定义的组合键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        window.location.reload()
        return
      }
      if (ctrl && e.shiftKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        window.electronAPI.app.openDevTools()
        return
      }
      if (e.key === 'F12') {
        e.preventDefault()
        window.electronAPI.app.openDevTools()
        return
      }
      if (ctrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        window.electronAPI.app.zoom('in')
        return
      }
      if (ctrl && e.key === '-') {
        e.preventDefault()
        window.electronAPI.app.zoom('out')
        return
      }
      if (ctrl && e.key === '0') {
        e.preventDefault()
        window.electronAPI.app.zoom('reset')
        return
      }
      if (e.key === 'F11') {
        e.preventDefault()
        if (document.fullscreenElement) {
          document.exitFullscreen()
        } else {
          document.documentElement.requestFullscreen()
        }
        return
      }
      if (ctrl && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault()
        window.electronAPI.app.quit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const menus: { label: string; items: MenuProps['items'] }[] = [
    {
      label: '编辑',
      items: [
        { key: 'undo', label: withShortcut('撤销', 'Ctrl+Z'), onClick: () => doEdit('undo') },
        { key: 'redo', label: withShortcut('重做', 'Ctrl+Y'), onClick: () => doEdit('redo') },
        { type: 'divider' },
        { key: 'cut', label: withShortcut('剪切', 'Ctrl+X'), onClick: () => doEdit('cut') },
        { key: 'copy', label: withShortcut('复制', 'Ctrl+C'), onClick: () => doEdit('copy') },
        { key: 'paste', label: withShortcut('粘贴', 'Ctrl+V'), onClick: () => doEdit('paste') },
        { key: 'selectAll', label: withShortcut('全选', 'Ctrl+A'), onClick: () => doEdit('selectAll') }
      ]
    },
    {
      label: '视图',
      items: [
        { key: 'reload', label: withShortcut('重新加载', 'Ctrl+R'), onClick: () => window.location.reload() },
        { key: 'devtools', label: withShortcut('开发者工具', 'F12'), onClick: () => window.electronAPI.app.openDevTools() },
        { type: 'divider' },
        { key: 'zoomin', label: withShortcut('放大', 'Ctrl+='), onClick: () => window.electronAPI.app.zoom('in') },
        { key: 'zoomout', label: withShortcut('缩小', 'Ctrl+-'), onClick: () => window.electronAPI.app.zoom('out') },
        { key: 'zoomreset', label: withShortcut('重置缩放', 'Ctrl+0'), onClick: () => window.electronAPI.app.zoom('reset') },
        { type: 'divider' },
        {
          key: 'fullscreen',
          label: withShortcut(isFullscreen ? '退出全屏' : '切换全屏', 'F11'),
          onClick: () => {
            if (document.fullscreenElement) {
              document.exitFullscreen()
            } else {
              document.documentElement.requestFullscreen()
            }
          }
        }
      ]
    },
    {
      label: '窗口',
      items: [
        { key: 'minimize', label: '最小化', onClick: () => window.electronAPI.app.minimize() },
        { key: 'maximize', label: '最大化/还原', onClick: () => window.electronAPI.app.toggleMaximize() },
        { key: 'close', label: '关闭窗口', onClick: () => window.electronAPI.app.close() },
        { type: 'divider' },
        { key: 'quit', label: withShortcut('退出', 'Ctrl+Q'), onClick: () => { window.electronAPI.app.quit() } }
      ]
    },
    {
      label: '帮助',
      items: [
        { key: 'about', label: '关于系统', onClick: () => window.electronAPI.app.about() }
      ]
    }
  ]

  const handleDoubleClick = (e: React.MouseEvent) => {
    // 双击按钮/菜单不放行，只响应标题栏空白处
    if ((e.target as HTMLElement).closest('button')) return
    window.electronAPI.app.toggleMaximize()
  }

  return (
    <div
      className="app-titlebar relative h-9 flex items-center px-3 gap-1 select-none shrink-0"
      onDoubleClick={handleDoubleClick}
    >
      {/* 拖拽区元素自身保持透明：Electron 对 app-region: drag 的元素按矩形
          处理、不参与圆角裁剪，底色必须由普通背景层负责绘制（带圆角），
          否则标题栏方角会画到窗口圆角之外。 */}
      <div className="absolute inset-0 bg-canvas rounded-t-xl pointer-events-none" aria-hidden />
      <img src={iconPng} alt="Hermes" className="relative w-4 h-4 mr-1 pointer-events-none" draggable={false} />
      <span className="relative text-xs font-medium text-inkSecondary whitespace-nowrap">
        Hermes 人事行政一体化智能专家
      </span>

      <div className="relative flex items-center ml-3">
        {menus.map(m => (
          <Dropdown key={m.label} menu={{ items: m.items }} trigger={['click']}>
            <button className="px-2 py-1 rounded text-xs text-inkSecondary hover:bg-surfaceSubtle dark:hover:bg-canvas transition-colors">
              {m.label}
            </button>
          </Dropdown>
        ))}
      </div>

      <div className="relative flex-1" />

      {/* 窗口控制按钮 */}
      <div className="relative flex items-center">
        <button
          title="最小化"
          onClick={() => window.electronAPI.app.minimize()}
          className="p-2 rounded hover:bg-surfaceSubtle dark:hover:bg-canvas text-inkSecondary"
        >
          <MinusOutlined className="text-xs" />
        </button>
        <button
          title={maximized ? '还原' : '最大化'}
          onClick={() => window.electronAPI.app.toggleMaximize()}
          className="p-2 rounded hover:bg-surfaceSubtle dark:hover:bg-canvas text-inkSecondary"
        >
          {maximized ? <CopyOutlined className="text-xs" /> : <BorderOutlined className="text-xs" />}
        </button>
        <button
          title="关闭窗口（隐藏到托盘，服务继续运行）"
          onClick={() => window.electronAPI.app.close()}
          className="p-2 rounded hover:bg-red-500 hover:text-white text-inkSecondary"
        >
          <CloseOutlined className="text-xs" />
        </button>
      </div>
    </div>
  )
}

/** 编辑菜单：对当前聚焦的输入框执行编辑命令（仅输入框聚焦时生效） */
function doEdit(cmd: string) {
  try {
    document.execCommand(cmd)
  } catch { /* 不支持时静默忽略 */ }
}

export default TitleBar
