import { ChannelConnector, ChannelInboundMessage } from './types'

/**
 * 钉钉：官方 Stream 模式长连接 SDK。
 * 无需公网回调地址。机器人消息通过 sessionWebhook 直接回复。
 */
export class DingTalkConnector implements ChannelConnector {
  readonly id = 'dingtalk' as const
  private client: any = null
  private onMessageCallback: ((msg: ChannelInboundMessage) => void) | null = null
  private sessionWebhooks = new Map<string, string>()
  private detail = '未连接'

  constructor(onMessage: (msg: ChannelInboundMessage) => void) {
    this.onMessageCallback = onMessage
  }

  async start(config: { enabled?: boolean; appKey?: string; appSecret?: string }): Promise<void> {
    const appKey = (config.appKey || '').trim()
    const appSecret = (config.appSecret || '').trim()
    if (!appKey || !appSecret) {
      throw new Error('钉钉 AppKey / AppSecret 不能为空')
    }

    const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream')
    const client = new DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      autoReconnect: true,
      keepAlive: true,
      subscriptions: [
        { type: 'EVENT', topic: TOPIC_ROBOT },
        { type: 'EVENT', topic: '*' }
      ]
    })

    client.registerAllEventListener((msg: any) => {
      try {
        const headers = msg?.headers || {}
        if (headers.topic && headers.topic !== TOPIC_ROBOT && headers.topic !== '*') {
          return { status: 'SUCCESS' }
        }

        const data = typeof msg?.data === 'string' ? JSON.parse(msg.data) : msg?.data
        if (!data || data.msgtype !== 'text' || !data.text?.content?.trim()) {
          return { status: 'SUCCESS' }
        }

        const chatId = String(data.conversationId || '')
        if (data.sessionWebhook) {
          this.sessionWebhooks.set(chatId, String(data.sessionWebhook))
        }

        this.onMessageCallback?.({
          channel: 'dingtalk',
          chatId,
          senderId: String(data.senderStaffId || data.senderId || ''),
          senderName: data.senderNick,
          content: String(data.text.content)
        })
      } catch {
        // 忽略无法解析的消息，ACK 后服务端不会重试
      }
      return { status: 'SUCCESS' }
    })

    client.on('error', (err: any) => {
      this.detail = `连接异常: ${err?.message || err}`
    })

    await client.connect()
    this.client = client
    this.detail = 'Stream 长连接已建立（无需公网回调）'
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.sessionWebhooks.clear()
    if (client) {
      try { client.disconnect() } catch { /* ignore */ }
    }
    this.detail = '已停止'
  }

  async reply(chatId: string, text: string): Promise<void> {
    // 钉钉机器人文本长度限制，超长截断并提示
    const payload = text.length > 3800 ? text.slice(0, 3800) + ' [内容过长已截断]' : text

    const webhook = this.sessionWebhooks.get(chatId)
    if (!webhook) {
      throw new Error('该会话的 sessionWebhook 已失效，等待用户再次发消息后刷新')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: payload } }),
        signal: controller.signal
      })
      if (!resp.ok) {
        throw new Error(`钉钉回复失败: HTTP ${resp.status}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  getDetail(): string {
    return this.detail
  }
}
