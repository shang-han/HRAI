import { create } from 'zustand'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  model?: string
  images?: string[]
  thinking?: string  // 思考过程内容
  sourceId?: string  // 渠道消息唯一来源ID
}

interface PendingMessage {
  id: string
  content: string
  images?: string[]
  /** 业务导航/意图路由元数据，透传给主进程做 skill 与工作流装配 */
  intent?: { hint?: string; id?: string }
}

interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  messageCount: number
  workPriority?: {
    title: string
    background: string
    targetAudience: string
    scenario: string
  }
  /** 系统保留会话（默认会话）：禁止删除 */
  isDefault?: boolean
}

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  messages: Message[]
  pendingMessages: PendingMessage[]
  isLoading: boolean
  isStopping: boolean

  // Actions
  initSession: () => Promise<void>
  createSession: (name?: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  switchSession: (id: string) => Promise<void>
  renameSession: (id: string, name: string) => Promise<void>
  sendMessage: (content: string, images?: string[], intent?: { hint?: string; id?: string }) => Promise<void>
  addMessage: (message: Message) => void
  updateLastAssistantMessage: (content: string) => void
  stopGenerating: () => void
  refreshSessions: () => Promise<void>
  applyChannelTranscript: (data: {
    sessionId: string
    channel: string
    chatId: string
    messages: Message[]
  }) => Promise<void>
}

function makeUserMessage(content: string, images?: string[]): Message {
  return {
    id: Date.now().toString(),
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    images
  }
}

async function runTurn(
  set: any,
  get: () => SessionState,
  content: string,
  images: string[] | undefined,
  userMessage: Message | null,
  intent?: { hint?: string; id?: string }
): Promise<void> {
  const state = get()
  const sessionId = state.activeSessionId
  if (!sessionId) {
    set({ isLoading: false })
    return
  }

  if (userMessage) {
    await window.electronAPI.session.saveMessage(sessionId, userMessage).catch(() => {})
    set({ messages: [...state.messages, userMessage], isLoading: true })
  } else {
    set({ isLoading: true })
  }

  // 安全看门狗：180 秒后仍未结束则强制复位，防止输入框被永久锁定
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const clearWatchdog = () => {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = undefined
    }
  }

  try {
    // 调用模型（流式）：intent 在主进程被路由并装配为 skill/工作流指令
    const result = await window.electronAPI.chat.stream(content, sessionId, undefined, images, intent)

    watchdog = setTimeout(() => {
      const s = get()
      if (s.isLoading || s.isStopping) {
        // 超时看门狗：主动取消 Hermes 回合，避免界面复位后 ACP 仍在运行，
        // 下一条消息被当成 active-turn redirect。
        window.electronAPI.chat.stop().catch(() => {})
        set({ isLoading: false, isStopping: false })
      }
    }, 180000)

    // 添加空的助手消息占位
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    }

    set({
      messages: [...get().messages, assistantMessage]
    })

    // 监听流式数据
    const cleanup = window.electronAPI.chat.onStreamData(result.channel, async (data: any) => {
      if (data.type === 'chunk') {
        // 已停止生成则忽略后续内容
        if (get().isStopping) return
        const currentMessages = get().messages
        const lastMsg = currentMessages[currentMessages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content += data.data
          set({ messages: [...currentMessages] })
        }
      } else if (data.type === 'thinking') {
        if (get().isStopping) return
        const currentMessages = get().messages
        const lastMsg = currentMessages[currentMessages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.thinking = (lastMsg.thinking || '') + data.data
          set({ messages: [...currentMessages] })
        }
      } else if (data.type === 'done') {
        // 停止生成时不保存半截内容，但必须清理状态
        if (!get().isStopping) {
          const currentMessages = get().messages
          const lastMsg = currentMessages[currentMessages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
            await window.electronAPI.session.saveMessage(sessionId, lastMsg).catch(() => {})
          }
        }
        set({ isLoading: false, isStopping: false })
        clearWatchdog()
        cleanup()
        await drainNext(set, get)
      } else if (data.type === 'error') {
        if (!get().isStopping) {
          const currentMessages = get().messages
          const lastMsg = currentMessages[currentMessages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = `⚠️ 错误: ${data.data}`
            set({ messages: [...currentMessages] })
          }
        }
        set({ isLoading: false, isStopping: false })
        clearWatchdog()
        cleanup()
        await drainNext(set, get)
      }
    })
  } catch (err: any) {
    // 非流式回退
    const result = await window.electronAPI.chat.send(content, sessionId, undefined, images, intent)
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: result.success ? (result.content || '') : `⚠️ ${result.error || '未知错误'}`,
      timestamp: new Date().toISOString()
    }

    await window.electronAPI.session.saveMessage(sessionId, assistantMessage)
    set({
      messages: [...get().messages, assistantMessage],
      isLoading: false
    })
    clearWatchdog()
    await drainNext(set, get)
  }
}

