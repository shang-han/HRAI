export type ChannelId = 'weixin' | 'wecom' | 'dingtalk' | 'feishu'

export interface ChannelConfigBase {
  enabled: boolean
}

export interface WeixinChannelConfig extends ChannelConfigBase {
  token?: string
  accountId?: string
  baseUrl?: string
}

export interface WeComChannelConfig extends ChannelConfigBase {
  /** 企业微信智能机器人 Bot ID（扫码接入后自动填充，或后台手动复制） */
  botId?: string
  secret?: string
}

export interface DingTalkChannelConfig extends ChannelConfigBase {
  appKey?: string
  appSecret?: string
}

export interface FeishuChannelConfig extends ChannelConfigBase {
  appId?: string
  appSecret?: string
}

export type ChannelConfigMap = {
  weixin: WeixinChannelConfig
  wecom: WeComChannelConfig
  dingtalk: DingTalkChannelConfig
  feishu: FeishuChannelConfig
}

export interface ChannelInboundMessage {
  channel: ChannelId
  chatId: string
  senderId?: string
  senderName?: string
  content: string
}

export interface ChannelStatus {
  id: ChannelId
  label: string
  enabled: boolean
  state: 'stopped' | 'starting' | 'running' | 'error'
  detail: string
  lastMessageAt?: string
}

export interface ChannelConnector {
  readonly id: ChannelId
  start(config: any): Promise<void>
  stop(): Promise<void>
  reply(chatId: string, text: string): Promise<void>
  getDetail(): string
}

export const DEFAULT_CHANNEL_CONFIGS: ChannelConfigMap = {
  weixin: { enabled: false, token: '', accountId: '', baseUrl: '' },
  wecom: { enabled: false, botId: '', secret: '' },
  dingtalk: { enabled: false, appKey: '', appSecret: '' },
  feishu: { enabled: false, appId: '', appSecret: '' }
}

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  weixin: '个人微信',
  wecom: '企业微信',
  dingtalk: '钉钉',
  feishu: '飞书'
}
