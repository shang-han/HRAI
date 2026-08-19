import { ChannelConnector, ChannelInboundMessage } from './types'

const ILINK_APP_ID = 'bot'
const ILINK_APP_CLIENT_VERSION = '131584'
const CHANNEL_VERSION = '2.2.0'

/**
 * 个人微信：腾讯 iLink Bot API 长轮询。
 * 文本消息收发与 Hermes gateway 内置 weixin adapter 协议一致，
 * 但由 Electron 直接运行，因此客户端与渠道可以共享同一条 ACP 会话。
 */
export class WeixinConnector implements ChannelConnector {
  readonly id = 'weixin' as const
  private onMessageCallback: ((msg: ChannelInboundMessage) => void) | null = null
  private config: any = {}
  private running = false
  private syncBuf = ''
  private contextTokens = new Map<string, string>()
  private seenMessages = new Set<string>()
  private detail = '未连接'

  constructor(onMessage: (msg: ChannelInboundMessage) => void) {
    this.onMessageCallback = onMessage
  }

  async start(config: { enabled?: boolean; token?: string; accountId?: string; baseUrl?: string }): Promise<void> {
    const token = (config.token || '').trim()
    const accountId = (config.accountId || '').trim()
    if (!token || !accountId) {
      throw new Error('个人微信需要 iLink Token 与 Account ID')
    }
    this.config = { ...config, token, accountId }
    this.running = true
    this.detail = '正在连接 iLink 长轮询…'
    void this.pollLoop()
    this.detail = '微信长轮询已启动'
  }

  private baseUrl(): string {
    return (this.config.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '')
  }

  private headers(body?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION
    }
    if (this.config.token) h.Authorization = `Bearer ${this.config.token}`
    if (body) h['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'))
    const value = Math.floor(Math.random() * 0xffffffff)
    h['X-WECHAT-UIN'] = Buffer.from(String(value), 'utf-8').toString('base64')
    return h
  }

  private async apiPost(path: string, payload: any, timeoutMs: number): Promise<any> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${this.baseUrl()}/${path}`, {
        method: 'POST',
        headers: this.headers(body),
        body,
        signal: controller.signal
      })
      if (!resp.ok) throw new Error(`iLink ${path} HTTP ${resp.status}`)
      return await resp.json()
    } finally {
      clearTimeout(timer)
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.apiPost('ilink/bot/getupdates', { get_updates_buf: this.syncBuf }, 45000)
        const ret = Number(response.ret ?? 0)
        const errcode = Number(response.errcode ?? 0)
        if (ret !== 0 || errcode !== 0) {
          this.detail = `微信轮询错误 ret=${ret} errcode=${errcode} ${response.errmsg || ''}`
          await this.sleep(3000)
          continue
        }

        const nextBuf = String(response.get_updates_buf || '')
        if (nextBuf) {
          this.syncBuf = nextBuf
          this.detail = '微信长轮询运行中'
        }

        for (const message of (response.msgs || []) as any[]) {
          this.processInbound(message)
        }

        const suggested = Number(response.longpolling_timeout_ms || 0)
        await this.sleep(suggested > 0 ? suggested / 1000 + 0.2 : 1)
      } catch (err: any) {
        if (!this.running) return
        this.detail = `微信轮询中断，3秒后重试: ${err?.message || err}`
        await this.sleep(3000)
      }
    }
  }

  private processInbound(message: any): void {
    const senderId = String(message.from_user_id || '').trim()
    if (!senderId || senderId === this.config.accountId) return

    const msgId = String(message.message_id || '')
    if (msgId && this.seenMessages.has(msgId)) return
    if (msgId) {
      this.seenMessages.add(msgId)
      if (this.seenMessages.size > 500) this.seenMessages.clear()
    }

    const text = this.extractText(message.item_list)
    if (!text) return

    const contextToken = String(message.context_token || '').trim()
    if (contextToken) this.contextTokens.set(senderId, contextToken)

    // 群聊首版不处理（与 Hermes 默认 group_policy=disabled 保持一致）
    const roomId = String(message.room_id || message.chat_room_id || '').trim()
    const toUser = String(message.to_user_id || '').trim()
    if (roomId || (toUser && toUser !== this.config.accountId && Number(message.msg_type) === 1)) return

    this.onMessageCallback?.({
      channel: 'weixin',
      chatId: senderId,
      senderId,
      content: text
    })
  }

  private extractText(itemList: any[]): string {
    if (!Array.isArray(itemList)) return ''
    const parts: string[] = []
    for (const item of itemList) {
      if (Number(item?.type) === 1 && item?.text_item?.text) {
        parts.push(String(item.text_item.text))
      }
    }
    return parts.join('\n').trim()
  }

  async reply(chatId: string, text: string): Promise<void> {
    const chunks = this.splitText(text, 1800)
    const contextToken = this.contextTokens.get(chatId) || ''
    for (const chunk of chunks) {
      const message: any = {
        from_user_id: '',
        to_user_id: chatId,
        client_id: `hermes-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: chunk } }]
      }
      if (contextToken) message.context_token = contextToken

      const response = await this.apiPost('ilink/bot/sendmessage', { msg: message }, 20000)
      const errcode = Number(response.errcode ?? 0)
      if (errcode !== 0) {
        if (errcode === -14 && contextToken) {
          delete message.context_token
          const retry = await this.apiPost('ilink/bot/sendmessage', { msg: message }, 20000)
          if (Number(retry.errcode ?? 0) !== 0) {
            throw new Error(`微信回复失败 errcode=${retry.errcode} ${retry.errmsg || ''}`)
          }
        } else {
          throw new Error(`微信回复失败 errcode=${errcode} ${response.errmsg || ''}`)
        }
      }
    }
  }

  private splitText(text: string, max: number): string[] {
    if (text.length <= max) return [text]
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max))
    return chunks
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async stop(): Promise<void> {
    this.running = false
    this.detail = '已停止'
  }

  getDetail(): string {
    return this.detail
  }
}
