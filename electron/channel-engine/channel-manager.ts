import QRCode from 'qrcode'
import {
  ChannelConfigMap,
  ChannelConnector,
  ChannelId,
  ChannelInboundMessage,
  ChannelStatus,
  CHANNEL_LABELS,
  DEFAULT_CHANNEL_CONFIGS
} from './types'
import { FeishuConnector } from './feishu-connector'
import { DingTalkConnector } from './dingtalk-connector'
import { WeComBotConnector } from './wecom-bot-connector'
import { WeixinConnector } from './weixin-connector'

/**
 * 渠道接入管理器（双向桥接版）。
 *
 * 四个渠道全部由 Electron 直接收发，渠道与客户端共享同一条 Hermes ACP
 * 会话上下文：渠道来的消息会出现在客户端，客户端在渠道会话中发送的
 * 消息也会使用同一条上下文并把 AI 回复发回渠道。
 */
export class ChannelManager {
  private logManager: any
  private hermesManager: any
  private storageManager: any
  private intentRouter: any
  private configs: ChannelConfigMap
  private connectors = new Map<ChannelId, ChannelConnector>()
  private states = new Map<ChannelId, ChannelStatus['state']>()
  private details = new Map<ChannelId, string>()
  private hermesSessions = new Map<string, string>()
  private queues = new Map<string, Promise<unknown>>()
  private stopping = false
  private pushToRenderer: (event: string, payload: any) => void

  constructor(
    logManager: any,
    hermesManager: any,
    storageManager: any,
    intentRouter: any,
    pushToRenderer?: (event: string, payload: any) => void
  ) {
    this.logManager = logManager
    this.hermesManager = hermesManager
    this.storageManager = storageManager
    this.intentRouter = intentRouter
    this.pushToRenderer = pushToRenderer || (() => {})

    this.configs = this.loadConfigs()
    for (const id of Object.keys(DEFAULT_CHANNEL_CONFIGS) as ChannelId[]) {
      this.states.set(id, 'stopped')
      this.details.set(id, this.configs[id].enabled ? '等待启动' : '未启用')
    }

    const onMessage = (msg: ChannelInboundMessage) => this.dispatch(msg)
    this.connectors.set('weixin', new WeixinConnector(onMessage))
    this.connectors.set('wecom', new WeComBotConnector(onMessage))
    this.connectors.set('dingtalk', new DingTalkConnector(onMessage))
    this.connectors.set('feishu', new FeishuConnector(onMessage))
  }

  private loadConfigs(): ChannelConfigMap {
    const saved = this.storageManager?.getChannelConfig?.() || {}
    const merged: any = {}
    for (const [id, defaults] of Object.entries(DEFAULT_CHANNEL_CONFIGS)) {
      merged[id] = { ...defaults, ...(saved[id] || {}) }
    }
    return merged as ChannelConfigMap
  }

