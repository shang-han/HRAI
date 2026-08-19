import WebSocket from 'ws'
import { ChannelConnector, ChannelInboundMessage } from './types'

const WS_URL = 'wss://openws.work.weixin.qq.com'
const CMD_SUBSCRIBE = 'aibot_subscribe'
const CMD_CALLBACK = 'aibot_msg_callback'
const CMD_LEGACY_CALLBACK = 'aibot_callback'
const CMD_SEND = 'aibot_send_msg'
const CMD_RESPONSE = 'aibot_respond_msg'
const CMD_PING = 'ping'

/**
 * 企业微信智能机器人 Bot 模式（WebSocket 长连接）。
 * 协议与 Hermes 内置 wecom 插件一致，由 Electron 直接收发，
 * 从而与客户端共享同一条 Hermes ACP 会话上下文。
 */
export class WeComBotConnector implements ChannelConnector {
  readonly id = 'wecom' as const
  private onMessageCallback: ((msg: ChannelInboundMessage) => void) | null = null
  private config: any = {}
  private ws: WebSocket | null = null
  private running = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastChatReqIds = new Map<string, string>()
  private detail = '未连接'

  constructor(onMessage: (msg: ChannelInboundMessage) => void) {
    this.onMessageCallback = onMessage
  }

  async start(config: { enabled?: boolean; botId?: string; secret?: string }): Promise<void> {
    const botId = (config.botId || '').trim()
    const secret = (config.secret || '').trim()
    if (!botId || !secret) {
      throw new Error('企业微信 Bot ID / Secret 不能为空')
    }
    this.config = { ...config, botId, secret }
    this.running = true
    await this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(WS_URL)
      this.ws = ws

      ws.on('open', () => {
        const reqId = this.newReqId('subscribe')
        this.sendJson({
          cmd: CMD_SUBSCRIBE,
          headers: { req_id: reqId },
          body: {
            bot_id: this.config.botId,
            secret: this.config.secret,
            device_id: this.newReqId('device').replace(/-/g, '')
          }
        })
        // 服务端随后回 aibot_subscribe；open 后即认为连接建立，
        // 具体鉴权错误会在后续消息中体现。
        if (!settled) {
          settled = true
          this.detail = '企业微信 WebSocket 已连接'
          resolve()
        }
      })

      ws.on('message', (data: any) => {
        try {
          const payload = JSON.parse(String(data))
          this.dispatch(payload)
        } catch { /* ignore */ }
      })

      ws.on('error', (err: any) => {
        if (!settled) {
          settled = true
          reject(err)
        }
        this.detail = `企业微信连接异常: ${err?.message || err}`
      })

      ws.on('close', () => {
        if (!settled) {
          settled = true
          reject(new Error('企业微信 WebSocket 连接被关闭'))
        }
        this.stopHeartbeat()
        if (this.running) this.scheduleReconnect()
      })
    })
  }

  private dispatch(payload: any): void {
    const cmd = String(payload?.cmd || '')
    if (cmd === CMD_SUBSCRIBE) {
      const errcode = Number(payload?.errcode ?? payload?.body?.errcode ?? 0)
      if (errcode !== 0) {
        this.detail = `企业微信订阅失败: ${payload?.errmsg || payload?.body?.errmsg || errcode}`
      }
      return
    }
    if (cmd === CMD_PING) return
    if (cmd !== CMD_CALLBACK && cmd !== CMD_LEGACY_CALLBACK) return

    const body = payload?.body || {}
    const reqId = String(payload?.headers?.req_id || '')
    const msgid = String(body.msgid || reqId || Date.now())
    const from = body.from || {}
    const senderId = String(from.userid || '').trim()
    const chatId = String(body.chatid || senderId).trim()
    if (!chatId) return
    if (reqId) this.lastChatReqIds.set(chatId, reqId)

    let text = this.extractText(body)
    const isGroup = String(body.chattype || '').toLowerCase() === 'group'
    if (isGroup && text) text = text.replace(/^@\S+\s*/, '').trim()
    if (!text) return

    this.onMessageCallback?.({
      channel: 'wecom',
      chatId,
      senderId,
      content: text
    })
  }

  private extractText(body: any): string {
    const msgtype = String(body.msgtype || '').toLowerCase()
    if (msgtype === 'mixed') {
      const items = body.mixed?.msg_item || []
      return items
        .filter((item: any) => String(item.msgtype || '').toLowerCase() === 'text')
        .map((item: any) => String(item.text?.content || '').trim())
        .filter(Boolean)
        .join('\n')
        .trim()
    }
    const text = String(body.text?.content || '').trim()
    if (text) return text
    if (msgtype === 'voice') return String(body.voice?.content || '').trim()
    if (msgtype === 'appmsg') return String(body.appmsg?.title || '').trim()
    return ''
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  private sendJson(payload: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({ cmd: CMD_PING, headers: { req_id: this.newReqId('ping') }, body: {} })
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (!this.running) return
      this.connect().catch(() => {})
    }, 3000)
  }

  async reply(chatId: string, text: string): Promise<void> {
    const payloadText = text.length > 3800 ? `${text.slice(0, 3800)} [内容过长已截断]` : text
    const replyReqId = this.lastChatReqIds.get(chatId)

    // 群聊只能使用回调响应；单聊优先响应回调，失败则用主动发送
    if (replyReqId) {
      this.sendJson({
        cmd: CMD_RESPONSE,
        headers: { req_id: replyReqId },
        body: { msgtype: 'markdown', markdown: { content: payloadText } }
      })
      return
    }

    this.sendJson({
      cmd: CMD_SEND,
      headers: { req_id: this.newReqId('send') },
      body: { chatid: chatId, msgtype: 'markdown', markdown: { content: payloadText } }
    })
  }

  async stop(): Promise<void> {
    this.running = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.close() } catch { /* ignore */ }
    }
    this.detail = '已停止'
  }

  getDetail(): string {
    return this.detail
  }
}
