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

  const menus: { label: string; items: MenuProps['items'] }[] = [
    {
      label: '编辑',
      items: [
        { key: 'undo', label: '撤销', onClick: () => doEdit('undo') },
        { key: 'redo', label: '重做', onClick: () => doEdit('redo') },
        { type: 'divider' },
        { key: 'cut', label: '剪切', onClick: () => doEdit('cut') },
        { key: 'copy', label: '复制', onClick: () => doEdit('copy') },
        { key: 'paste', label: '粘贴', onClick: () => doEdit('paste') },
        { key: 'selectAll', label: '全选', onClick: () => doEdit('selectAll') }
      ]
    },
    {
      label: '视图',
      items: [
        { key: 'reload', label: '重新加载', onClick: () => window.location.reload() },
        { key: 'devtools', label: '开发者工具', onClick: () => window.electronAPI.app.openDevTools() },
        { type: 'divider' },
        { key: 'zoomin', label: '放大', onClick: () => window.electronAPI.app.zoom('in') },
        { key: 'zoomout', label: '缩小', onClick: () => window.electronAPI.app.zoom('out') },
        { key: 'zoomreset', label: '重置缩放', onClick: () => window.electronAPI.app.zoom('reset') },
        { type: 'divider' },
        {
          key: 'fullscreen',
          label: isFullscreen ? '退出全屏' : '切换全屏',
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
        { key: 'quit', label: '退出', onClick: () => { window.electronAPI.app.quit() } }
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
      className="app-titlebar h-9 flex items-center px-3 gap-1 select-none shrink-0 bg-surface"
      onDoubleClick={handleDoubleClick}
    >
      <img src={iconPng} alt="Hermes" className="w-4 h-4 mr-1 pointer-events-none" draggable={false} />
      <span className="text-xs font-medium text-inkSecondary whitespace-nowrap">
        Hermes 人事行政一体化智能专家
      </span>

      <div className="flex items-center ml-3">
        {menus.map(m => (
          <Dropdown key={m.label} menu={{ items: m.items }} trigger={['click']}>
            <button className="px-2 py-1 rounded text-xs text-inkSecondary hover:bg-surfaceSubtle dark:hover:bg-canvas transition-colors">
              {m.label}
            </button>
          </Dropdown>
        ))}
      </div>

      <div className="flex-1" />

      {/* 窗口控制按钮 */}
      <div className="flex items-center">
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
