import React, { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageOutlined } from '@ant-design/icons'

/** "思考过程"后的三个跳动省略点（主题色，表示进行中/可点击） */
const ThinkingDots: React.FC = () => (
  <span className="flex items-center gap-0.5">
    {[0, 150, 300].map(delay => (
      <span
        key={delay}
        className="w-1 h-1 bg-primary rounded-full animate-bounce"
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
  </span>
)

const ChatArea: React.FC = () => {
  const { messages, isLoading } = useSessionStore()
  const hasMessages = messages.length > 0
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const lastUserMsgIdRef = useRef<string | null>(null)
  // 已展开"思考过程"的消息 id 集合（默认全部折叠，点开后进入此集合）
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isNearBottom = () => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // 监听用户滚动位置：手动上滑阅读时停止自动跟随
  const handleScroll = () => {
    isNearBottomRef.current = isNearBottom()
  }

  // 容器高度变化（如输入框被拉伸/压缩）时：若原本贴底则保持贴底，
  // 否则浏览器保持 scrollTop 不变，底部内容会滑出可视区。
  // 依赖必须是 hasMessages 而不是 []：空态那棵树上没有 scrollRef，
  // 挂载时 current 是 null，只跑一次的话 observer 永远挂不上去。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scrollToBottom(false)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMessages])

  // 新消息/流式内容更新时：仅在用户位于底部附近时跟随滚动
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(messages.length > 0 && isLoading)
    }
  }, [messages, isLoading])

  // 用户刚发出消息时：强制定位到底部（用户正在输入框旁，注意力在底部）
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === 'user' && lastMsg.id !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = lastMsg.id
      isNearBottomRef.current = true
      requestAnimationFrame(() => scrollToBottom(false))
    }
  }, [messages])

  // 切换会话时直接定位到底部
  useEffect(() => {
    lastUserMsgIdRef.current = null
    isNearBottomRef.current = true
    requestAnimationFrame(() => scrollToBottom(false))
  }, [messages[0]?.id])

  if (messages.length === 0) {
    // 空态不抢 flex-1：由 App 里的上下弹性占位把「问候语 + 输入框」整体垂直居中。
    // 允许收缩 + 内部滚动，窗口很矮时问候语自己滚，不会把输入框顶出可视区。
    return (
      <div className="min-h-0 overflow-y-auto pt-4 pb-2">
        <div className="hermes-thread-col text-center">
          <h2 className="hermes-greeting text-[28px] leading-snug font-medium mb-2">
            您好，我是人事行政一体化智能专家
          </h2>
          <p className="text-inkMuted text-sm">
            您可以点击左侧业务菜单快速生成各类表单、制度方案，也可以直接输入您的需求。
          </p>
          <div className="mt-7 grid grid-cols-2 gap-3 text-left">
            {[
              '帮我写一份招聘需求提报单',
              '生成员工入职登记表',
              '制定考勤管理制度',
              '设计薪资结构方案'
            ].map((prompt, i) => (
              <div
                key={i}
                className="hermes-suggest-card px-3.5 py-3 text-sm text-inkSecondary"
                onClick={() => {
                  const event = new CustomEvent('fillInput', { detail: prompt })
                  window.dispatchEvent(event)
                }}
              >
                💡 {prompt}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto min-h-0"
    >
      {/* min-h-full + justify-end：内容不满屏时贴在底部（紧挨输入框），满屏后正常滚动 */}
      {/* 列宽/左右边界由 .hermes-thread-col 统一（与输入框、空态问候语同一个类） */}
      <div className="hermes-thread-col min-h-full flex flex-col justify-end py-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex message-enter relative items-start ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {message.role !== 'user' && (
            <div className="hermes-msg-avatar">AI</div>
          )}
          <div
            className={`max-w-[70%] rounded-2xl px-4 py-3 ${
              message.role === 'user'
                ? 'hermes-glass-primary text-white'
                : 'hermes-glass text-ink'
            }`}
          >
            {/* 图片展示 */}
            {message.images && message.images.length > 0 && (
              <div className="flex gap-2 mb-2 flex-wrap">
                {message.images.map((img, i) => (
                  <img key={i} src={img} alt="" className="max-w-[200px] max-h-[200px] rounded-lg" />
                ))}
              </div>
            )}

            {/* 文本内容 */}
            {message.role === 'assistant' ? (
              <div>
                {/* 思考过程：标题行（主题色 + 跳动点）始终在灰底内容区内，
                    折叠时只收起内容、保留底色；展开/收缩带慢动画；
                    下方居中一条伸缩条（与输入框伸缩手柄同色） */}
                {message.thinking && (
                  <div className="mb-2 text-xs">
                    <div className="p-2 bg-surfaceSubtle dark:bg-canvas rounded-lg">
                      {/* 标题行：位置固定，点击展开/收缩（默认折叠） */}
                      <div
                        className="inline-flex items-center gap-1 cursor-pointer select-none text-primary hover:opacity-80"
                        onClick={() => toggleThinking(message.id)}
                        title={expandedThinking.has(message.id) ? '收起思考过程' : '展开思考过程'}
                      >
                        <MessageOutlined className="text-primary" />
                        思考过程
                        <ThinkingDots />
                      </div>
                      {/* 内容：grid 行高 0fr↔1fr 过渡，展开收缩带动画 */}
                      <div
                        className="grid transition-[grid-template-rows] duration-300 ease-out"
                        style={{ gridTemplateRows: expandedThinking.has(message.id) ? '1fr' : '0fr' }}
                      >
                        <div className="overflow-hidden min-h-0">
                          <div className="mt-1 whitespace-pre-wrap text-inkMuted">{message.thinking}</div>
                        </div>
                      </div>
                    </div>
                    <div
                      className="group flex justify-center pt-1 cursor-pointer select-none"
                      onClick={() => toggleThinking(message.id)}
                      title={expandedThinking.has(message.id) ? '收起思考过程' : '展开思考过程'}
                    >
                      <div className="w-10 h-1.5 rounded-full bg-line dark:bg-lineDark group-hover:bg-primary transition-colors" />
                    </div>
                  </div>
                )}
                <div className="markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {message.content}
                  </ReactMarkdown>
                  {isLoading && messages.indexOf(message) === messages.length - 1 && !message.content && (
                    <div className="flex items-center gap-1.5 py-2">
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '0ms' }} />
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '150ms' }} />
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '300ms' }} />
                      <span className="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">正在生成回复…</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap">{message.content}</p>
            )}

            {/* 时间戳。用户气泡上不能再用 primaryLight：主色玻璃上两者都是浅蓝紫，
                几乎糊在一起；改半透明白，跟白正文同色系但明确弱一档 */}
            <div className={`text-xs mt-1 ${message.role === 'user' ? 'text-white/70' : 'text-inkMuted'}`}>
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              {message.model && ` · ${message.model}`}
            </div>
          </div>
        </div>
      ))}

      {/* 加载中指示器 */}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex justify-start relative items-start message-enter">
          <div className="hermes-msg-avatar">AI</div>
          <div className="hermes-glass rounded-2xl px-4 py-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
    </div>
  )
}

export default ChatArea