  async startAll(): Promise<void> {
    for (const id of Object.keys(this.configs) as ChannelId[]) {
      const cfg = this.configs[id]
      if (cfg.enabled) {
        await this.startConnector(id).catch((err: any) => {
          this.logManager?.warn(`渠道 ${id} 启动失败: ${err.message}`)
        })
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    for (const connector of this.connectors.values()) {
      await connector.stop().catch(() => {})
    }
    this.stopping = false
  }

  async saveConfig(id: ChannelId, config: any): Promise<{ success: boolean; message?: string }> {
    const merged = { ...this.configs[id], ...config }
    this.configs[id] = merged
    this.storageManager?.saveChannelConfig?.(this.configs)

    try {
      await this.restartConnector(id)
      return { success: true, message: `${CHANNEL_LABELS[id]} 配置已保存并应用` }
    } catch (err: any) {
      this.states.set(id, 'error')
      this.details.set(id, err.message || String(err))
      return { success: false, message: err.message || '渠道重启失败' }
    }
  }

  getConfigs(): ChannelConfigMap {
    return this.configs
  }

  getStatuses(): ChannelStatus[] {
    return (Object.keys(this.configs) as ChannelId[]).map(id => ({
      id,
      label: CHANNEL_LABELS[id],
      enabled: !!this.configs[id].enabled,
      state: this.states.get(id) || 'stopped',
      detail: this.details.get(id) || ''
    }))
  }

  private async startConnector(id: ChannelId): Promise<void> {
    const connector = this.connectors.get(id)
    if (!connector) return

    const cfg = this.configs[id]
    if (!cfg.enabled) {
      await connector.stop().catch(() => {})
      this.states.set(id, 'stopped')
      this.details.set(id, '未启用')
      return
    }

    this.states.set(id, 'starting')
    this.details.set(id, '正在启动…')
    try {
      await connector.start(cfg)
      this.states.set(id, 'running')
      this.details.set(id, connector.getDetail())
      this.logManager?.info(`渠道已连接: ${CHANNEL_LABELS[id]}`)
    } catch (err: any) {
      this.states.set(id, 'error')
      this.details.set(id, err.message || String(err))
      throw err
    }
  }

  private async restartConnector(id: ChannelId): Promise<void> {
    const connector = this.connectors.get(id)
    if (!connector) return
    await connector.stop().catch(() => {})
    await this.startConnector(id)
  }

  /**
   * 扫码接入桥接：四个渠道均返回二维码 URL，前端展示二维码，
   * 用户手机扫码后凭据自动回填。
   */
  async scanBegin(channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu'): Promise<any> {
    const result = await this.hermesManager.runChannelScan('begin', channel)
    if (result?.status === 'ok' && result.qrUrl) {
      result.qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
        width: 240,
        margin: 1,
        errorCorrectionLevel: 'M'
      })
    }
    return result
  }

  async scanPoll(channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu', session: string): Promise<any> {
    return this.hermesManager.runChannelScan('poll', channel, session)
  }

  /** 判断某个客户端会话是否为渠道会话，并返回渠道信息 */
  getChannelInfoBySession(sessionId: string): { channel: ChannelId; chatId: string } | null {
    const session = this.storageManager?.getSessionById?.(sessionId)
    if (!session?.channel) return null
    const channel = session.channel.channel as ChannelId
    if (!this.connectors.has(channel)) return null
    return { channel, chatId: session.channel.chatId }
  }

  /**
   * 渠道入站消息：创建/查找客户端渠道会话，并使用该会话ID作为 ACP 会话键，
   * 保证客户端与渠道后续对话共享同一条上下文。
   */
  private dispatch(msg: ChannelInboundMessage): void {
    if (this.stopping) return

    const connector = this.connectors.get(msg.channel)
    if (!connector) return

    const displayName = msg.senderName
      ? `${CHANNEL_LABELS[msg.channel]} · ${msg.senderName}`
      : `${CHANNEL_LABELS[msg.channel]} · ${msg.chatId}`
    const clientSession = this.storageManager?.createChannelSession?.(msg.channel, msg.chatId, displayName)
    if (!clientSession) return

    this.enqueueTurn(clientSession.id, async () => {
      const prepared = this.intentRouter.prepare(msg.content, undefined, clientSession.id)
      this.intentRouter.recordStart(prepared)

      const now = new Date().toISOString()
      const sourceTag = `${msg.channel}:${msg.chatId}:${Date.now()}`
      const userMessage = {
        id: `${Date.now().toString(36)}_u`,
        role: 'user' as const,
        content: msg.content,
        timestamp: now,
        sourceId: `${sourceTag}:user`
      }
      this.storageManager.saveMessage(clientSession.id, userMessage)
      this.pushToRenderer('channel:transcript', {
        sessionId: clientSession.id,
        channel: msg.channel,
        chatId: msg.chatId,
        messages: [userMessage]
      })

      try {
        const hermesSessionId = await this.ensureChannelSession(clientSession.id)
        let full = ''
        let turnError = ''
        await this.hermesManager.sendPrompt(prepared.prompt, hermesSessionId, {
          onText: (text: string) => { full += text },
          onThinking: () => {},
          onDone: () => {},
          onError: (error: string) => { turnError = error }
        })
        if (turnError) throw new Error(turnError)

        const reply = full.trim() || '（服务返回为空，请稍后重试）'
        this.intentRouter.recordEnd(prepared.taskId, 'done')
        await connector.reply(msg.chatId, reply)

        const assistantMessage = {
          id: `${Date.now().toString(36)}_a`,
          role: 'assistant' as const,
          content: reply,
          timestamp: new Date().toISOString(),
          sourceId: `${sourceTag}:assistant`
        }
        this.storageManager.saveMessage(clientSession.id, assistantMessage)
        
        this.pushToRenderer('channel:transcript', {
          sessionId: clientSession.id,
          channel: msg.channel,
          chatId: msg.chatId,
          messages: [assistantMessage]
        })
      } catch (err: any) {
        this.intentRouter.recordEnd(prepared.taskId, 'error', err.message || String(err))
        await connector.reply(msg.chatId, `⚠️ 处理失败：${err.message || err}`).catch(() => {})
      }
    })
  }

