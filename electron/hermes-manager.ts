import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

/**
 * Hermes ACP (Agent Client Protocol) Manager
 *
 * Protocol: JSON-RPC over stdio
 * Methods: initialize, newSession, prompt, loadSession
 * Notifications: AgentMessageChunk, AgentThoughtChunk
 */

interface StreamHandler {
  onText: (text: string) => void
  onThinking: (text: string) => void
  onDone: () => void
  onError: (error: string) => void
}

export class HermesManager {
  private process: ChildProcess | null = null
  private logManager: any
  private requestId = 0
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private streamHandler: StreamHandler | null = null
  private currentSessionId: string | null = null
  private lastPromptSessionId: string | null = null
  private _isRunning = false
  private starting: Promise<void> | null = null
  private activePrompt: Promise<void> | null = null
  private stopRequested = false
  private availableCommands: any[] = []
  /** 每个 ACP 会话的串行队列，防止并发 prompt 触发 Hermes 的 active-turn redirect */
  private sessionQueues = new Map<string, Promise<void>>()
  private gatewayProcess: ChildProcess | null = null
  private gatewayStarting: Promise<void> | null = null
  private channelSyncProcess: ChildProcess | null = null
  private basePath: string
  private hermesPath: string
  private pythonPath: string
  private gitBashPath: string
  private workspacePath: string
  private configDir: string
  private configPath: string
  private envPath: string

