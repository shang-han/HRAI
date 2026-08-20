import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor } from 'electron'
import path from 'path'
import fs from 'fs'
import { HermesManager } from './hermes-manager'
import { StorageManager } from './storage-manager'
import { ActivationManager } from './activation-manager'
import { ModelRouter } from './model-router'
import { FileEngine } from './file-engine'
import { LogManager } from './log-manager'
import { IntentRouter, IntentMeta } from './intent-router'
import { ChannelManager } from './channel-engine/channel-manager'
import { GiteeUpdater } from './gitee-updater'
import { ChannelId } from './channel-engine/types'

let mainWindow: BrowserWindow | null = null
let hermesManager: HermesManager
let storageManager: StorageManager
let activationManager: ActivationManager
let modelRouter: ModelRouter
let fileEngine: FileEngine
let logManager: LogManager
let intentRouter: IntentRouter
let channelManager: ChannelManager
let giteeUpdater: GiteeUpdater
let tray: Tray | null = null
let isQuitting = false
let closeToTrayHintShown = false

// 渲染端会话 -> Hermes ACP 会话 映射
const hermesSessions = new Map<string, string>()
// ACP 审批请求 -> Promise resolve
const pendingApprovals = new Map<number, (allow: boolean) => void>()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Hermes 人事行政一体化智能专家',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  })

  // 开发模式加载 Vite dev server，生产模式加载打包文件
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭窗口 = 隐藏到托盘，Hermes 服务与渠道 Bot 继续运行。
  // 只有通过“退出并停止服务”显式确认后（isQuitting=true）才真正关闭。
  mainWindow.on('close', (event) => {
    if (isQuitting) return

    event.preventDefault()
    mainWindow?.hide()

    if (!closeToTrayHintShown) {
      closeToTrayHintShown = true
      try {
        storageManager?.setConfig('closeToTrayHintShown', true)
      } catch { /* ignore */ }

      dialog.showMessageBox({
        type: 'info',
        title: '服务继续运行',
        message: 'Hermes 已最小化到系统托盘',
        detail: '关闭窗口不会停止本地服务与已接入的渠道 Bot。如需彻底退出，请右键点击系统托盘中的 Hermes 图标，选择“退出并停止服务”。',
        buttons: ['知道了']
      }).catch(() => {})
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

async function initializeApp() {
  // 初始化日志
  logManager = new LogManager()
  logManager.info('应用启动')

  // 初始化存储
  storageManager = new StorageManager()
  await storageManager.init()
  closeToTrayHintShown = !!(storageManager.getConfig() as any)?.closeToTrayHintShown
  logManager.info('存储管理器初始化完成')

  // 初始化激活管理器
  activationManager = new ActivationManager(storageManager)

  // 初始化模型路由
  modelRouter = new ModelRouter(storageManager)

  // 初始化文件引擎
  fileEngine = new FileEngine()

  // 初始化意图路由（业务导航/关键词 -> skill/工作流装配）
  intentRouter = new IntentRouter(logManager, storageManager)

  // 初始化 Hermes 管理器
  hermesManager = new HermesManager(logManager)

  // 初始化 Gitee 在线升级
  giteeUpdater = new GiteeUpdater(() => (storageManager.getConfig() as any)?.update || { owner: '', repo: '' })
  giteeUpdater.setProgressHandler((state) => {
    mainWindow?.webContents.send('update:progress', state)
  })

  // 权限模式桥接：ask 模式下把 ACP 审批请求转发给前端弹窗
  hermesManager.setPermissionBridge({
    getMode: () => (storageManager.getConfig() as any)?.permissionMode || 'ask',
    requestApproval: (payload) => new Promise((resolve) => {
      pendingApprovals.set(payload.requestId, resolve)
      // 防止窗口未打开时审批挂死：5 分钟后自动拒绝
      setTimeout(() => {
        if (pendingApprovals.has(payload.requestId)) {
          pendingApprovals.delete(payload.requestId)
          resolve(false)
        }
      }, 5 * 60 * 1000)
      mainWindow?.webContents.send('permission:request', payload)
    })
  })


  // 初始化渠道接入管理器（微信/企微/钉钉/飞书）
  channelManager = new ChannelManager(
    logManager,
    hermesManager,
    storageManager,
    intentRouter,
    (event: string, payload: any) => mainWindow?.webContents.send(event, payload)
  )

  // 将当前模型配置同步给 Hermes，并后台启动（不阻塞窗口）
  syncHermesConfig()
  hermesManager.start().catch((err: any) => {
    logManager.warn(`Hermes 启动失败（将使用直连模式）: ${err.message}`)
  })

  // 注册 IPC 处理器
  registerIpcHandlers()

  // 启动已启用的渠道连接器（后台异步，不阻塞窗口）
  channelManager.startAll().catch((err: any) => {
    logManager.warn(`渠道启动失败: ${err.message}`)
  })

  // 创建窗口
  createWindow()
}

/**
 * 将存储的模型配置同步写入 Hermes config.yaml + .env
 */
function syncHermesConfig() {
  const config = storageManager.getConfig()
  const allModels: any[] = []
  const typeKeys = ['dialogue', 'image', 'video', 'multimodal'] as const
  const modelConfig = config.modelConfig as Record<string, any> | undefined
  for (const type of typeKeys) {
    const models = modelConfig?.[type]
    if (Array.isArray(models)) {
      allModels.push(...models)
    }
  }
  hermesManager.writeHermesConfig(allModels)
}

/**
 * 确保 Hermes 已启动并为该渲染端会话创建 ACP 会话
 * 失败返回 null（调用方降级为直连模式）
 */
async function ensureHermesSession(sessionId: string): Promise<string | null> {
  try {
    if (!hermesManager.isRunning) {
      syncHermesConfig()
      await hermesManager.start()
    }
    let hermesSessionId = hermesSessions.get(sessionId)
    if (!hermesSessionId) {
      hermesSessionId = await hermesManager.createSession()
      hermesSessions.set(sessionId, hermesSessionId)
    }
    return hermesSessionId
  } catch (err: any) {
    logManager?.warn(`Hermes 会话创建失败（降级直连）: ${err.message}`)
    return null
  }
}

function registerIpcHandlers() {
  // ============ 激活模块 ============
  ipcMain.handle('activation:activate', async (_event, code: string) => {
    return activationManager.activate(code)
  })

  ipcMain.handle('activation:validate', async () => {
    return activationManager.validate()
  })

  ipcMain.handle('activation:status', async () => {
    return activationManager.getStatus()
  })

  // ============ 会话模块 ============
  ipcMain.handle('session:list', async () => {
    return storageManager.getSessions()
  })

  ipcMain.handle('session:create', async (_event, name?: string) => {
    return storageManager.createSession(name)
  })

  ipcMain.handle('session:delete', async (_event, sessionId: string) => {
    hermesSessions.delete(sessionId)
    return storageManager.deleteSession(sessionId)
  })

  ipcMain.handle('session:switch', async (_event, sessionId: string) => {
    return storageManager.switchSession(sessionId)
  })

  ipcMain.handle('session:rename', async (_event, sessionId: string, name: string) => {
    return storageManager.renameSession(sessionId, name)
  })

  ipcMain.handle('session:getMessages', async (_event, sessionId: string) => {
    return storageManager.getSessionMessages(sessionId)
  })

  ipcMain.handle('session:saveMessage', async (_event, sessionId: string, message: any) => {
    return storageManager.saveMessage(sessionId, message)
  })

  // ============ 聊天模块（仅走 Hermes 智能体，不降级直连） ============
  ipcMain.handle('chat:stream', async (_event, message: string, sessionId: string, _modelOverride?: string, intentMeta?: IntentMeta) => {
    const channel = `chat:stream:${sessionId}:${Date.now()}`
    const send = (payload: any) => mainWindow?.webContents.send(channel, payload)

    // P0 隐形内核：路由业务意图，装配 skill/工作流/输出契约，原文照存照显
    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // 渠道会话双向桥接：客户端发送的消息复用渠道 ACP 会话，回复同时发回渠道
    if (channelManager.handleClientTurn(sessionId, prepared, send)) {
      return { channel }
    }

    intentRouter.recordStart(prepared)

    const hermesSessionId = await ensureHermesSession(sessionId)
    if (!hermesSessionId) {
      const error = 'Hermes 智能体未运行，请检查日志后重试（模型配置 → 日志）'
      intentRouter.recordEnd(prepared.taskId, 'error', error)
      send({ type: 'error', data: error })
      return { channel }
    }

    hermesManager.sendPrompt(prepared.prompt, hermesSessionId, {
      onText: (text: string) => send({ type: 'chunk', data: text }),
      onThinking: (text: string) => send({ type: 'thinking', data: text }),
      onDone: () => {
        intentRouter.recordEnd(prepared.taskId, 'done')
        send({ type: 'done' })
      },
      onError: (error: string) => {
        intentRouter.recordEnd(prepared.taskId, 'error', error)
        send({ type: 'error', data: error })
      }
    }).catch((err: any) => {
      intentRouter.recordEnd(prepared.taskId, 'error', err.message)
      send({ type: 'error', data: err.message })
    })

    return { channel }
  })

  // 非流式发送
  ipcMain.handle('chat:send', async (_event, message: string, sessionId: string, _modelOverride?: string, intentMeta?: IntentMeta) => {
    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // 渠道会话双向桥接（非流式备用路径）
    const channelResult = await channelManager.handleClientSend(sessionId, prepared)
    if (channelResult) return channelResult

    intentRouter.recordStart(prepared)

    const hermesSessionId = await ensureHermesSession(sessionId)
    if (!hermesSessionId) {
      const error = 'Hermes 智能体未运行，请检查日志后重试（模型配置 → 日志）'
      intentRouter.recordEnd(prepared.taskId, 'error', error)
      return { success: false, error }
    }

    return new Promise((resolve) => {
      let full = ''
      hermesManager.sendPrompt(prepared.prompt, hermesSessionId, {
        onText: (text: string) => { full += text },
        onThinking: () => {},
        onDone: () => {
          intentRouter.recordEnd(prepared.taskId, 'done')
          resolve({ success: true, content: full })
        },
        onError: (error: string) => {
          intentRouter.recordEnd(prepared.taskId, 'error', error)
          resolve({ success: false, error })
        }
      }).catch((err: any) => {
        intentRouter.recordEnd(prepared.taskId, 'error', err.message)
        resolve({ success: false, error: err.message })
      })
    })
  })

  // 停止生成
  ipcMain.handle('chat:stop', async () => {
    hermesManager.stopGeneration().catch(() => {})
    return true
  })

  // 发送斜杠命令（/stop、/new、/help 等），不打断当前流式回复
  ipcMain.handle('chat:command', async (_event, command: string, sessionId: string) => {
    try {
      const hermesSessionId = await ensureHermesSession(sessionId)
      if (!hermesSessionId) {
        return { success: false, error: 'Hermes 会话不可用' }
      }
      await hermesManager.sendCommand(command, hermesSessionId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // 测试模型连接
  ipcMain.handle('model:test', async (_event, provider: any) => {
    return modelRouter.testConnection(provider)
  })

  // 从 API 获取可用模型列表
  ipcMain.handle('model:list', async (_event, provider: any) => {
    return modelRouter.listModels(provider)
  })

  // ============ 配置模块 ============
  ipcMain.handle('config:get', async () => {
    return storageManager.getConfig()
  })

  ipcMain.handle('config:set', async (_event, key: string, value: any) => {
    // 如果是模型配置，同时写入 Hermes 配置
    if (key === 'modelConfig') {
      const allModels: any[] = []
      for (const type of ['dialogue', 'image', 'video', 'multimodal']) {
        if (Array.isArray((value as any)[type])) {
          allModels.push(...(value as any)[type])
        }
      }
      hermesManager.writeHermesConfig(allModels)
    }
    return storageManager.setConfig(key, value)
  })

  // ============ 模板模块 ============
  ipcMain.handle('template:list', async () => {
    return storageManager.getTemplates()
  })

  ipcMain.handle('template:create', async (_event, template: any) => {
    return storageManager.createTemplate(template)
  })

  ipcMain.handle('template:update', async (_event, id: string, template: any) => {
    return storageManager.updateTemplate(id, template)
  })

  ipcMain.handle('template:delete', async (_event, id: string) => {
    return storageManager.deleteTemplate(id)
  })

  ipcMain.handle('template:import', async (_event, filePath: string) => {
    return fileEngine.importTemplates(filePath)
  })

  ipcMain.handle('template:export', async (_event, filePath: string) => {
    const templates = storageManager.getTemplates()
    return fileEngine.exportTemplates(filePath, templates)
  })

  // ============ 文件模块 ============
  ipcMain.handle('file:export', async (_event, format: string, content: any, filePath?: string) => {
    if (!filePath) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        filters: getFileFilters(format)
      })
      if (result.canceled) return { success: false, message: '用户取消' }
      filePath = result.filePath
    }
    return fileEngine.exportFile(format, content, filePath!)
  })

  ipcMain.handle('file:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [
        { name: '文本和图片', extensions: ['txt', 'md', 'png', 'jpg', 'jpeg', 'gif', 'bmp'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false }
    return fileEngine.importFile(result.filePaths[0])
  })

  // ============ 公告模块 ============
  ipcMain.handle('announcement:check', async () => {
    return storageManager.checkAnnouncement()
  })

  ipcMain.handle('announcement:markRead', async () => {
    return storageManager.markAnnouncementRead()
  })

  // ============ 系统模块 ============
  ipcMain.handle('system:networkStatus', async () => {
    // 简单的网络状态检测
    return { online: true }
  })

  ipcMain.handle('system:fingerprint', async () => {
    return activationManager.getDeviceFingerprint()
  })

  // ============ Hermes 状态 ============
  ipcMain.handle('hermes:status', async () => {
    return hermesManager.getStatus()
  })

  ipcMain.handle('hermes:healthCheck', async () => {
    return { ok: hermesManager.isRunning }
  })

  ipcMain.handle('hermes:commands', async () => {
    return hermesManager.getAvailableCommands()
  })

  // ============ 日志模块 ============
  ipcMain.handle('log:getLevel', async () => {
    return logManager.getLevel()
  })

  ipcMain.handle('log:setLevel', async (_event, level: string) => {
    return logManager.setLevel(level)
  })

  // ============ 企业画像模块 ============
  ipcMain.handle('company:status', async () => {
    return {
      completed: storageManager.hasCompanyProfile(),
      profile: storageManager.getCompanyProfile(),
      knowledge: storageManager.getCompanyKnowledge()
    }
  })

  // 固定问卷：不依赖 API，答案直接落为全局个性化知识库
  ipcMain.handle('company:saveAnswers', async (_event, answers: Record<string, string>) => {
    const profile: Record<string, string> = {
      name: answers.name || '',
      industry: answers.industry || '',
      scale: answers.scale || '',
      mainBusiness: answers.mainBusiness || '',
      targetCustomers: answers.targetCustomers || '',
      city: answers.city || '',
      painPoints: answers.painPoints || '',
      usageScenarios: answers.usageScenarios || '',
      tone: answers.tone || '',
      compliance: answers.compliance || ''
    }

    const knowledge = {
      profile,
      qa: Object.entries(answers)
        .filter(([, value]) => String(value || '').trim())
        .map(([key, value]) => ({ key, answer: String(value) })),
      updatedAt: new Date().toISOString()
    }

    storageManager.saveCompanyProfile(profile)
    storageManager.saveCompanyKnowledge(knowledge)
    hermesManager.writeCompanyContext(knowledge)
    intentRouter.setCompanyProfile(profile)
    logManager.info('企业信息与个性化知识库已保存')
    return { success: true }
  })

  // ============ 渠道接入模块 ============
  ipcMain.handle('channel:status', async () => {
    return channelManager.getStatuses()
  })

  ipcMain.handle('channel:config', async () => {
    return channelManager.getConfigs()
  })

  ipcMain.handle('channel:save', async (_event, channel: ChannelId, config: any) => {
    return channelManager.saveConfig(channel, config)
  })

  // 扫码接入：begin 返回二维码 URL/dataURL；前端轮询 poll 获取扫码结果凭据
  ipcMain.handle('channel:scanBegin', async (_event, channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu') => {
    return channelManager.scanBegin(channel)
  })

  ipcMain.handle('channel:scanPoll', async (_event, channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu', session: string) => {
    return channelManager.scanPoll(channel, session)
  })

  // ============ 在线升级模块 ============
  ipcMain.handle('update:check', async () => {
    return giteeUpdater.checkForUpdates()
  })

  ipcMain.handle('update:download', async () => {
    return giteeUpdater.downloadLatest()
  })

  ipcMain.handle('update:install', async (_event, filePath: string) => {
    return giteeUpdater.install(filePath)
  })

  ipcMain.handle('update:cancel', async () => {
    giteeUpdater.cancelDownload()
    return true
  })

  // ============ 权限审批模块 ============
  ipcMain.handle('permission:respond', async (_event, requestId: number, allow: boolean) => {
    const resolve = pendingApprovals.get(requestId)
    if (resolve) {
      pendingApprovals.delete(requestId)
      resolve(allow)
    }
    return true
  })

  // ============ 应用生命周期模块 ============
  // 渲染进程可发起显式退出，主进程统一弹确认框并停止服务
  ipcMain.handle('app:quit', async () => {
    return requestQuit()
  })
}

function getTrayIcon() {
  try {
    const iconPath = path.join(app.getAppPath(), 'resources', 'icon.ico')
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath)
      if (!icon.isEmpty()) return icon
    }
  } catch { /* ignore */ }

  // 内置 16x16 PNG 兜底图标（蓝色圆角方块 + 白色 H），确保任何情况下托盘可用
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXklEQVR4nGNkgALV5Nf/GUgAt+eKMoJoJnI0I+thJEczMmCiRDOGAbfmiIAxLoBNnomqLiAHsGATxOcN+rhALeUNA7EuY6LUBUyUGsA48CkRlqvIASC9YBeQYwhMDwAf/R7U8pltTQAAAABJRU5ErkJggg=='
  )
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function getEnabledChannelCount(): number {
  try {
    const config = storageManager?.getChannelConfig()
    if (!config || typeof config !== 'object') return 0
    return Object.values(config).filter((value: any) => {
      if (!value || typeof value !== 'object') return false
      if (value.enabled === true || value.configured === true) return true
      return Object.keys(value).some(key => {
        const v = value[key]
        return typeof v === 'string' && v.trim().length > 0
      })
    }).length
  } catch {
    return 0
  }
}

/**
 * 显式退出：弹确认框，确认后停止 Hermes 服务与全部渠道接入。
 */
async function requestQuit(): Promise<{ confirmed: boolean }> {
  const channelCount = getEnabledChannelCount()
  const detail = channelCount > 0
    ? `检测到 ${channelCount} 个渠道接入已配置/启用，退出后这些 Bot 将立即停止响应。`
    : '当前没有检测到已启用的渠道接入。退出后本地 AI 服务将停止。'

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '确认退出并停止服务',
    message: '确定要退出 Hermes 并停止服务吗？',
    detail,
    buttons: ['取消', '退出并停止服务'],
    defaultId: 0,
    cancelId: 0
  })

  if (result.response === 1) {
    isQuitting = true
    app.quit()
    return { confirmed: true }
  }
  return { confirmed: false }
}

