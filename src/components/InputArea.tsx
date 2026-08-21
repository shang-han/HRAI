import React, { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { Button, Tooltip, Modal } from 'antd'
import {
  SendOutlined,
  PaperClipOutlined,
  PictureOutlined,
  FileTextOutlined,
  AppstoreOutlined,
  ExportOutlined,
  StopOutlined,
  CloseOutlined
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
  // 文本附件：大文本/JSON/CSV 以附件形式随消息发送（≤50KB 的小文件仍直接进输入框）
  const [textAttachments, setTextAttachments] = useState<{ name: string; content: string }[]>([])
  // 输入框高度：可拖动手柄上下拉伸（48px ~ 260px），默认单行高度
  const [inputHeight, setInputHeight] = useState(48)
  const [resizing, setResizing] = useState(false)
  const [intent, setIntent] = useState<{ hint?: string; id?: string } | null>(null)
  const [showRichFormatWarning, setShowRichFormatWarning] = useState(false)
  const [commands, setCommands] = useState<any[]>(FALLBACK_COMMANDS)
  const [commandIndex, setCommandIndex] = useState(0)
  const { sendMessage, isLoading, pendingMessages } = useSessionStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)



  // 拖动调整输入框高度（向上拉撑高，向下压回缩）
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = inputHeight
    setResizing(true)
    const onMove = (ev: MouseEvent) => {
      setInputHeight(Math.min(260, Math.max(48, startHeight + (startY - ev.clientY))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setResizing(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

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
    if (!text && images.length === 0 && textAttachments.length === 0) return

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
      setTextAttachments([])
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
    // 文本附件组装进消息内容，让 AI 能感知文件名来源
    const attachments = textAttachments
    setTextAttachments([])
    const fullText = [text, ...attachments.map(a => `📎 ${a.name}：\n${a.content}`)]
      .filter(Boolean)
      .join('\n\n')
    // 把导航携带的意图透传给主进程做 skill/工作流装配
    const currentIntent = intent
    setIntent(null)
    await sendMessage(fullText, images.length > 0 ? images : undefined, currentIntent || undefined)
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

    // 默认单行模式：Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
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
      // 文本文件：小文件直接进输入框（顺手可编辑），大文件作为附件随消息发送
      else if (['.txt', '.md', '.csv', '.json'].some(ext => file.name.endsWith(ext))) {
        if (file.size > 2 * 1024 * 1024) {
          Modal.warning({ title: '文件过大', content: `${file.name} 超过 2MB，建议拆分后重试或转为其他格式` })
          continue
        }
        const reader = new FileReader()
        reader.onload = () => {
          const content = reader.result as string
          if (file.size <= 50 * 1024) {
            setInputText(prev => prev + (prev ? '\n' : '') + content)
          } else {
            setTextAttachments(prev => [...prev, { name: file.name, content }])
          }
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
    <div className="shrink-0 p-4 bg-surface">
      {/* 附件预览：图片 + 文本附件 */}
      {(images.length > 0 || textAttachments.length > 0) && (
        <div className="flex gap-2 mb-2 flex-wrap items-center">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={img} alt="" className="w-16 h-16 object-cover rounded-lg border border-line" />
              <button
                onClick={() => removeImage(i)}
                title="移除图片"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center bg-red-500 text-white rounded-full shadow hover:bg-red-600"
              >
                <CloseOutlined className="text-[10px]" />
              </button>
            </div>
          ))}
          {textAttachments.map((a, i) => (
            <div
              key={a.name + i}
              className="flex items-center gap-1.5 bg-surfaceSubtle dark:bg-canvas border border-line rounded-lg pl-2 pr-1 py-1 text-xs text-inkSecondary max-w-[220px]"
            >
              <FileTextOutlined className="shrink-0" />
              <span className="truncate">{a.name}</span>
              <button
                onClick={() => setTextAttachments(prev => prev.filter((_, idx) => idx !== i))}
                title="移除附件"
                className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
              >
                <CloseOutlined className="text-[10px]" />
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
        <div className="mb-2 border border-line rounded-lg bg-surface shadow-lg overflow-hidden">
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
                  : 'hover:bg-surfaceSubtle dark:hover:bg-canvas'
              }`}
            >
              <span className="font-medium">/{cmd.name}</span>
              <span className="text-inkMuted text-xs truncate">
                {cmd.description || cmd.input_hint || ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 连续发送队列提示 */}
      {pendingMessages.length > 0 && (
        <div className="mb-2 text-sm font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-lg px-3 py-2 flex items-center gap-2 shadow-sm">
          ⏳ 还有 {pendingMessages.length} 条消息排队中，当前回合结束后自动发送…
        </div>
      )}

      {/* 输入框高度拖动手柄：悬停/拖动时变主色 */}
      <div
        className={`group flex justify-center pt-1 cursor-ns-resize select-none ${resizing ? 'cursor-grabbing' : ''}`}
        onMouseDown={startResize}
        title="拖动调整输入框高度"
      >
        <div className={`w-10 h-1.5 rounded-full transition-colors ${resizing ? 'bg-primary' : 'bg-line dark:bg-lineDark group-hover:bg-primary'}`} />
      </div>

      {/* 输入框：外框容器内，上部分文字区，底部一行按钮（发送图标框内右下角） */}
      <div className="border border-line rounded-lg bg-canvas focus-within:border-primary transition-colors">
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={e => {
            setInputText(e.target.value)
            setCommandIndex(0)
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={'输入需求... (Enter 发送，Shift+Enter 换行)'}
          className="w-full bg-transparent p-3 pb-1 border-none text-ink resize-none overflow-y-auto outline-none placeholder:text-inkMuted"
          style={{ height: inputHeight }}
        />
        <div className="flex justify-end items-center gap-2 px-2.5 pb-2.5 pt-1">
          {isLoading && (
            <Button
              type="primary"
              danger
              shape="circle"
              icon={<StopOutlined />}
              onClick={handleStop}
              title="停止"
            />
          )}
          <Button
            type="primary"
            shape="circle"
            icon={<SendOutlined />}
            onClick={handleSend}
            title="发送"
          />
        </div>
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
        <p className="text-inkMuted mt-2 text-sm">建议在指令中明确要求 AI 使用结构化格式输出，以降低排版异常概率。</p>
      </Modal>
    </div>
  )
}

export default InputArea