  constructor(logManager: any) {
    this.logManager = logManager

    // 本地便携部署：资源统一放在应用目录内部，不依赖系统全局 PATH。
    const isPacked = app.isPackaged
    const appRoot = isPacked ? path.dirname(app.getPath('exe')) : app.getAppPath()
    const basePath = isPacked
      ? path.join(process.resourcesPath, 'hermes')
      : path.join(appRoot, 'resources', 'hermes')

    this.basePath = basePath
    this.pythonPath = path.join(basePath, 'python', 'python.exe')
    this.hermesPath = path.join(basePath, 'hermes-agent')
    this.gitBashPath = path.join(basePath, 'git', 'bin', 'bash.exe')
    this.workspacePath = path.join(appRoot, 'workspace')
    this.configDir = path.join(app.getPath('userData'), 'hermes-config')
    this.configPath = path.join(this.configDir, 'config.yaml')
    this.envPath = path.join(this.configDir, '.env')

    // 确保配置目录和工作区存在
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
    }
    if (!fs.existsSync(this.workspacePath)) {
      fs.mkdirSync(this.workspacePath, { recursive: true })
    }
  }

  get isRunning() { return this._isRunning }

  async start(): Promise<void> {
    if (this._isRunning) return
    if (this.starting) return this.starting

    this.starting = this.doStart()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<void> {
    // 首次启动完成工作区与内置技能引导，失败不阻断主流程
    this.bootstrapWorkspace()
    this.seedBundledSkills()

    try {
      this.logManager?.info(`Starting Hermes ACP: ${this.pythonPath}`)

      this.process = spawn(this.pythonPath, ['-m', 'acp_adapter.entry'], {
        cwd: this.hermesPath,
        env: this.buildIsolatedEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        this.logManager?.info(`[Hermes] ${data.toString().trim()}`)
      })

      this.process.on('error', (err) => {
        this.logManager?.error('Hermes process error', err)
        this._isRunning = false
      })

      this.process.on('exit', (code) => {
        this.logManager?.info(`Hermes exited, code: ${code}`)
        this._isRunning = false
      })

      // 解析 ACP JSON-RPC 响应
      let buffer = ''
      this.process.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed)
            this.handleMessage(msg)
          } catch {
            // 忽略非 JSON 行
          }
        }
      })

      // 初始化 ACP 协议（失败不影响进程运行）
      try {
        await this.acpInitialize()
      } catch (err: any) {
        this.logManager?.warn(`ACP initialize 跳过: ${err.message}`)
      }
      this._isRunning = true
      this.logManager?.info('Hermes Agent 启动成功')
    } catch (err: any) {
      this.logManager?.error('Hermes start failed', err)
      throw err
    }
  }

  private buildIsolatedEnv(): NodeJS.ProcessEnv {
    const pythonDir = path.dirname(this.pythonPath)
    const gitRoot = path.dirname(path.dirname(this.gitBashPath))
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
    const system32 = path.join(systemRoot, 'System32')
    const windowsPowerShell = path.join(system32, 'WindowsPowerShell', 'v1.0')

    // 仅加入项目内部依赖 + Windows 系统基础目录，不继承用户全局 PATH。
    const pathEntries = [
      pythonDir,
      path.join(gitRoot, 'bin'),
      path.join(gitRoot, 'usr', 'bin'),
      path.join(gitRoot, 'mingw64', 'bin'),
      system32,
      systemRoot,
      windowsPowerShell,
    ].filter(Boolean)

    return {
      PYTHONHOME: pythonDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PATH: pathEntries.join(path.delimiter),
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      COMSPEC: path.join(system32, 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
      HERMES_HOME: this.configDir,
      HERMES_GIT_BASH_PATH: this.gitBashPath,
      SHELL: this.gitBashPath,
      TERMINAL_CWD: this.workspacePath,
      GATEWAY_ALLOW_ALL_USERS: 'true',
      HOME: app.getPath('home'),
      USERPROFILE: app.getPath('home'),
      TEMP: app.getPath('temp'),
      TMP: app.getPath('temp'),
    }
  }

  // ============ ACP Protocol ============

  /**
   * ACP initialize — 正确的协议握手（需 protocolVersion，clientInfo 需 name+version）
   */
  private async acpInitialize(): Promise<void> {
    await this.sendAcpRequest('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'hermes-hr-admin',
        version: '1.0.0'
      }
    })
    this.logManager?.info('ACP initialize OK')
  }

  /**
   * 创建新会话 — ACP: session/new（必填 cwd + mcpServers）
   */
  async createSession(): Promise<string> {
    const result = await this.sendAcpRequest('session/new', {
      cwd: this.sessionCwd(),
      mcpServers: []
    })
    this.currentSessionId = result?.sessionId || result?.session_id || null
    return this.currentSessionId || ''
  }

  private sessionCwd(): string {
    return this.workspacePath
  }

  /**
   * 发送消息 — ACP: session/prompt（返回即一轮结束）
   */
  async sendPrompt(
    text: string,
    sessionId: string,
    handler: StreamHandler
  ): Promise<void> {
    // /stop 是立即取消指令，必须马上发给 Hermes，不能等上一轮结束。
    const isStopCommand = /^\/stop(?:\s|$)/i.test(text.trim())

    // 同一 ACP 会话严格串行：若上一轮尚未结束，先等它完成。
    // 这样不会触发 Hermes 的 “Redirected the active turn with your correction”，
    // 消息会自然排队而不是被 redirect。
    if (!isStopCommand) {
      const previous = this.sessionQueues.get(sessionId)
      if (previous) {
        try {
          await previous
        } catch {
          // 上一轮失败不影响新一轮发送
        }
      }
    }

    // 如果用户刚点过“停止生成”，先等上一轮 ACP prompt 真正结束，
    // 避免新消息被 Hermes 当作 “Queued for the next turn” 排队，
    // 也避免后续流式输出因为 streamHandler 已被清理而丢失。
    if (!isStopCommand && this.stopRequested) {
      if (this.activePrompt) {
        try {
          await this.activePrompt
        } catch {
          // 上一轮可能因取消而 reject，这里只需等它结束即可
        }
      }
      this.stopRequested = false
    }

    this.streamHandler = handler
    this.lastPromptSessionId = sessionId

    const content = [{ type: 'text', text }]
    const promptPromise = (async () => {
      try {
        // 智能体一轮可能包含多次工具调用，超时放宽到 10 分钟
        await this.sendAcpRequest('session/prompt', {
          prompt: content,
          sessionId
        }, 600000)
        handler.onDone()
      } catch (err: any) {
        handler.onError(err.message)
      } finally {
        this.streamHandler = null
        this.lastPromptSessionId = null
      }
    })()

    this.activePrompt = promptPromise
    this.sessionQueues.set(sessionId, promptPromise)
    if (isStopCommand) {
      this.stopRequested = true
    }
    try {
      await promptPromise
    } finally {
      if (this.activePrompt === promptPromise) {
        this.activePrompt = null
      }
      if (this.sessionQueues.get(sessionId) === promptPromise) {
        this.sessionQueues.delete(sessionId)
      }
    }
  }

  /**
   * 发送斜杠命令（/stop、/new、/help 等）。
   * 不占用 streamHandler，因此不会打断当前正在进行的流式回复。
   */
  async sendCommand(command: string, sessionId: string): Promise<void> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Hermes not running')
    }
    // /stop 和 /new 都会终止当前回合，标记后让下一条普通消息等待真正结束。
    if (/^\/(stop|new)(?:\s|$)/i.test(command.trim())) {
      this.stopRequested = true
    }
    await this.sendAcpRequest('session/prompt', {
      prompt: [{ type: 'text', text: command }],
      sessionId
    }, 30000)
  }

  /**
   * 停止生成 — ACP: session/cancel（通知，无 id，需 sessionId）
   */
  async stopGeneration(): Promise<void> {
    this.stopRequested = true
    const sessionId = this.lastPromptSessionId || this.currentSessionId
    if (this.process?.stdin?.writable && sessionId) {
      const req = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId }
      }
      this.process.stdin.write(JSON.stringify(req) + '\n')
    }
    this.streamHandler = null
  }

  // ============ JSON-RPC ============

  private sendAcpRequest(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Hermes not running'))
        return
      }

      const id = ++this.requestId
      const req = { jsonrpc: '2.0', id, method, params }
      this.pendingRequests.set(id, { resolve, reject })

      this.process!.stdin.write(JSON.stringify(req) + '\n')

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`ACP timeout: ${method}`))
        }
      }, timeoutMs)
    })
  }

  private handleMessage(msg: any): void {
    // 响应
    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id)
      if (pending) {
        this.pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // 通知（流式数据）
    if (msg.method) {
      this.handleStreamNotification(msg.method, msg.params)
    }
  }

  private handleStreamNotification(method: string, params: any): void {
    // ACP 标准：session/update 通知，update.sessionUpdate 区分类型
    if (method === 'session/update') {
      const update = params?.update
      if (!update) return
      const updateType = update.sessionUpdate || update.session_update

      // 可用命令列表不依赖当前 streamHandler，提前捕获供前端斜杠补全使用。
      if (updateType === 'available_commands_update' && Array.isArray(update.available_commands)) {
        this.availableCommands = update.available_commands
        return
      }

      const h = this.streamHandler
      if (!h) return
      const content = update.content
      const text = typeof content === 'string' ? content : content?.text || ''
      if (updateType === 'agent_message_chunk' && text) h.onText(text)
      if (updateType === 'agent_thought_chunk' && text) h.onThinking(text)
      return
    }

    const h = this.streamHandler
    if (!h) return

    // 兼容旧格式
    switch (method) {
      case 'notifications/agent_message_chunk':
      case 'agent_message_chunk': {
        // 文本流式输出
        const content = params?.content
        if (content) {
          const text = typeof content === 'string' ? content : content?.text || ''
          if (text) h.onText(text)
        }
        break
      }

      case 'notifications/agent_thought_chunk':
      case 'agent_thought_chunk': {
        // 思考过程
        const content = params?.content
        if (content) {
          const text = typeof content === 'string' ? content : content?.text || ''
          if (text) h.onThinking(text)
        }
        break
      }
    }
  }

  // ============ Hermes Gateway（渠道网关，当前仅承载个人微信） ============

  get gatewayRunning(): boolean {
    return this.gatewayProcess !== null
  }

  async startGateway(): Promise<void> {
    if (this.gatewayProcess) return
    if (this.gatewayStarting) return this.gatewayStarting

    this.gatewayStarting = (async () => {
      if (!fs.existsSync(this.pythonPath)) {
        throw new Error('Hermes Python 运行时不存在')
      }

      this.logManager?.info('Starting Hermes Gateway for channel platforms')
      const proc = spawn(this.pythonPath, ['-m', 'gateway.run'], {
        cwd: this.hermesPath,
        env: this.buildIsolatedEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.gatewayProcess = proc

      proc.stdout?.on('data', (data: Buffer) => {
        this.logManager?.info(`[Gateway] ${data.toString().trim()}`)
      })
      proc.stderr?.on('data', (data: Buffer) => {
        this.logManager?.info(`[Gateway] ${data.toString().trim()}`)
      })
      proc.on('error', (err) => {
        this.logManager?.error('Hermes Gateway process error', err)
        this.gatewayProcess = null
      })
      proc.on('exit', (code) => {
        this.logManager?.info(`Hermes Gateway exited, code: ${code}`)
        this.gatewayProcess = null
      })
    })()

    try {
      await this.gatewayStarting
    } finally {
      this.gatewayStarting = null
    }
  }

  async stopGateway(): Promise<void> {
    const proc = this.gatewayProcess
    if (!proc) return
    this.gatewayProcess = null
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000)
      proc.on('exit', () => { clearTimeout(t); resolve() })
    })
  }

  /**
   * 运行渠道扫码桥接脚本（企微/钉钉/飞书的扫码自动获取凭据流程）。
   */
  runChannelScan(action: 'begin' | 'poll', channel: string, session?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const script = path.join(this.basePath, 'workstation', 'channel_scan.py')
      if (!fs.existsSync(script)) {
        reject(new Error(`channel_scan.py 不存在: ${script}`))
        return
      }

      const args = [script, action, channel]
      if (session) args.push(session)
      const proc = spawn(this.pythonPath, args, {
        cwd: this.hermesPath,
        env: this.buildIsolatedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      let out = ''
      let err = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr?.on('data', (d: Buffer) => { err += d.toString() })

      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error('扫码桥接脚本执行超时'))
      }, 45000)

      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        const line = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop() || ''
        try {
          const parsed = JSON.parse(line)
          resolve(parsed)
        } catch {
          reject(new Error(err.trim() || out.trim() || `channel_scan exited ${code}`))
        }
      })
    })
  }

  /**
   * 启动渠道对话同步桥：把 Hermes gateway 中微信/企微的聊天记录
   * 以 JSON lines 实时输出，Electron 镜像到客户端会话列表。
   */
  startChannelSync(onEvent: (data: any) => void): void {
    if (this.channelSyncProcess) return

    const script = path.join(this.basePath, 'workstation', 'channel_sync.py')
    if (!fs.existsSync(script)) {
      this.logManager?.warn(`channel_sync.py 不存在: ${script}`)
      return
    }

    const proc = spawn(this.pythonPath, [script], {
      cwd: this.hermesPath,
      env: this.buildIsolatedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.channelSyncProcess = proc

    let buffer = ''
    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split(String.fromCharCode(10))
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          onEvent(JSON.parse(trimmed))
        } catch { /* ignore malformed line */ }
      }
    })
    proc.stderr?.on('data', (data: Buffer) => {
      this.logManager?.info(`[ChannelSync] ${data.toString().trim()}`)
    })
    proc.on('error', (err) => {
      this.logManager?.error('ChannelSync process error', err)
      this.channelSyncProcess = null
    })
    proc.on('exit', (code) => {
      this.logManager?.info(`ChannelSync exited, code: ${code}`)
      this.channelSyncProcess = null
    })
    this.logManager?.info('渠道对话同步桥已启动')
  }

  stopChannelSync(): void {
    const proc = this.channelSyncProcess
    if (!proc) return
    this.channelSyncProcess = null
    proc.kill('SIGTERM')
  }

  /**
   * 把企业画像写入 Hermes 工作区 company_context.json，
   * 后续所有 AI 任务都会按 AGENTS.md 约定优先读取。
   */
  writeCompanyContext(profile: any): void {
    try {
      const target = path.join(this.workspacePath, 'company_context.json')
      fs.writeFileSync(target, JSON.stringify(profile, null, 2), 'utf-8')
      this.logManager?.info('企业画像已写入 Hermes 工作区')
    } catch (err: any) {
      this.logManager?.warn(`企业画像写入失败: ${err.message}`)
    }
  }

  getGatewayStatus() {
    return {
      running: this.gatewayProcess !== null,
      pid: this.gatewayProcess?.pid || null,
      configPath: this.configPath
    }
  }

  /**
   * 引导工作区：创建 output/templates/data 目录并写入默认 AGENTS.md
   * 已存在的内容不做覆盖，保证用户数据与本地改动安全。
   */
  private bootstrapWorkspace(): void {
    try {
      if (!fs.existsSync(this.workspacePath)) {
        fs.mkdirSync(this.workspacePath, { recursive: true })
      }
      for (const dir of ['output', 'templates', 'data']) {
        const full = path.join(this.workspacePath, dir)
        if (!fs.existsSync(full)) {
          fs.mkdirSync(full, { recursive: true })
        }
      }

      const agentsFile = path.join(this.workspacePath, 'AGENTS.md')
      if (!fs.existsSync(agentsFile)) {
        const source = path.join(this.basePath, 'workstation', 'AGENTS.md')
        if (fs.existsSync(source)) {
          fs.copyFileSync(source, agentsFile)
          this.logManager?.info('Hermes workspace AGENTS.md 已初始化')
        }
      }
    } catch (err: any) {
      this.logManager?.warn(`Hermes workspace bootstrap 失败: ${err.message}`)
    }
  }

  /**
   * 递归收集包含 SKILL.md 的叶子技能目录（相对路径）。
   * 按叶子目录粒度复制，后续新增单个技能也能被增量引导。
   */
  private collectSkillDirs(root: string, relative = ''): string[] {
    const result: string[] = []
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const childPath = path.join(root, entry.name)
      if (fs.existsSync(path.join(childPath, 'SKILL.md'))) {
        result.push(childRelative)
      } else {
        result.push(...this.collectSkillDirs(childPath, childRelative))
      }
    }
    return result
  }

  /**
   * 把随应用打包的内置 SKILL.md 技能复制到 HERMES_HOME/skills。
   * 目标已存在的技能不覆盖，便于用户后续自行维护。
   */
  private seedBundledSkills(): void {
    try {
      const sourceRoot = path.join(this.hermesPath, 'skills')
      if (!fs.existsSync(sourceRoot)) return

      const targetRoot = path.join(this.configDir, 'skills')
      if (!fs.existsSync(targetRoot)) {
        fs.mkdirSync(targetRoot, { recursive: true })
      }

      let copied = 0
      for (const relativeDir of this.collectSkillDirs(sourceRoot)) {
        const source = path.join(sourceRoot, relativeDir)
        const target = path.join(targetRoot, relativeDir)
        if (fs.existsSync(target)) continue
        const parent = path.dirname(target)
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true })
        }
        fs.cpSync(source, target, { recursive: true })
        copied += 1
      }

      if (copied > 0) {
        this.logManager?.info(`Hermes 内置技能已引导 ${copied} 个到 ${targetRoot}`)
      }
    } catch (err: any) {
      this.logManager?.warn(`Hermes 内置技能引导失败: ${err.message}`)
    }
  }

  async stop(): Promise<void> {
    this.stopChannelSync()
    await this.stopGateway().catch(() => {})
    if (this.process) {
      this.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.process?.kill('SIGKILL'); resolve() }, 5000)
        this.process?.on('exit', () => { clearTimeout(t); resolve() })
      })
      this.process = null
      this._isRunning = false
      this.activePrompt = null
      this.stopRequested = false
    }
  }

  // ============ Hermes 配置管理 ============

  /**
   * 写入 Hermes 模型配置到 config.yaml + .env
   * 优先使用默认对话模型（isPrimary），base_url 去掉 /chat/completions 后缀（Hermes 自动拼接）
   * 可选 weixin 配置：当用户开启个人微信渠道时，Hermes 内置网关负责 iLink 长轮询收发。
   */
  writeHermesConfig(models: {
    type?: string; id: string; apiKey: string; modelName: string;
    apiEndpoint: string; enabled?: boolean; isPrimary?: boolean; provider?: string;
    params?: Record<string, any>
  }[], weixin?: { enabled: boolean; token?: string; accountId?: string; baseUrl?: string }, wecom?: { enabled: boolean; botId?: string; secret?: string }): void {
    // 写入 .env 文件（API Keys）
    const seenKeys = new Set<string>()
    const envLines: string[] = []
    for (const model of models) {
      if (model.apiKey) {
        const keyName = this.getEnvKeyName(model)
        if (!seenKeys.has(keyName)) {
          seenKeys.add(keyName)
          envLines.push(`${keyName}=${model.apiKey}`)
        }
      }
    }
    fs.writeFileSync(this.envPath, envLines.join('\n') + '\n')

    // 写入 config.yaml（模型选择）
    const primaryModel =
      models.find(m => m.type === 'dialogue' && m.isPrimary && m.enabled !== false) ||
      models.find(m => m.type === 'dialogue' && m.enabled !== false) ||
      models.find(m => m.enabled !== false)

    let yaml = ''
    if (primaryModel) {
      const maxTokens = Number(primaryModel.params?.max_tokens) || 16384
      yaml = `model:
  default: "${this.escapeYaml(primaryModel.modelName)}"
  provider: "${this.getProviderName(primaryModel.id)}"
  base_url: "${this.stripCompletionsSuffix(primaryModel.apiEndpoint)}"
  max_tokens: ${maxTokens}
display:
  streaming: true
`
    }

    if (weixin?.enabled || wecom?.enabled) {
      yaml += `platforms:
`
    }

    if (weixin?.enabled) {
      yaml += `  weixin:
    enabled: true
    token: "${this.escapeYaml(weixin.token || '')}"
    extra:
      account_id: "${this.escapeYaml(weixin.accountId || '')}"
      dm_policy: open
      group_policy: disabled
`
      const baseUrl = (weixin.baseUrl || '').trim()
      if (baseUrl) {
        yaml += `      base_url: "${this.escapeYaml(baseUrl)}"
`
      }
    }

    if (wecom?.enabled) {
      yaml += `  wecom:
    enabled: true
    extra:
      bot_id: "${this.escapeYaml(wecom.botId || '')}"
      secret: "${this.escapeYaml(wecom.secret || '')}"
      websocket_url: "wss://openws.work.weixin.qq.com"
      dm_policy: open
`
    }

    if (yaml) {
      fs.writeFileSync(this.configPath, yaml)
    }

    this.logManager?.info('Hermes config written')
  }

  private escapeYaml(value: string): string {
    return String(value).replace(/"/g, "'")
  }

  private stripCompletionsSuffix(url: string): string {
    return url.replace(/\/chat\/completions\/?$/, '')
  }

  private getEnvKeyName(model: { id: string; provider?: string }): string {
    const provider = String(model.provider || '').toLowerCase()
    const byProvider: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      dashscope: 'DASHSCOPE_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      zai: 'GLM_API_KEY',
      glm: 'GLM_API_KEY',
      openai: 'OPENAI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      kling: 'KLING_API_KEY',
    }
    if (byProvider[provider]) return byProvider[provider]
    return byProvider[this.getProviderName(model.id)] || 'OPENAI_API_KEY'
  }

  private getProviderName(modelId: string): string {
    if (modelId.startsWith('deepseek')) return 'deepseek'
    if (modelId.startsWith('qwen') || modelId.startsWith('wanx')) return 'dashscope'
    if (modelId.startsWith('glm')) return 'zai'
    if (modelId.startsWith('kling')) return 'kling'
    if (modelId.startsWith('dall-e')) return 'openai'
    return 'openrouter'
  }

  getStatus() {
    return {
      isRunning: this._isRunning,
      sessionId: this.currentSessionId,
      pid: this.process?.pid || null,
      configDir: this.configDir
    }
  }

  getAvailableCommands() {
    return this.availableCommands.map(cmd => ({ ...cmd }))
  }
}
