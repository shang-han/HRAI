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

interface WorkPriority {
  title: string
  background: string
  targetAudience: string
  scenario: string
  createdAt: string
  history?: WorkPriority[]
}

interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  messageCount: number
  workPriority?: WorkPriority
  /** 该会话的工作目录（智能体 cwd）。空串 = 内置工作区 */
  workDir?: string
  /** 系统保留会话（默认会话）：禁止删除 */
  isDefault?: boolean
}

interface SessionState {
  sessions: Session[]
  activeSessionId: string | null
  /** 每个会话独立的消息桶：key = sessionId。切会话互不污染。 */
  messagesBySession: Record<string, Message[]>
  /** 每个会话独立的待发送队列（连续发送）。 */
  pendingBySession: Record<string, PendingMessage[]>
  /** 每个会话独立的「正在生成」标记。 */
  loadingBySession: Record<string, boolean>
  /** 每个会话独立的「正在停止」标记。 */
  stoppingBySession: Record<string, boolean>
  /**
   * P2 P1-2（隐式接受）：本次装配套用了某格式模板、用户尚未点「本次不套用」。
   * 用户继续发下一条消息 = 未拒绝 = 隐式接受（InputArea 发送前 fire-and-forget 记录）。
   * 点拒绝或切换会话时清除。
   */
  pendingFormatAccept: { id: string } | null

  // Actions
  initSession: () => Promise<void>
  createSession: (name?: string, workDir?: string) => Promise<void>
  /** 进入"草稿会话"：不弹窗、不落库、不出现在会话列表；首条消息发出时才真正建会话 */
  startDraftSession: () => void
  deleteSession: (id: string) => Promise<void>
  switchSession: (id: string) => Promise<void>
  renameSession: (id: string, name: string) => Promise<void>
  /** 改会话工作目录。成功后智能体侧会重开 ACP 会话（上下文重置） */
  setSessionWorkDir: (id: string, workDir: string) => Promise<{ success: boolean; error?: string }>
  refreshMessages: (sessionId: string) => Promise<void>
  sendMessage: (content: string, images?: string[], intent?: { hint?: string; id?: string }, nameHint?: string) => Promise<void>
  addMessage: (message: Message) => void
  updateLastAssistantMessage: (content: string) => void
  stopGenerating: (sessionId?: string) => void
  /** P1-2：套用推送命中时挂起待隐式接受的模板 id */
  setPendingFormatAccept: (payload: { id: string }) => void
  /** P1-2：用户点拒绝 / 切换会话 / 发送时已消费 —— 清除挂起状态 */
  clearPendingFormatAccept: () => void
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

/** 草稿会话命名：有文字取前 12 个字（开头空格去掉、换行并成空格，超出补 …）；
    纯附件/图片消息（无文字）由 nameHint 直接提供文件名/图片名 */
function buildDraftName(content: string, nameHint?: string): string {
  if (nameHint) return nameHint
  const text = (content || '').replace(/\n+/g, ' ').trimStart()
  if (!text) return ''
  return text.length > 12 ? `${text.slice(0, 12)}...` : text
}

// ---- per-session 读写小工具：所有对会话桶的访问都走这里，避免裸读全局字段 ----

function readMessages(state: SessionState, sessionId: string | null): Message[] {
  if (!sessionId) return []
  return state.messagesBySession[sessionId] || []
}

function readPending(state: SessionState, sessionId: string | null): PendingMessage[] {
  if (!sessionId) return []
  return state.pendingBySession[sessionId] || []
}

function appendMessages(
  set: any,
  get: () => SessionState,
  sessionId: string,
  messages: Message[]
): void {
  set({ messagesBySession: { ...get().messagesBySession, [sessionId]: messages } })
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
    return
  }

  const curMsgs = readMessages(get(), sessionId)

  if (userMessage) {
    await window.electronAPI.session.saveMessage(sessionId, userMessage).catch(() => {})
    set({
      messagesBySession: { ...get().messagesBySession, [sessionId]: [...curMsgs, userMessage] },
      loadingBySession: { ...get().loadingBySession, [sessionId]: true }
    })
  } else {
    set({ loadingBySession: { ...get().loadingBySession, [sessionId]: true } })
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

    // 即时错误（如未配置模型）由返回值带回：事件通道在订阅前发出的会丢
    if (result && (result as any).error) {
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `⚠️ ${(result as any).error}`,
        timestamp: new Date().toISOString()
      }
      await window.electronAPI.session.saveMessage(sessionId, assistantMessage).catch(() => {})
      appendMessages(set, get, sessionId, [...readMessages(get(), sessionId), assistantMessage])
      set({ loadingBySession: { ...get().loadingBySession, [sessionId]: false } })
      await drainNext(set, get, sessionId)
      return
    }