  /**
   * 客户端在渠道会话中发消息：使用与渠道入站相同的 ACP 会话，
   * AI 回复同时推送给客户端并把最终回复发回渠道。
   */
  handleClientTurn(
    clientSessionId: string,
    prepared: any,
    send: (payload: any) => void
  ): boolean {
    const info = this.getChannelInfoBySession(clientSessionId)
    if (!info) return false

    const connector = this.connectors.get(info.channel)
    if (!connector) return false

    this.enqueueTurn(clientSessionId, async () => {
      this.intentRouter.recordStart(prepared)
      try {
        const hermesSessionId = await this.ensureChannelSession(clientSessionId)
        let full = ''
        let turnError = ''
        await this.hermesManager.sendPrompt(prepared.prompt, hermesSessionId, {
          onText: (text: string) => {
            full += text
            send({ type: 'chunk', data: text })
          },
          onThinking: (text: string) => send({ type: 'thinking', data: text }),
          onDone: () => {},
          onError: (error: string) => { turnError = error }
        })
        if (turnError) throw new Error(turnError)

        this.intentRouter.recordEnd(prepared.taskId, 'done')
        const reply = full.trim()
        if (reply) {
          await connector.reply(info.chatId, reply).catch((err: any) => {
            this.logManager?.warn(`渠道回复失败: ${err.message}`)
          })
        }
        send({ type: 'done' })
      } catch (err: any) {
        this.intentRouter.recordEnd(prepared.taskId, 'error', err.message || String(err))
        send({ type: 'error', data: err.message || String(err) })
      }
    })

    return true
  }

  /** 客户端渠道会话的非流式发送（备用路径） */
  handleClientSend(
    clientSessionId: string,
    prepared: any
  ): Promise<{ success: boolean; content?: string; error?: string } | null> {
    const info = this.getChannelInfoBySession(clientSessionId)
    if (!info) return Promise.resolve(null)

    const connector = this.connectors.get(info.channel)
    if (!connector) return Promise.resolve(null)

    return new Promise((resolve) => {
      this.enqueueTurn(clientSessionId, async () => {
        this.intentRouter.recordStart(prepared)
        try {
          const hermesSessionId = await this.ensureChannelSession(clientSessionId)
          let full = ''
          let turnError = ''
          await this.hermesManager.sendPrompt(prepared.prompt, hermesSessionId, {
            onText: (text: string) => { full += text },
            onThinking: () => {},
            onDone: () => {},
            onError: (error: string) => { turnError = error }
          })
          if (turnError) throw new Error(turnError)

          this.intentRouter.recordEnd(prepared.taskId, 'done')
          await connector.reply(info.chatId, full.trim()).catch((err: any) => {
            this.logManager?.warn(`渠道回复失败: ${err.message}`)
          })
          resolve({ success: true, content: full.trim() })
        } catch (err: any) {
          this.intentRouter.recordEnd(prepared.taskId, 'error', err.message || String(err))
          resolve({ success: false, error: err.message || String(err) })
        }
      })
    })
  }

  private enqueueTurn(key: string, fn: () => Promise<void>): void {
    const previous = this.queues.get(key) || Promise.resolve()
    const next = previous.then(fn, fn)
    this.queues.set(key, next.catch(() => {}))
    next.catch(() => {})
  }

  private async ensureChannelSession(key: string): Promise<string> {
    const existing = this.hermesSessions.get(key)
    if (existing) return existing

    if (!this.hermesManager.isRunning) {
      await this.hermesManager.start()
    }
    const sessionId = await this.hermesManager.createSession()
    if (!sessionId) throw new Error('Hermes ACP 会话创建失败')
    this.hermesSessions.set(key, sessionId)
    return sessionId
  }
}
