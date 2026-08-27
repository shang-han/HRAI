import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { HR_MENU } from '../src/data/hr-menu'

interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  workPriority?: WorkPriority
  /**
   * 该会话的工作目录（绝对路径）。AI 的读写、命令执行、产物落盘都在这里。
   * 缺省/空串 = 使用内置工作区（HermesManager.getWorkspacePath()）。
   * 刻意不在老会话上回填绝对路径：安装目录搬家后，"空 = 内置" 的语义仍然正确，
   * 而回填过的路径会变成死路径。
   */
  workDir?: string
  /** 渠道镜像会话：channel=渠道ID，chatId=渠道会话ID */
  channel?: { channel: string; chatId: string }
  origin?: 'local' | 'channel'
  /** 系统保留会话（默认会话）：禁止删除 */
  isDefault?: boolean
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
  /** 权限模式：ask=高危操作审批 | auto=完全放开 | readonly=只读保护 */
  permissionMode: 'ask' | 'auto' | 'readonly'
  update: {
    owner: string
    repo: string
  }
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
    /**
     * 侧边栏像素宽度。可选且不进 getDefaultConfig()：默认值与上下限都由渲染进程
     * （configStore 的 SIDEBAR_* 常量）持有，主进程只是原样存取，
     * 不在这里再抄一份魔数。老配置里没有这个键，渲染侧按字段合并补默认值。
     */
    sidebarWidth?: number
  }
  announcement: {
    lastReadAt: string | null
  }
  /** 工作目录偏好：last=上次用过的（空串=内置工作区），recent=快选历史 */
  workDir: {
    last: string
    recent: string[]
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

interface ScheduledTask {
  id: string
  title: string
  content: string
  dueAt: string
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'
  kind: 'reminder' | 'task'
  sessionId: string
  enabled: boolean
  lastFiredAt?: string | null
  createdAt: string
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
  private scheduledTaskFile: string

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
    this.scheduledTaskFile = path.join(this.dataDir, 'scheduled_tasks.json')

    this.config = this.getDefaultConfig()
  }

  async init(): Promise<void> {
    // 创建目录
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true })

    // 加载数据
    this.sessions = this.loadJson<Session[]>(this.sessionFile, [])
    this.config = { ...this.getDefaultConfig(), ...this.loadJson<Partial<AppConfig>>(this.configFile, {}) }
    // 更新配置浅合并会导致空对象覆盖默认值，这里显式补齐 Gitee 默认仓库
    this.config.update = { ...this.getDefaultConfig().update, ...(this.config.update || {}) }

    // 修复损坏的模型配置，并把修复结果写回磁盘
    const rawModelConfig = this.config.modelConfig
    this.config.modelConfig = this.sanitizeModelConfig(this.config.modelConfig)
    if (JSON.stringify(this.config.modelConfig) !== JSON.stringify(rawModelConfig)) {
      this.saveJson(this.configFile, this.config)
    }

    this.templates = this.migrateTemplates()

    // 如果没有会话，创建一个默认会话
    if (this.sessions.length === 0) {
      const session = this.createSession('默认会话')
      session.isDefault = true
      this.saveSessions()
    } else if (!this.sessions.some(s => s.isDefault)) {
      // 旧数据迁移：没有任何会话带默认标记时，把第一个会话视为默认（不可删除）
      this.sessions[0].isDefault = true
      this.saveSessions()
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

        // 对话模型统一抬高输出上限：低于 65536 的旧配置（例如 4096）自动迁移，
        // 避免文档/工具调用长输出被过早截断。
        const params = { ...(p.params || fallbackForId?.params || {}) }
        if (type === 'dialogue') {
          const maxTokens = Number(params.max_tokens) || 0
          if (maxTokens < 65536) params.max_tokens = 65536
        }

        return {
          ...p,
          name: p.name || fallbackForId?.name || p.id || '未命名模型',
          modelName,
          apiEndpoint,
          apiKey: p.apiKey || '',
          // 所有类型统一：没有 API Key 的不允许保持启用
          enabled: p.enabled !== false && !!(p.apiKey || '').trim(),
          isPrimary: p.isPrimary,
          params,
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
      // 这里是字段白名单，不是 spread：新增会话字段必须显式加进来，
      // 否则渲染进程永远拿不到（workDir 就属于这一类）
      workDir: s.workDir || '',
      channel: s.channel,
      origin: s.origin,
      isDefault: !!s.isDefault
    }))
  }

  createSession(name?: string, workDir?: string): Session {
    const session: Session = {
      id: this.generateId(),
      name: name || `会话 ${this.sessions.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      workPriority: undefined,
      workDir: workDir || undefined
    }
    this.sessions.push(session)
    this.saveSessions()
    return session
  }

  /**
   * 改会话工作目录。传空串 = 恢复为内置工作区。
   * 路径合法性由调用方（main.ts validateWorkDir）负责，这里只落盘。
   */
  setSessionWorkDir(sessionId: string, workDir: string): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return false
    session.workDir = workDir || undefined
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
  }

  /**
   * 记录工作目录偏好。last 无条件更新（含空串 = 上次选的是内置工作区，
   * 这样"默认沿用上次"在用户特意选回内置时也成立）；recent 只收非空目录，
   * 最多留 6 条、最新在前。
   * Windows 路径大小写不敏感，去重必须按小写比，否则同一目录会因为
   * 用户手输大小写不同而重复出现在快选列表里。
   */
  pushRecentWorkDir(dir: string): void {
    const config: any = this.config
    if (!config.workDir || typeof config.workDir !== 'object') {
      config.workDir = { last: '', recent: [] }
    }
    if (!Array.isArray(config.workDir.recent)) config.workDir.recent = []
    config.workDir.last = dir || ''
    if (dir) {
      const key = dir.toLowerCase()
      config.workDir.recent = [dir, ...config.workDir.recent.filter((p: string) => p.toLowerCase() !== key)].slice(0, 6)
    }
    this.saveJson(this.configFile, config)
  }

  getWorkDirPrefs(): { last: string; recent: string[] } {
    const pref = (this.config as any)?.workDir
    return {
      last: typeof pref?.last === 'string' ? pref.last : '',
      recent: Array.isArray(pref?.recent) ? pref.recent : []
    }
  }

  deleteSession(sessionId: string): boolean {
    const index = this.sessions.findIndex(s => s.id === sessionId)
    if (index === -1) return false
    // 默认会话是系统保留会话，禁止删除
    if (this.sessions[index].isDefault) return false
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

  /**
   * 保存会话的近期重点工作：旧的（非空）自动归档进历史（最多 10 条）
   */
  setWorkPriority(
    sessionId: string,
    data: { title: string; background: string; targetAudience: string; scenario: string }
  ): WorkPriority | null {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return null

    const wp: WorkPriority = {
      title: data.title || '',
      background: data.background || '',
      targetAudience: data.targetAudience || '',
      scenario: data.scenario || '',
      createdAt: new Date().toISOString()
    }

    const current = session.workPriority
    if (current && (current.title || current.background)) {
      const history = current.history || []
      history.unshift({ ...current, history: undefined })
      wp.history = history.slice(0, 10)
    }

    session.workPriority = wp
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return wp
  }

  /**
   * 删除历史中的单条版本
   */
  deleteWorkPriorityHistory(sessionId: string, historyIndex: number): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    const history = session?.workPriority?.history
    if (!history || !history[historyIndex]) return false
    history.splice(historyIndex, 1)
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
  }

  /**
   * 删除会话的近期重点工作（含历史版本）
   */
  clearWorkPriority(sessionId: string): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return false
    session.workPriority = undefined
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
  }

  /**
   * 从历史恢复一条重点工作：目标条目回到当前，旧的当前（非空）归档
   */
  restoreWorkPriority(sessionId: string, historyIndex: number): boolean {
    const session = this.sessions.find(s => s.id === sessionId)
    if (!session) return false
    const current = session.workPriority
    if (!current?.history || !current.history[historyIndex]) return false

    const target = current.history[historyIndex]
    const history = [...current.history]
    history.splice(historyIndex, 1)
    if (current.title || current.background) {
      history.unshift({ ...current, history: undefined })
    }

    session.workPriority = {
      ...target,
      history: history.slice(0, 10),
      createdAt: new Date().toISOString()
    }
    session.updatedAt = new Date().toISOString()
    this.saveSessions()
    return true
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

  // ============ 定时任务/提醒管理 ============
  getScheduledTasks(): ScheduledTask[] {
    return this.loadJson<ScheduledTask[]>(this.scheduledTaskFile, [])
  }

  createScheduledTask(input: Omit<ScheduledTask, 'id' | 'createdAt'>): ScheduledTask {
    const task: ScheduledTask = {
      ...input,
      id: this.generateId(),
      createdAt: new Date().toISOString()
    }
    const tasks = this.getScheduledTasks()
    tasks.push(task)
    this.saveJson(this.scheduledTaskFile, tasks)
    return task
  }

  updateScheduledTask(id: string, updates: Partial<ScheduledTask>): boolean {
    const tasks = this.getScheduledTasks()
    const task = tasks.find(t => t.id === id)
    if (!task) return false
    Object.assign(task, updates)
    this.saveJson(this.scheduledTaskFile, tasks)
    return true
  }

  deleteScheduledTask(id: string): boolean {
    const tasks = this.getScheduledTasks()
    const index = tasks.findIndex(t => t.id === id)
    if (index === -1) return false
    tasks.splice(index, 1)
    this.saveJson(this.scheduledTaskFile, tasks)
    return true
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
      permissionMode: 'ask',
      update: {
        owner: 'dk-zy',
        repo: 'hrai'
      },
      modelConfig: {
        dialogue: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek',
            type: 'dialogue',
            apiEndpoint: 'https://api.deepseek.com/v1/chat/completions',
            apiKey: '',
            modelName: 'deepseek-chat',
            params: { temperature: 0.7, max_tokens: 65536 },
            enabled: false,
            isPrimary: true
          },
          {
            id: 'qwen-turbo',
            name: '通义千问',
            type: 'dialogue',
            apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            apiKey: '',
            modelName: 'qwen-turbo',
            params: { temperature: 0.7, max_tokens: 65536 },
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
            enabled: false
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
            params: { temperature: 0.7, max_tokens: 65536 },
            enabled: false
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
      },
      workDir: {
        last: '',
        recent: []
      }
    }
  }

  /**
   * 内置模板：与业务导航同源（src/data/hr-menu.ts）。
   * category = "中心key/模块名"，如 "人力资源中心/1.1 招聘管理"。
   */
  private getDefaultTemplates(): Template[] {
    const now = new Date().toISOString()
    const templates: Template[] = []
    HR_MENU.forEach((c, ci) => {
      c.modules.forEach((m, mi) => {
        m.leaves.forEach((leafItem, li) => {
          templates.push({
            id: `menu-${ci}-${mi}-${li}`,
            name: leafItem.name,
            category: `${c.key}/${m.name}`,
            content: leafItem.prompt,
            isBuiltin: true,
            createdAt: now,
            updatedAt: now
          })
        })
      })
    })
    return templates
  }

  /**
   * 模板迁移合并：
   * - 首次运行：直接写入新的内置模板集
   * - 已有数据：保留自定义模板；内置模板仅保留仍在新菜单中的
   *   （保留用户在指令库中的编辑），并补插新增的内置模板
   */
  private migrateTemplates(): Template[] {
    const stored = this.loadJson<Template[] | null>(this.templateFile, null)
    if (!stored || !Array.isArray(stored)) {
      const defaults = this.getDefaultTemplates()
      this.saveJson(this.templateFile, defaults)
      return defaults
    }

    const defaults = this.getDefaultTemplates()
    const defaultKeys = new Set(defaults.map(t => `${t.category}|${t.name}`))
    const kept = stored.filter(t => !t.isBuiltin || defaultKeys.has(`${t.category}|${t.name}`))
    const keptKeys = new Set(kept.map(t => `${t.category}|${t.name}`))
    const missing = defaults.filter(d => !keptKeys.has(`${d.category}|${d.name}`))
    const merged = [...kept, ...missing]
    if (merged.length !== stored.length) {
      this.saveJson(this.templateFile, merged)
    }
    return merged
  }
}