    watchdog = setTimeout(() => {
      const s = get()
      if (s.loadingBySession[sessionId] || s.stoppingBySession[sessionId]) {
        // 超时看门狗：主动取消 Hermes 回合，避免界面复位后 ACP 仍在运行，
        // 下一条消息被当成 active-turn redirect。
        window.electronAPI.chat.stop(sessionId).catch(() => {})
        set({
          loadingBySession: { ...s.loadingBySession, [sessionId]: false },
          stoppingBySession: { ...s.stoppingBySession, [sessionId]: false }
        })
      }
    }, 180000)

    // 添加空的助手消息占位
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    }

    appendMessages(set, get, sessionId, [...readMessages(get(), sessionId), assistantMessage])

    // 监听流式数据
    const cleanup = window.electronAPI.chat.onStreamData(result.channel, async (data: any) => {
      if (data.type === 'chunk') {
        // 已停止生成则忽略后续内容
        if (get().stoppingBySession[sessionId]) return
        const currentMessages = readMessages(get(), sessionId)
        const lastMsg = currentMessages[currentMessages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content += data.data
          appendMessages(set, get, sessionId, [...currentMessages])
        }
      } else if (data.type === 'thinking') {
        if (get().stoppingBySession[sessionId]) return
        const currentMessages = readMessages(get(), sessionId)
        const lastMsg = currentMessages[currentMessages.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.thinking = (lastMsg.thinking || '') + data.data
          appendMessages(set, get, sessionId, [...currentMessages])
        }
      } else if (data.type === 'done') {
        // 停止生成时不保存半截内容，但必须清理状态
        if (!get().stoppingBySession[sessionId]) {
          const currentMessages = readMessages(get(), sessionId)
          const lastMsg = currentMessages[currentMessages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
            await window.electronAPI.session.saveMessage(sessionId, lastMsg).catch(() => {})
          }
        }
        set({
          loadingBySession: { ...get().loadingBySession, [sessionId]: false },
          stoppingBySession: { ...get().stoppingBySession, [sessionId]: false }
        })
        clearWatchdog()
        cleanup()
        await drainNext(set, get, sessionId)
      } else if (data.type === 'error') {
        if (!get().stoppingBySession[sessionId]) {
          const currentMessages = readMessages(get(), sessionId)
          const lastMsg = currentMessages[currentMessages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.content = `⚠️ 错误: ${data.data}`
            appendMessages(set, get, sessionId, [...currentMessages])
          }
        }
        set({
          loadingBySession: { ...get().loadingBySession, [sessionId]: false },
          stoppingBySession: { ...get().stoppingBySession, [sessionId]: false }
        })
        clearWatchdog()
        cleanup()
        await drainNext(set, get, sessionId)
      }
    })
  } catch (err: any) {
    // 非流式回退：流式通道建立失败时兜底。这条路径会阻塞等完整响应，
    // 期间前端一个字都不出 —— 必须明确告诉用户已切模式，否则只会觉得"AI 卡死"。
    appendMessages(set, get, sessionId, [
      ...readMessages(get(), sessionId),
      {
        id: `fallback-${Date.now()}`,
        role: 'assistant' as const,
        content: '⚠️ 流式连接失败，已切换为**非流式模式**：本次需要等模型生成完整回复后一次性显示，期间不会逐字输出。若长时间无响应，可在「模型接入」中换用更快的模型。',
        timestamp: new Date().toISOString()
      }
    ])
    const result = await window.electronAPI.chat.send(content, sessionId, undefined, images, intent)
    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: result.success ? (result.content || '') : `⚠️ ${result.error || '未知错误'}`,
      timestamp: new Date().toISOString()
    }

    await window.electronAPI.session.saveMessage(sessionId, assistantMessage)
    appendMessages(set, get, sessionId, [...readMessages(get(), sessionId), assistantMessage])
    set({ loadingBySession: { ...get().loadingBySession, [sessionId]: false } })
    clearWatchdog()
    await drainNext(set, get, sessionId)
  }
}

