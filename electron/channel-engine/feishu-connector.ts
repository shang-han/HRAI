import { ChannelConnector, ChannelInboundMessage } from './types'

/**
 * 飞书：官方 Node SDK 长连接模式（WebSocket）。
 * 无需公网回调地址，配置 App ID / App Secret 后即可在本地接收消息。
 */
export class FeishuConnector implements ChannelConnector {
  readonly id = 'feishu' as const
  private channel: any = null
  private onMessageCallback: ((msg: ChannelInboundMessage) => void) | null = null
  private detail = '未连接'

  constructor(onMessage: (msg: ChannelInboundMessage) => void) {
    this.onMessageCallback = onMessage
  }

  async start(config: { enabled?: boolean; appId?: string; appSecret?: string }): Promise<void> {
    const appId = (config.appId || '').trim()
    const appSecret = (config.appSecret || '').trim()
    if (!appId || !appSecret) {
      throw new Error('飞书 App ID / App Secret 不能为空')
    }

    const { LarkChannel } = require('@larksuiteoapi/node-sdk')
    this.channel = new LarkChannel({
      appId,
      appSecret,
      transport: 'websocket',
      loggerLevel: 'error',
      policy: {
        dmMode: 'open',
        requireMention: true,
        respondToMentionAll: false
      },
      outbound: {
        textChunkLimit: 3800
      }
    })

    this.channel.on('message', (msg: any) => {
      if (!msg || typeof msg.content !== 'string' || !msg.content.trim()) return
      // 群聊安全策略已由 SDK requireMention 处理；单聊直接进入
      this.onMessageCallback?.({
        channel: 'feishu',
        chatId: String(msg.chatId || ''),
        senderId: String(msg.senderId || ''),
        senderName: msg.senderName,
        content: msg.content
      })
    })

    this.channel.on('error', (err: any) => {
      this.detail = `连接异常: ${err?.message || err}`
    })
    this.channel.on('reconnecting', () => {
      this.detail = '连接中断，正在重连…'
    })
    this.channel.on('reconnected', () => {
      this.detail = '长连接已恢复'
    })

    await this.channel.connect()
    this.detail = '长连接已建立（无需公网回调）'
  }

  async stop(): Promise<void> {
    const channel = this.channel
    this.channel = null
    if (channel) {
      try { await channel.disconnect() } catch { /* ignore */ }
    }
    this.detail = '已停止'
  }

  async reply(chatId: string, text: string): Promise<void> {
    if (!this.channel) throw new Error('飞书通道未连接')
    // 群聊单条消息有长度限制，SDK 会按 outbound.textChunkLimit 处理；这里先整段发送
    await this.channel.send(String(chatId), { text })
  }

  getDetail(): string {
    return this.detail
  }
}
