import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, Spin, Alert } from 'antd'
import { SendOutlined, CheckCircleFilled } from '@ant-design/icons'

interface Bubble {
  role: 'assistant' | 'user'
  content: string
}

const CompanyOnboardingPage: React.FC<{ onCompleted: () => void }> = ({ onCompleted }) => {
  const [messages, setMessages] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [done, setDone] = useState(false)
  const [profile, setProfile] = useState<any>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const appendBubble = (role: Bubble['role'], content: string) => {
    setMessages(prev => [...prev, { role, content }])
  }

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }

  useEffect(() => { scrollBottom() }, [messages, loading])

  const runStream = async (invoke: () => Promise<{ channel: string }>) => {
    setLoading(true)
    setError('')
    try {
      const { channel } = await invoke()
      const cleanup = window.electronAPI.company.onStreamData(channel, (data) => {
        if (data.type === 'done') {
          cleanup()
          setLoading(false)
          const parsed = data.data || {}
          if (parsed.phase === 'done' && parsed.profile) {
            setProfile(parsed.profile)
            setDone(true)
            if (parsed.closing) appendBubble('assistant', parsed.closing)
          } else {
            const question = parsed.question || '请继续描述一下您的企业情况。'
            appendBubble('assistant', question)
          }
        } else if (data.type === 'error') {
          cleanup()
          setLoading(false)
          setError(data.data || '连接 AI 失败，请重试')
        }
      })
    } catch (err: any) {
      setLoading(false)
      setError(err?.message || '启动企业信息引导失败')
    }
  }

  useEffect(() => {
    runStream(() => window.electronAPI.company.start())
  }, [])

  const handleSend = async () => {
    const answer = input.trim()
    if (!answer || loading || done) return
    appendBubble('user', answer)
    setInput('')
    await runStream(() => window.electronAPI.company.answer(answer))
  }

  const handleFinalize = async () => {
    if (loading || done) return
    await runStream(() => window.electronAPI.company.answer('信息已经足够，请根据以上所有回答生成最终企业画像。'))
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-slate-50 to-slate-100 dark:from-gray-900 dark:via-gray-900 dark:to-gray-950 p-4">
      <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-2xl shadow-xl flex flex-col overflow-hidden" style={{ height: '88vh' }}>
        {/* 头部 */}
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 bg-blue-600 text-white">
          <h1 className="text-xl font-bold">欢迎使用 Hermes 人事行政智能专家</h1>
          <div className="text-sm text-blue-100 mt-1">
            首次使用需要简单了解您的企业。问题由 AI 根据您的回答动态生成，通常 6~10 个。
          </div>
        </div>

        {/* 对话区 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50 dark:bg-gray-900">
          {messages.length === 0 && loading && (
            <div className="text-center text-gray-400 py-16">
              <Spin size="large" />
              <div className="mt-4 text-sm">AI 正在准备第一个问题…</div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 shadow-sm'
              }`}>
                {msg.content}
              </div>
            </div>
          ))}

          {loading && messages.length > 0 && (
            <div className="flex justify-start">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-4 py-3 shadow-sm">
                <span className="flex gap-1">
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
              </div>
            </div>
          )}

          {error && <Alert type="error" showIcon message={error} />}

          {done && (
            <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-4">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-medium">
                <CheckCircleFilled /> 企业画像已生成
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                后续所有制度、表单、文案与报表都会自动结合这份企业信息生成。
              </div>
              <Button type="primary" className="mt-3" onClick={onCompleted}>
                进入系统
              </Button>
            </div>
          )}
        </div>

        {/* 输入区 */}
        {!done && (
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 space-y-2">
            <div className="flex gap-2">
              <Input
                value={input}
                disabled={loading}
                placeholder={loading ? 'AI 正在生成下一个问题…' : '请输入您的回答…'}
                onChange={e => setInput(e.target.value)}
                onPressEnter={handleSend}
              />
              <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={loading || !input.trim()}>
                发送
              </Button>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-400">AI 会记住前面的回答，无需重复</span>
              <Button type="link" size="small" disabled={loading} onClick={handleFinalize}>
                信息已足够，生成画像
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default CompanyOnboardingPage