async function drainNext(set: any, get: () => SessionState, sessionId: string): Promise<void> {
  const state = get()
  if (state.stoppingBySession[sessionId]) {
    set({
      loadingBySession: { ...state.loadingBySession, [sessionId]: false },
      stoppingBySession: { ...state.stoppingBySession, [sessionId]: false },
      pendingBySession: { ...state.pendingBySession, [sessionId]: [] }
    })
    return
  }

  const pendings = readPending(state, sessionId)
  if (pendings.length === 0) {
    set({ loadingBySession: { ...state.loadingBySession, [sessionId]: false } })
    return
  }

  const [next, ...rest] = pendings
  set({ pendingBySession: { ...state.pendingBySession, [sessionId]: rest } })
  await runTurn(set, get, next.content, next.images, null, next.intent)
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  pendingBySession: {},
  loadingBySession: {},
  stoppingBySession: {},
  pendingFormatAccept: null,

  initSession: async () => {
    try {
      const sessions = await window.electronAPI.session.list()
      set({ sessions })
      if (sessions.length > 0) {
        const activeId = sessions[0].id
        set({ activeSessionId: activeId })
        const messages = await window.electronAPI.session.getMessages(activeId)
        set({ messagesBySession: { ...get().messagesBySession, [activeId]: messages } })
      }
    } catch (err) {
      console.error('初始化会话失败:', err)
    }
  },

  stopGenerating: (sessionId?: string) => {
    const id = sessionId ?? get().activeSessionId ?? undefined
    // 只停指定会话（默认当前 active）；不传 id 走全局停止（兼容旧调用方）。
    window.electronAPI.chat.stop(id).catch(() => {})
    if (id) {
      set({
        stoppingBySession: { ...get().stoppingBySession, [id]: true },
        loadingBySession: { ...get().loadingBySession, [id]: false },
        pendingBySession: { ...get().pendingBySession, [id]: [] }
      })
    }
  },

  createSession: async (name?: string, workDir?: string) => {
    try {
      const session = await window.electronAPI.session.create(name, workDir)
      const sessions = await window.electronAPI.session.list()
      set({
        sessions,
        activeSessionId: session.id,
        messagesBySession: { ...get().messagesBySession, [session.id]: [] },
        pendingBySession: { ...get().pendingBySession, [session.id]: [] }
      })
    } catch (err) {
      console.error('创建会话失败:', err)
    }
  },

  startDraftSession: () => {
    // 临时 id 只活在内存里：它不在 sessions 数组里，sendMessage 看到
    // "当前 id 不在列表"就知道这是草稿，第一条消息会先落库建真会话。
    // 用户切走之后草稿自然蒸发，无残留。
    // 为草稿会话也建好自己的消息/加载/停止桶，切回草稿时能读到草稿期间写入的内容。
    const draftId = `draft-${Date.now().toString(36)}`
    set({
      activeSessionId: draftId,
      messagesBySession: { ...get().messagesBySession, [draftId]: [] },
      pendingBySession: { ...get().pendingBySession, [draftId]: [] },
      loadingBySession: { ...get().loadingBySession, [draftId]: false },
      stoppingBySession: { ...get().stoppingBySession, [draftId]: false }
    })
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
        // 清掉被删会话的桶（避免无限膨胀）；其余会话的桶保持不变
        const messagesBySession = { ...state.messagesBySession }
        const pendingBySession = { ...state.pendingBySession }
        const loadingBySession = { ...state.loadingBySession }
        const stoppingBySession = { ...state.stoppingBySession }
        delete messagesBySession[id]
        delete pendingBySession[id]
        delete loadingBySession[id]
        delete stoppingBySession[id]
        if (newActiveId) {
          const messages = await window.electronAPI.session.getMessages(newActiveId)
          messagesBySession[newActiveId] = messages
        }
        newState.messagesBySession = messagesBySession
        newState.pendingBySession = pendingBySession
        newState.loadingBySession = loadingBySession
        newState.stoppingBySession = stoppingBySession
      }

      set(newState)
    } catch (err) {
      console.error('删除会话失败:', err)
    }
  },

  switchSession: async (id: string) => {
    try {
      await window.electronAPI.session.switch(id)
      const state = get()
      // 仅切换 activeSessionId：旧会话的 loading/stopping/pending 保持不动，
      // 它仍在后台继续流式生成，互不污染。
      // 新会话：若内存已有消息桶（含后台流式内容）则保留，否则从 DB 载入。
      if (state.messagesBySession[id] === undefined) {
        const messages = await window.electronAPI.session.getMessages(id)
        set({
          activeSessionId: id,
          messagesBySession: { ...state.messagesBySession, [id]: messages }
        })
      } else {
        set({ activeSessionId: id })
      }
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

  setSessionWorkDir: async (id: string, workDir: string) => {
    try {
      const res = await window.electronAPI.session.setWorkDir(id, workDir)
      if (!res?.success) return { success: false, error: res?.error || '设置失败' }
      // 只刷会话列表，不动 messages：换目录重置的是智能体侧上下文，
      // 前端聊天记录仍然保留（这点在确认弹窗里也是这么向用户承诺的）
      const sessions = await window.electronAPI.session.list()
      set({ sessions })
      return { success: true }
    } catch (err: any) {
      console.error('设置会话工作目录失败:', err)
      return { success: false, error: String(err?.message || err) }
    }
  },

  refreshMessages: async (sessionId: string) => {
    try {
      const messages = await window.electronAPI.session.getMessages(sessionId)
      set({ messagesBySession: { ...get().messagesBySession, [sessionId]: messages } })
    } catch (err) {
      console.error('刷新会话消息失败:', err)
    }
  },

  sendMessage: async (content: string, images?: string[], intent?: { hint?: string; id?: string }, nameHint?: string) => {
    const state = get()
    if (!state.activeSessionId) return

    // 草稿会话（不在会话列表里的临时 id）：第一条消息发出时才真正落库建会话，
    // 此刻会话列表才出现新条目，名字取首条消息内容。草稿期间写入的消息/队列迁移到真会话 id。
    if (!state.sessions.some(s => s.id === state.activeSessionId)) {
      try {
        const session = await window.electronAPI.session.create(buildDraftName(content, nameHint) || undefined, undefined)
        const sessions = await window.electronAPI.session.list()
        const oldId = state.activeSessionId
        const draftMsgs = oldId ? (state.messagesBySession[oldId] || []) : []
        const draftPending = oldId ? (state.pendingBySession[oldId] || []) : []
        const draftLoading = oldId ? (state.loadingBySession[oldId] || false) : false
        const draftStopping = oldId ? (state.stoppingBySession[oldId] || false) : false
        const newMessages = { ...state.messagesBySession }
        const newPending = { ...state.pendingBySession }
        const newLoading = { ...state.loadingBySession }
        const newStopping = { ...state.stoppingBySession }
        if (oldId) {
          delete newMessages[oldId]
          delete newPending[oldId]
          delete newLoading[oldId]
          delete newStopping[oldId]
        }
        newMessages[session.id] = draftMsgs
        newPending[session.id] = draftPending
        newLoading[session.id] = draftLoading
        newStopping[session.id] = draftStopping
        set({
          sessions,
          activeSessionId: session.id,
          messagesBySession: newMessages,
          pendingBySession: newPending,
          loadingBySession: newLoading,
          stoppingBySession: newStopping
        })
      } catch (err) {
        console.error('创建会话失败:', err)
        return
      }
    }

    const userMessage = makeUserMessage(content, images)
    const curId = get().activeSessionId
    if (!curId) return

    // 正在回复中：先保存用户消息并显示在聊天里，同时进入本地 FIFO 队列，
    // 当前回合结束后自动发送下一条。
    if (get().loadingBySession[curId]) {
      await window.electronAPI.session.saveMessage(curId, userMessage).catch(() => {})
      set({
        messagesBySession: { ...get().messagesBySession, [curId]: [...readMessages(get(), curId), userMessage] },
        pendingBySession: {
          ...get().pendingBySession,
          [curId]: [
            ...readPending(get(), curId),
            { id: userMessage.id, content, images, intent }
          ]
        }
      })
      return
    }

    await runTurn(set, get, content, images, userMessage, intent)
  },

  addMessage: (message: Message) => {
    const id = get().activeSessionId
    if (!id) return
    appendMessages(set, get, id, [...readMessages(get(), id), message])
  },

  updateLastAssistantMessage: (content: string) => {
    const id = get().activeSessionId
    if (!id) return
    const messages = [...readMessages(get(), id)]
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = content
      appendMessages(set, get, id, messages)
    }
  },

  setPendingFormatAccept: (payload) => {
    set({ pendingFormatAccept: payload })
  },

  clearPendingFormatAccept: () => {
    set({ pendingFormatAccept: null })
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
        const known = new Set((state.messagesBySession[data.sessionId] || []).map(m => m.sourceId).filter(Boolean))
        const fresh = data.messages.filter(m => !m.sourceId || !known.has(m.sourceId))
        if (fresh.length > 0) {
          appendMessages(set, get, data.sessionId, [...(state.messagesBySession[data.sessionId] || []), ...fresh])
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
