import fs from 'fs'
import path from 'path'
import { app } from 'electron'

interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  workPriority?: WorkPriority
  /** 渠道镜像会话：channel=渠道ID，chatId=渠道会话ID */
  channel?: { channel: string; chatId: string }
  origin?: 'local' | 'channel'
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  model?: string
  images?: string[]
  /** 渠道消息的唯一来源ID，用于同步去重 */
  sourceId?: string
}

interface WorkPriority {
  title: string
  background: string
  targetAudience: string
  scenario: string
  createdAt: string
  history?: WorkPriority[]
}

interface AppConfig {
  theme: 'light' | 'dark'
  modelConfig: {
    dialogue: ModelProvider[]
    image: ModelProvider[]
    video: ModelProvider[]
    multimodal: ModelProvider[]
  }
  shortcuts: Record<string, string>
  layout: {
    sidebarCollapsed: boolean
    inputMode: 'single' | 'multi'
  }
  announcement: {
    lastReadAt: string | null
  }
}

interface ModelProvider {
  id: string
  name: string
  provider?: string
  type: 'dialogue' | 'image' | 'video' | 'multimodal'
  apiEndpoint: string
  apiKey: string
  modelName: string
  params: Record<string, any>
  enabled: boolean
  isPrimary?: boolean
}

interface Template {
  id: string
  name: string
  category: string
  content: string
  isBuiltin: boolean
  createdAt: string
  updatedAt: string
}

export class StorageManager {
  private dataDir: string
  private logDir: string
  private sessionFile: string
  private configFile: string
  private templateFile: string
  private channelFile: string
  private licenseFile: string
  private companyProfileFile: string
  private companyKnowledgeFile: string
  private noticeFile: string
  private noticeReadFile: string
  private permissionFile: string

  private sessions: Session[] = []
  private activeSessionId: string | null = null
  private config: AppConfig
  private templates: Template[] = []

  constructor() {
    const userDataPath = app.getPath('userData')
    this.dataDir = path.join(userDataPath, 'data')
    this.logDir = path.join(userDataPath, 'log')

    this.sessionFile = path.join(this.dataDir, 'session.json')
    this.configFile = path.join(this.dataDir, 'system_config.json')
    this.templateFile = path.join(this.dataDir, 'template.json')
    this.channelFile = path.join(this.dataDir, 'channel_config.json')
    this.licenseFile = path.join(this.dataDir, 'license.json')
    this.companyProfileFile = path.join(this.dataDir, 'company_profile.json')
    this.companyKnowledgeFile = path.join(this.dataDir, 'company_knowledge.json')
    this.noticeFile = path.join(userDataPath, 'notice.txt')
    this.noticeReadFile = path.join(this.dataDir, 'notice_read.json')
    this.permissionFile = path.join(this.dataDir, 'permission_config.json')

    this.config = this.getDefaultConfig()
  }

