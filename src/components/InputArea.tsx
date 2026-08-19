import React, { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useConfigStore } from '../store/configStore'
import { Button, Tooltip, Modal } from 'antd'
import {
  SendOutlined,
  PaperClipOutlined,
  PictureOutlined,
  FileTextOutlined,
  AppstoreOutlined,
  ExportOutlined,
  SwapOutlined,
  StopOutlined
} from '@ant-design/icons'

const FALLBACK_COMMANDS = [
  { name: 'new', description: 'Start a new conversation (clear history and queued prompts)' },
  { name: 'stop', description: 'Stop the current generation and clear queued prompts' },
  { name: 'help', description: 'Show available commands' },
  { name: 'reset', description: 'Clear conversation history' },
  { name: 'model', description: 'Show or change current model', input_hint: 'model name' },
  { name: 'tools', description: 'List available tools' },
  { name: 'context', description: 'Show conversation context info' },
  { name: 'compress', description: 'Compress conversation context' },
  { name: 'steer', description: 'Inject guidance into the currently running agent turn', input_hint: 'guidance' },
  { name: 'queue', description: 'Queue a prompt to run after the current turn finishes', input_hint: 'prompt' },
  { name: 'version', description: 'Show Hermes version' },
]

const InputArea: React.FC = () => {
  const [inputText, setInputText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [intent, setIntent] = useState<{ hint?: string; id?: string } | null>(null)
  const [showRichFormatWarning, setShowRichFormatWarning] = useState(false)
  const [commands, setCommands] = useState<any[]>(FALLBACK_COMMANDS)
  const [commandIndex, setCommandIndex] = useState(0)
  const { sendMessage, isLoading, pendingMessages } = useSessionStore()
  const { layout, setInputMode } = useConfigStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isMultiLine = layout.inputMode === 'multi'

  // 斜杠命令补全
  const commandPrefix = inputText.startsWith('/') ? inputText.slice(1).toLowerCase() : ''
  const filteredCommands = inputText.startsWith('/')
    ? commands.filter(c =>
        c.name.toLowerCase().startsWith(commandPrefix) ||
        (commandPrefix.length > 0 && c.name.toLowerCase().includes(commandPrefix))
      )
    : []
  const showCommandMenu = inputText.startsWith('/') && filteredCommands.length > 0

  // 监听业务导航的 Prompt 填充事件
  // 兼容旧字符串载荷，同时接收 { text, intent } 对象（视觉无变化，intent 用于后端路由）
  useEffect(() => {
    const applyFill = (detail: any) => {
      if (typeof detail === 'string') {
        setInputText(detail)
        setIntent(null)
      } else if (detail && typeof detail === 'object') {
        setInputText(typeof detail.text === 'string' ? detail.text : '')
        setIntent(detail.intent || null)
      }
      textareaRef.current?.focus()
    }

    const handleFillPrompt = (e: Event) => applyFill((e as CustomEvent).detail)
    const handleFillInput = (e: Event) => applyFill((e as CustomEvent).detail)

    window.addEventListener('fillPrompt', handleFillPrompt)
    window.addEventListener('fillInput', handleFillInput)
    return () => {
      window.removeEventListener('fillPrompt', handleFillPrompt)
      window.removeEventListener('fillInput', handleFillInput)
    }
  }, [])

  // 从 Hermes ACP 获取可用斜杠命令，用于输入框自动补全
  useEffect(() => {
    window.electronAPI.hermes.commands()
      .then((cmds: any[]) => {
        if (Array.isArray(cmds) && cmds.length > 0) {
          setCommands(cmds)
        }
      })
      .catch(() => {})
  }, [])

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text && images.length === 0) return

    // 斜杠命令：立即通过独立通道发送，不占用流式回复，也不需要先停止生成
    if (text.startsWith('/')) {
      const cmd = text.trim().toLowerCase()
      const store = useSessionStore.getState()

      if (cmd === '/stop') {
        // 本地停止：清空队列并通知 Hermes 取消当前回合
        store.stopGenerating()
      } else if (cmd === '/new' || cmd.startsWith('/new ')) {
        // 新会话：先停止当前生成并清空队列，再创建新的本地会话
        store.stopGenerating()
        await store.createSession()
      } else if (store.activeSessionId) {
        await window.electronAPI.chat.command(text, store.activeSessionId)
      }

      setInputText('')
      setImages([])
      setIntent(null)
      setCommandIndex(0)
      return
    }

    // 检测富格式任务
    const richFormatKeywords = ['PPT', 'PPTX', 'XLSX', 'Excel', 'Word', '视频']
    if (richFormatKeywords.some(kw => text.includes(kw)) && !showRichFormatWarning) {
      setShowRichFormatWarning(true)
      return
    }

    setInputText('')
    setImages([])
    // 把导航携带的意图透传给主进程做 skill/工作流装配
    const currentIntent = intent
    setIntent(null)
    await sendMessage(text, images.length > 0 ? images : undefined, currentIntent || undefined)
  }

  const handleStop = async () => {
    // 通过 sessionStore 通知停止
    const event = new CustomEvent('stopGeneration')
    window.dispatchEvent(event)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 斜杠命令补全导航
    if (showCommandMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex(i => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = filteredCommands[commandIndex]
        if (cmd) {
          setInputText(`/${cmd.name} `)
          setCommandIndex(0)
          textareaRef.current?.focus()
        }
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[commandIndex]
        if (cmd) {
          setInputText(`/${cmd.name} `)
          setCommandIndex(0)
        }
        return
      }
    }

    if (isMultiLine) {
      // 多行模式：Ctrl+Enter 发送
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        handleSend()
      }
    } else {
      // 单行模式：Enter 发送，Shift+Enter 换行
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    for (const file of Array.from(files)) {
      // 检查大小
      if (file.size > 20 * 1024 * 1024) {
        Modal.warning({ title: '文件大小超限', content: `${file.name} 超过 20MB 限制` })
        continue
      }

      // 图片文件
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => {
          setImages(prev => [...prev, reader.result as string])
        }
        reader.readAsDataURL(file)
      }
      // 文本文件
      else if (['.txt', '.md', '.csv', '.json'].some(ext => file.name.endsWith(ext))) {
        const reader = new FileReader()
        reader.onload = () => {
          setInputText(prev => prev + (prev ? '\n' : '') + (reader.result as string))
        }
        reader.readAsText(file)
      }
    }

    // 重置 input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // 粘贴图片
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = () => {
            setImages(prev => [...prev, reader.result as string])
          }
          reader.readAsDataURL(file)
        }
      }
    }
  }

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleExport = async () => {
    // TODO: 实现导出功能
    const result = await window.electronAPI.file.export('md', '# 测试导出\n\n这是一个测试文档。')
    if (result.success) {
      Modal.success({ content: result.message })
    }
  }

  return (
    <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800">
      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="" className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-600" />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs hidden group-hover:block"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 工具栏 */}
      <div className="flex gap-2 mb-2">
        <Tooltip title="上传文件/图片">
          <Button size="small" icon={<PaperClipOutlined />} onClick={() => fileInputRef.current?.click()}>
            上传
          </Button>
        </Tooltip>
        <Tooltip title="导出文档">
          <Button size="small" icon={<ExportOutlined />} onClick={handleExport}>
            导出
          </Button>
        </Tooltip>
        <Tooltip title="模板库">
          <Button size="small" icon={<AppstoreOutlined />}>
            模板
          </Button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip title={isMultiLine ? '切换为单行模式 (Enter发送)' : '切换为多行模式 (Ctrl+Enter发送)'}>
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => setInputMode(isMultiLine ? 'single' : 'multi')}
          >
            {isMultiLine ? '多行' : '单行'}
          </Button>
        </Tooltip>
      </div>

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.bmp,.webp"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* 斜杠命令补全 */}
      {showCommandMenu && (
        <div className="mb-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 shadow-lg overflow-hidden">
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              onMouseDown={(e) => {
                e.preventDefault()
                setInputText(`/${cmd.name} `)
                setCommandIndex(0)
                textareaRef.current?.focus()
              }}
              className={`px-3 py-2 cursor-pointer text-sm flex items-center justify-between gap-4 ${
                i === commandIndex
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <span className="font-medium">/{cmd.name}</span>
              <span className="text-gray-500 dark:text-gray-400 text-xs truncate">
                {cmd.description || cmd.input_hint || ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 连续发送队列提示 */}
      {pendingMessages.length > 0 && (
        <div className="mb-2 text-sm font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-lg px-3 py-2 flex items-center gap-2 shadow-sm">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" />
          ⏳ 还有 {pendingMessages.length} 条消息排队中，当前回合结束后自动发送…
        </div>
      )}

      {/* 输入框 */}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={e => {
            setInputText(e.target.value)
            setCommandIndex(0)
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isMultiLine ? '输入需求... (Ctrl+Enter 发送)' : '输入需求... (Enter 发送)'}
          className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 resize-none focus:border-primary focus:outline-none transition-colors"
          rows={isMultiLine ? 4 : 2}
        />
        {isLoading && (
          <Button
            danger
            icon={<StopOutlined />}
            onClick={handleStop}
            className="self-end h-10"
          >
            停止
          </Button>
        )}
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          className="self-end h-10"
        >
          发送
        </Button>
      </div>

      {/* 富格式提醒弹窗 */}
      <Modal
        title="富格式任务提醒"
        open={showRichFormatWarning}
        onOk={() => { setShowRichFormatWarning(false); handleSend() }}
        onCancel={() => setShowRichFormatWarning(false)}
        okText="继续发送"
        cancelText="取消"
      >
        <p>检测到您可能需要生成 PPT / Excel / 视频等富格式文件。</p>
        <p className="text-gray-500 mt-2 text-sm">建议在指令中明确要求 AI 使用结构化格式输出，以降低排版异常概率。</p>
      </Modal>
    </div>
  )
}

export default InputArea
