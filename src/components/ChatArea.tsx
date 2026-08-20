import React, { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const ChatArea: React.FC = () => {
  const { messages, isLoading } = useSessionStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const lastUserMsgIdRef = useRef<string | null>(null)

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
    return (
      <div className="flex-1 overflow-auto min-h-0 p-4 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">🤖</div>
          <h2 className="text-xl font-semibold text-ink mb-2">
            您好，我是人事行政一体化智能专家
          </h2>
          <p className="text-inkMuted text-sm">
            您可以点击左侧业务菜单快速生成各类表单、制度方案，也可以直接输入您的需求。
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3 text-left">
            {[
              '帮我写一份招聘需求提报单',
              '生成员工入职登记表',
              '制定考勤管理制度',
              '设计薪资结构方案'
            ].map((prompt, i) => (
              <div
                key={i}
                className="p-3 border border-line rounded-lg text-sm cursor-pointer hover:border-primary hover:text-primary transition-all"
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
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto min-h-0"
    >
      {/* min-h-full + justify-end：内容不满屏时贴在底部（紧挨输入框），满屏后正常滚动 */}
      <div className="min-h-full flex flex-col justify-end p-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex message-enter ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[80%] rounded-2xl px-4 py-3 ${
              message.role === 'user'
                ? 'bg-primary text-white'
                : 'bg-surface text-ink'
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
                {/* 思考过程 */}
                {message.thinking && (
                  <details className="mb-2 text-sm text-inkMuted">
                    <summary className="cursor-pointer hover:text-primary">💭 思考过程</summary>
                    <div className="mt-1 p-2 bg-surfaceSubtle dark:bg-canvas rounded-lg text-xs whitespace-pre-wrap">
                      {message.thinking}
                    </div>
                  </details>
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

            {/* 时间戳 */}
            <div className={`text-xs mt-1 ${message.role === 'user' ? 'text-primaryLight' : 'text-inkMuted'}`}>
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              {message.model && ` · ${message.model}`}
            </div>
          </div>
        </div>
      ))}

      {/* 加载中指示器 */}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex justify-start message-enter">
          <div className="bg-surface rounded-2xl px-4 py-3">
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
  )
}

export default ChatArea