function createTray() {
  if (tray) return
  tray = new Tray(getTrayIcon())
  tray.setToolTip('Hermes 人事行政智能专家 - 服务运行中，关闭窗口不会停止服务')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出并停止服务', click: () => { requestQuit() } }
  ]))
  tray.on('click', () => showMainWindow())
}

function getFileFilters(format: string) {
  const filters: Record<string, Electron.FileFilter[]> = {
    docx: [{ name: 'Word 文档', extensions: ['docx'] }],
    xlsx: [{ name: 'Excel 文档', extensions: ['xlsx'] }],
    pptx: [{ name: 'PowerPoint 文档', extensions: ['pptx'] }],
    png: [{ name: 'PNG 图片', extensions: ['png'] }],
    txt: [{ name: '文本文件', extensions: ['txt'] }],
    md: [{ name: 'Markdown 文件', extensions: ['md'] }]
  }
  return filters[format] || [{ name: '所有文件', extensions: ['*'] }]
}

// 应用生命周期
app.whenReady().then(() => {
  // 系统关机/注销时放行关闭，避免隐藏窗口逻辑阻止系统关机
  powerMonitor.on('shutdown', () => {
    isQuitting = true
    channelManager?.stopAll().finally(() => hermesManager?.stop())
  })

  createTray()
  initializeApp()
})

// 常驻后台：窗口全部关闭时不退出、不停止服务。
// 真正的退出只能通过托盘菜单 / 系统设置中的“退出并停止服务”（requestQuit）。
app.on('window-all-closed', () => {
  if (isQuitting) {
    channelManager?.stopAll().finally(() => hermesManager?.stop())
  }
})

app.on('activate', () => {
  showMainWindow()
})

app.on('before-quit', () => {
  isQuitting = true
  channelManager?.stopAll().finally(() => hermesManager?.stop())
})