async function drainNext(set: any, get: () => SessionState): Promise<void> {
  const state = get()
  if (state.isStopping) {
    set({ isLoading: false, isStopping: false, pendingMessages: [] })
    return
  }

  if (state.pendingMessages.length === 0) {
    set({ isLoading: false })
    return
  }

  const [next, ...rest] = state.pendingMessages
  set({ pendingMessages: rest })
  await runTurn(set, get, next.content, next.images, null, next.intent)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  pendingMessages: [],
  isLoading: false,
  isStopping: false,

  initSession: async () => {
    try {
      const sessions = await window.electronAPI.session.list()
      set({ sessions })
      if (sessions.length > 0) {
        const activeId = sessions[0].id
        set({ activeSessionId: activeId })
        const messages = await window.electronAPI.session.getMessages(activeId)
        set({ messages })
      }
    } catch (err) {
      console.error('初始化会话失败:', err)
    }
  },

  stopGenerating: () => {
    window.electronAPI.chat.stop().catch(() => {})
    set({ isStopping: true, isLoading: false, pendingMessages: [] })
  },

  createSession: async (name?: string) => {
    try {
      const session = await window.electronAPI.session.create(name)
      const sessions = await window.electronAPI.session.list()
      set({
        sessions,
        activeSessionId: session.id,
        messages: [],
        pendingMessages: []
      })
    } catch (err) {
      console.error('创建会话失败:', err)
    }
  },

  deleteSession: async (id: string) => {
    try {
      await window.electronAPI.session.delete(id)
      const sessions = await window.electronAPI.session.list()
      const state = get()
      let newState: any = { sessions }

      if (state.activeSessionId === id) {
        const newActiveId = sessions[0]?.id || null
        newState.activeSessionId = newActiveId
        newState.pendingMessages = []
        if (newActiveId) {
          const messages = await window.electronAPI.session.getMessages(newActiveId)
          newState.messages = messages
        } else {
          newState.messages = []
        }
      }

      set(newState)
    } catch (err) {
      console.error('删除会话失败:', err)
    }
  },

  switchSession: async (id: string) => {
    try {
      await window.electronAPI.session.switch(id)
      const messages = await window.electronAPI.session.getMessages(id)
      set({ activeSessionId: id, messages, pendingMessages: [] })
    } catch (err) {
      console.error('切换会话失败:', err)
    }
  },

  renameSession: async (id: string, name: string) => {
    try {
      await window.electronAPI.session.rename(id, name)
      const sessions = await window.electronAPI.session.list()
      set({ sessions })
    } catch (err) {
      console.error('重命名会话失败:', err)
    }
  },

  sendMessage: async (content: string, images?: string[], intent?: { hint?: string; id?: string }) => {
    const state = get()
    if (!state.activeSessionId) return

    const userMessage = makeUserMessage(content, images)

    // 正在回复中：先保存用户消息并显示在聊天里，同时进入本地 FIFO 队列，
    // 当前回合结束后自动发送下一条。
    if (state.isLoading) {
      await window.electronAPI.session.saveMessage(state.activeSessionId, userMessage).catch(() => {})
      set({
        messages: [...state.messages, userMessage],
        pendingMessages: [
          ...state.pendingMessages,
          { id: userMessage.id, content, images, intent }
        ]
      })
      return
    }

    await runTurn(set, get, content, images, userMessage, intent)
  },

  addMessage: (message: Message) => {
    set({ messages: [...get().messages, message] })
  },

  updateLastAssistantMessage: (content: string) => {
    const messages = [...get().messages]
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = content
      set({ messages })
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await window.electronAPI.session.list()
      set({ sessions })
    } catch (err) {
      console.error('刷新会话列表失败:', err)
    }
  },

  applyChannelTranscript: async (data) => {
    try {
      const sessions = await window.electronAPI.session.list()
      const state = get()

      // 如果当前打开的就是该渠道会话，把新消息实时追加到聊天区
      if (state.activeSessionId === data.sessionId) {
        const known = new Set(state.messages.map(m => m.sourceId).filter(Boolean))
        const fresh = data.messages.filter(m => !m.sourceId || !known.has(m.sourceId))
        if (fresh.length > 0) {
          set({ messages: [...state.messages, ...fresh] })
        }
      }

      set({ sessions })
    } catch (err) {
      console.error('同步渠道聊天失败:', err)
    }
  }
}))

// 渠道消息镜像事件：主进程把渠道对话同步到客户端会话列表/当前聊天区
if (typeof window !== 'undefined' && window.electronAPI?.channel?.onTranscript) {
  window.electronAPI.channel.onTranscript((data: any) => {
    useSessionStore.getState().applyChannelTranscript(data)
  })
}