  async init(): Promise<void> {
    // 创建目录
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true })

    // 加载数据
    this.sessions = this.loadJson<Session[]>(this.sessionFile, [])
    this.config = { ...this.getDefaultConfig(), ...this.loadJson<Partial<AppConfig>>(this.configFile, {}) }

    // 修复损坏的模型配置，并把修复结果写回磁盘
    const rawModelConfig = this.config.modelConfig
    this.config.modelConfig = this.sanitizeModelConfig(this.config.modelConfig)
    if (JSON.stringify(this.config.modelConfig) !== JSON.stringify(rawModelConfig)) {
      this.saveJson(this.configFile, this.config)
    }

    this.templates = this.loadJson<Template[]>(this.templateFile, this.getDefaultTemplates())

    // 如果没有会话，创建一个默认会话
    if (this.sessions.length === 0) {
      this.createSession('默认会话')
    }
    this.activeSessionId = this.sessions[0]?.id || null
  }

  /**
   * 修复损坏/过期的模型配置：
   * - 模型名称为空或非法的（如 deepseek-v4-flash 等不存在的模型），回退为对应厂商的合法默认值
   * - API 端点不是合法 URL 的，使用预设默认值
   * - 保证每种类型至少有一个条目
   */
  private sanitizeModelConfig(saved: AppConfig['modelConfig'] | undefined): AppConfig['modelConfig'] {
    const defaults = this.getDefaultConfig().modelConfig
    if (!saved) return defaults

    const knownModels: Record<string, string[]> = {
      'deepseek-chat': ['deepseek-chat', 'deepseek-reasoner'],
      'deepseek-reasoner': ['deepseek-reasoner', 'deepseek-chat'],
      'qwen-turbo': ['qwen-turbo', 'qwen-plus', 'qwen-max'],
      'qwen-plus': ['qwen-plus', 'qwen-turbo', 'qwen-max'],
      'qwen-max': ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      'qwen-vl-max': ['qwen-vl-max'],
      'glm-4': ['glm-4', 'glm-4-plus', 'glm-4-flash'],
      'wanx-v1': ['wanx-v1'],
      'dall-e-3': ['dall-e-3'],
      'kling-v1': ['kling-v1'],
    }
    const fallbackModels: Record<string, { modelName: string; apiEndpoint: string }> = {
      'deepseek-chat': { modelName: 'deepseek-chat', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions' },
      'deepseek-reasoner': { modelName: 'deepseek-reasoner', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions' },
      'qwen-turbo': { modelName: 'qwen-turbo', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
      'qwen-plus': { modelName: 'qwen-plus', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
      'qwen-max': { modelName: 'qwen-max', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
      'qwen-vl-max': { modelName: 'qwen-vl-max', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
      'glm-4': { modelName: 'glm-4', apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
      'wanx-v1': { modelName: 'wanx-v1', apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis' },
      'dall-e-3': { modelName: 'dall-e-3', apiEndpoint: 'https://api.openai.com/v1/images/generations' },
      'kling-v1': { modelName: 'kling-v1', apiEndpoint: 'https://api.klingai.com/v1/videos/text2video' },
    }

    const sanitizeList = (type: 'dialogue' | 'image' | 'video' | 'multimodal', list: ModelProvider[] | undefined): ModelProvider[] => {
      const fallback = defaults[type]
      if (!Array.isArray(list) || list.length === 0) return fallback
      return list.map((p) => {
        const isCustom = p.id?.startsWith('custom-')
        const fallbackForId: ModelProvider | undefined =
          (fallback.find(f => f.id === p.id) as ModelProvider | undefined) ||
          (fallbackModels[p.id]
            ? { id: p.id, name: p.id, provider: '', type, apiEndpoint: fallbackModels[p.id].apiEndpoint, apiKey: '', modelName: fallbackModels[p.id].modelName, params: {}, enabled: true }
            : undefined)

        // 校验模型名称：不再按固定清单拦截用户从 API 获取的新模型。
        // 只有模型名称为空时才回退到该厂商默认值。
        let modelName = p.modelName?.trim() || ''
        if (!isCustom && !modelName) {
          modelName = fallbackForId?.modelName || ''
        }

        // 校验 API 端点：
        // - 对话/多模态模型必须以 /chat/completions 结尾（兼容错误路径如 /v1、/api 等，保留用户自定义 base_url）
        // - 预设的图片/视频模型使用标准端点
        let apiEndpoint = (p.apiEndpoint || '').trim()
        const isUrl = /^https?:\/\//.test(apiEndpoint)
        if (isUrl) {
          if (type === 'dialogue' || type === 'multimodal') {
            if (!/\/chat\/completions\/?$/.test(apiEndpoint)) {
              apiEndpoint = apiEndpoint.replace(/\/+$/, '') + '/chat/completions'
            }
          } else if (!isCustom && fallbackModels[p.id]) {
            apiEndpoint = fallbackModels[p.id].apiEndpoint
          }
        } else {
          apiEndpoint = fallbackForId?.apiEndpoint || ''
        }

        return {
          ...p,
          name: p.name || fallbackForId?.name || p.id || '未命名模型',
          modelName,
          apiEndpoint,
          apiKey: p.apiKey || '',
          enabled: p.enabled !== false,
          isPrimary: p.isPrimary,
          params: p.params || fallbackForId?.params || {},
          provider: isCustom ? '自定义' : (p.provider || fallbackForId?.provider || '')
        }
      })
    }

    return {
      dialogue: sanitizeList('dialogue', saved.dialogue),
      image: sanitizeList('image', saved.image),
      video: sanitizeList('video', saved.video),
      multimodal: sanitizeList('multimodal', saved.multimodal),
    }
  }

  // ============ 会话管理 ============
  getSessions() {
    return this.sessions.map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      workPriority: s.workPriority,
      channel: s.channel,
      origin: s.origin
    }))
  }

  createSession(name?: string): Session {
    const session: Session = {
      id: this.generateId(),
      name: name || `会话 ${this.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      workPriority: undefined
    }
    this.sessions.push(session)
    this.saveSessions()
    return session
  }

  deleteSession(sessionId: string): boolean {
    const index = this.sessions.findIndex(s => s.id === sessionId)
    if (index === -1) return false
    this.sessions.splice(index, 1)
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id || null
    }
    this.saveSessions()
    return true
  }

  switchSession(sessionId: string): boolean {
    if (!this.sessions.find(s => s.id === sessionId)) return false
    this.activeSessionId = sessionId
    return true
  }

  renameSession(sessionId: string, name: string): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return false
    session.name = name
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
  }

  getSessionMessages(sessionId: string): Message[] {
    const session = this.sessions.find(s => s.id === sessionId)
    return session?.messages || []
  }

  saveMessage(sessionId: string, message: Message): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return false
    // 渠道同步消息按 sourceId 去重，避免重复写入
    if (message.sourceId && session.messages.some(m => m.sourceId === message.sourceId)) {
      return true
    }
    session.messages.push(message)
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
  }

  /**
   * 创建（或查找）渠道镜像会话。渠道中的聊天会镜像到这里，
   * 客户端会话列表即可看到并与本地会话一起管理。
   */
  createChannelSession(channel: string, chatId: string, name?: string): Session {
    const existing = this.sessions.find(s => s.channel?.channel === channel && s.channel?.chatId === chatId)
    if (existing) return existing

    const session: Session = {
      id: this.generateId(),
      name: name || `渠道 · ${channel} · ${chatId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      channel: { channel, chatId },
      origin: 'channel'
    }
    this.sessions.push(session)
    this.saveSessions()
    return session
  }

  getChannelSession(channel: string, chatId: string): Session | undefined {
    return this.sessions.find(s => s.channel?.channel === channel && s.channel?.chatId === chatId)
  }

  getSessionById(sessionId: string): Session | undefined {
    return this.sessions.find(s => s.id === sessionId)
  }

  private saveSessions() {
    this.saveJson(this.sessionFile, this.sessions)
  }

  // ============ 配置管理 ============
  getConfig(): AppConfig {
    return this.config
  }

  setConfig(key: string, value: any): boolean {
    (this.config as any)[key] = value
    this.saveJson(this.configFile, this.config)
    return true
  }

  getLicense(): any {
    return this.loadJson(this.licenseFile, null)
  }

  saveLicense(data: any): void {
    this.saveJson(this.licenseFile, data)
  }

  getChannelConfig(): any {
    return this.loadJson(this.channelFile, {})
  }

  saveChannelConfig(data: any): void {
    this.saveJson(this.channelFile, data)
  }

  // ============ 企业画像管理 ============
  getCompanyProfile(): any {
    return this.loadJson(this.companyProfileFile, null)
  }

  saveCompanyProfile(profile: any): void {
    this.saveJson(this.companyProfileFile, profile)
  }

  hasCompanyProfile(): boolean {
    return fs.existsSync(this.companyProfileFile)
  }

  getCompanyKnowledge(): any {
    return this.loadJson(this.companyKnowledgeFile, null)
  }

  saveCompanyKnowledge(knowledge: any): void {
    this.saveJson(this.companyKnowledgeFile, knowledge)
  }

  // ============ 模板管理 ============
  getTemplates(): Template[] {
    return this.templates
  }

  createTemplate(template: Omit<Template, 'id' | 'createdAt' | 'updatedAt'>): Template {
    const newTemplate: Template = {
      ...template,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    this.templates.push(newTemplate)
    this.saveJson(this.templateFile, this.templates)
    return newTemplate
  }

  updateTemplate(id: string, updates: Partial<Template>): boolean {
    const template = this.templates.find(t => t.id === id)
    if (!template) return false
    Object.assign(template, updates, { updatedAt: new Date().toISOString() })
    this.saveJson(this.templateFile, this.templates)
    return true
  }

  deleteTemplate(id: string): boolean {
    const index = this.templates.findIndex(t => t.id === id)
    if (index === -1) return false
    this.templates.splice(index, 1)
    this.saveJson(this.templateFile, this.templates)
    return true
  }

  // ============ 公告管理 ============
  checkAnnouncement(): { hasNew: boolean; content: string } {
    let content = ''
    try {
      if (fs.existsSync(this.noticeFile)) {
        content = fs.readFileSync(this.noticeFile, 'utf-8')
      }
    } catch { /* ignore */ }

    const readState = this.loadJson<{ lastReadAt: string | null }>(this.noticeReadFile, { lastReadAt: null })
    const noticeStat = fs.existsSync(this.noticeFile) ? fs.statSync(this.noticeFile) : null
    const hasNew = noticeStat !== null && (
      readState.lastReadAt === null ||
      new Date(noticeStat.mtime) > new Date(readState.lastReadAt)
    )

    return { hasNew, content }
  }

  markAnnouncementRead(): void {
    this.saveJson(this.noticeReadFile, { lastReadAt: new Date().toISOString() })
  }

  // ============ 工具方法 ============
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
  }

  private loadJson<T>(filePath: string, defaultValue: T): T {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8')
        return JSON.parse(data) as T
      }
    } catch (err) {
      console.error(`加载文件失败: ${filePath}`, err)
    }
    return defaultValue
  }

  private saveJson(filePath: string, data: any): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      console.error(`保存文件失败: ${filePath}`, err)
    }
  }

  private getDefaultConfig(): AppConfig {
    return {
      theme: 'light',
      modelConfig: {
        dialogue: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek',
            type: 'dialogue',
            apiEndpoint: 'https://api.deepseek.com/v1/chat/completions',
            apiKey: '',
            modelName: 'deepseek-chat',
            params: { temperature: 0.7, max_tokens: 16384 },
            enabled: true,
            isPrimary: true
          },
          {
            id: 'qwen-turbo',
            name: '通义千问',
            type: 'dialogue',
            apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            apiKey: '',
            modelName: 'qwen-turbo',
            params: { temperature: 0.7, max_tokens: 16384 },
            enabled: false
          }
        ],
        image: [
          {
            id: 'wanx-v1',
            name: '通义万相',
            type: 'image',
            apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
            apiKey: '',
            modelName: 'wanx-v1',
            params: { size: '1024*1024', n: 1 },
            enabled: true
          }
        ],
        video: [
          {
            id: 'kling-v1',
            name: '可灵',
            type: 'video',
            apiEndpoint: 'https://api.klingai.com/v1/videos/text2video',
            apiKey: '',
            modelName: 'kling-v1',
            params: { duration: 10 },
            enabled: false
          }
        ],
        multimodal: [
          {
            id: 'qwen-vl-max',
            name: 'Qwen-VL',
            type: 'multimodal',
            apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            apiKey: '',
            modelName: 'qwen-vl-max',
            params: { temperature: 0.7, max_tokens: 16384 },
            enabled: true
          }
        ]
      },
      shortcuts: {
        'newSession': 'Ctrl+N',
        'send': 'Enter',
        'toggleSidebar': 'Ctrl+B',
        'toggleTheme': 'Ctrl+Shift+T'
      },
      layout: {
        sidebarCollapsed: false,
        inputMode: 'single'
      },
      announcement: {
        lastReadAt: null
      }
    }
  }

  private getDefaultTemplates(): Template[] {
    return [
      // 招聘管理
      { id: 'hr-recruit-1', name: '招聘需求提报单', category: '人力资源/招聘管理', content: '请帮我生成一份招聘需求提报单，包含以下字段：部门、岗位名称、招聘人数、岗位要求、薪资范围、到岗时间要求、审批流程。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'hr-recruit-2', name: '岗位JD撰写', category: '人力资源/招聘管理', content: '请帮我撰写一份专业的岗位JD（职位描述），岗位名称：[请填写]，要求包含：岗位职责、任职要求、薪资福利、公司简介。语言要正式且吸引人。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'hr-recruit-3', name: '招聘启事', category: '人力资源/招聘管理', content: '请帮我撰写一份招聘启事，适用于社交媒体/招聘平台发布。岗位：[请填写]，要求风格专业但不死板，突出公司优势和岗位亮点。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 入职管理
      { id: 'hr-onboard-1', name: '新员工入职登记表', category: '人力资源/入职管理', content: '请帮我生成一份新员工入职登记表模板，包含：基本信息、教育背景、工作经历、紧急联系人、银行账户信息、声明签字栏。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'hr-onboard-2', name: '入职欢迎文案', category: '人力资源/入职管理', content: '请帮我撰写一段新员工入职欢迎文案，语气热情友好，包含公司文化介绍、团队欢迎语、入职第一天指引。适合中小企业使用。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 员工档案
      { id: 'hr-archive-1', name: '员工电子档案模板', category: '人力资源/员工档案管理', content: '请帮我设计一份员工电子档案模板，包含：基本信息、合同信息、岗位变动记录、培训记录、绩效记录、奖惩记录。要求结构清晰，便于维护更新。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 考勤管理
      { id: 'hr-attend-1', name: '排班表制定模板', category: '人力资源/考勤排班管理', content: '请帮我生成一份月度排班表模板，适用于[请填写行业/岗位]。需包含：员工姓名、日期、班次（早班/中班/晚班/休息）、备注。请考虑劳动法关于休息日的规定。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 薪酬管理
      { id: 'hr-salary-1', name: '薪资结构设计方案', category: '人力资源/薪酬薪资管理', content: '请帮我设计一份中小企业薪资结构方案，包含：基本工资、岗位工资、绩效工资、津贴补贴、年终奖的占比建议和计算方式。需要符合当地劳动法规。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 行政制度
      { id: 'admin-sys-1', name: '办公用品管理制度', category: '行政综合中心/行政制度管理', content: '请帮我制定一份办公用品管理制度，包含：采购流程、领用规定、库存管理、报废处理、费用控制。适用于50-300人规模的中小企业。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'admin-sys-2', name: '办公环境卫生管理规定', category: '行政综合中心/行政制度管理', content: '请帮我制定一份办公环境卫生管理规定，包含：日常清洁标准、责任分区、检查机制、奖惩措施。适用于中小企业办公环境管理。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      // 资产管理
      { id: 'admin-asset-1', name: '固定资产台账模板', category: '行政综合中心/资产后勤管理', content: '请帮我生成一份固定资产台账模板，包含：资产编号、资产名称、规格型号、购置日期、购置金额、使用部门、保管人、折旧方式、当前状态、报废处置。', isBuiltin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]
  }
}
