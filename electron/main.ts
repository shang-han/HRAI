import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor, screen } from 'electron'
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

// 窗口最大化动画：手动对 bounds 做缓动插值，避免 Windows 原生瞬时跳变
let animTimer: ReturnType<typeof setInterval> | null = null
let manualMaximized = false
let savedNormalBounds: Electron.Rectangle | null = null

// 渲染端会话 -> Hermes ACP 会话 映射
const hermesSessions = new Map<string, string>()
// ACP 审批请求 -> Promise resolve
const pendingApprovals = new Map<number, (allow: boolean) => void>()

/** 是否已有"启用且填写了 API Key"的对话模型（聊天可用性的前置条件） */
function hasUsableDialogueModel(): boolean {
  const list = storageManager?.getConfig()?.modelConfig?.dialogue || []
  return list.some((p: any) => p.enabled && p.apiKey && p.apiKey.trim())
}

/** 把底层模型错误翻译成人话（避免裸 401 透传给用户） */
function friendlyModelError(error: string): string {
  const e = String(error || '').toLowerCase()
  if (e.includes('401') || e.includes('authentication')) {
    return '模型认证失败（401）：请打开"模型接入配置"，启用对话模型并填写正确的 API Key'
  }
  return error
}

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
    // 无边框窗口：标题栏由渲染层自绘（图标+系统名称+中文菜单同行）。
    // frame: false 去掉标题栏，thickFrame: false 再去掉 Windows 标准细边框与阴影。
    // transparent: 窗口透明，配合渲染层圆角实现真正的圆角窗口（角外透出桌面）。
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false
  })

  // 开发模式加载 Vite dev server，生产模式加载打包文件
  // 调试工具不再自动打开，需要时用"视图 → 开发者工具"手动开启
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
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

  // 最大化状态变化时推送给渲染层，标题栏按钮图标跟随切换
  mainWindow.on('maximize', () => mainWindow?.webContents.send('app:maximizedChanged', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('app:maximizedChanged', false))

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

  // 清理旧版本遗留的 gateway/channel_sync 进程，避免微信/企微双通道抢消息
  await hermesManager.killLegacyGatewayProcesses().catch((err: any) => {
    logManager.debug(`旧进程清理跳过: ${err.message}`)
  })

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
  registerWindowControlHandlers()

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

  // 近期重点工作：保存 / 从历史恢复
  ipcMain.handle('session:setWorkPriority', async (_event, sessionId: string, data: any) => {
    return storageManager.setWorkPriority(sessionId, data)
  })

  ipcMain.handle('session:restoreWorkPriority', async (_event, sessionId: string, historyIndex: number) => {
    return storageManager.restoreWorkPriority(sessionId, historyIndex)
  })

  ipcMain.handle('session:clearWorkPriority', async (_event, sessionId: string) => {
    return storageManager.clearWorkPriority(sessionId)
  })

  ipcMain.handle('session:deleteWorkPriorityHistory', async (_event, sessionId: string, historyIndex: number) => {
    return storageManager.deleteWorkPriorityHistory(sessionId, historyIndex)
  })

  // ============ 聊天模块（仅走 Hermes 智能体，不降级直连） ============
  ipcMain.handle('chat:stream', async (_event, message: string, sessionId: string, _modelOverride?: string, images?: string[], intentMeta?: IntentMeta) => {
    const channel = `chat:stream:${sessionId}:${Date.now()}`
    const send = (payload: any) => mainWindow?.webContents.send(channel, payload)

    // 带图片时直接走多模态模型，不经过 Hermes 文本 ACP（Hermes 目前不读图）
    if (images && images.length > 0) {
      const multimodalModel = modelRouter.getMultimodalModel()
      if (!multimodalModel) {
        send({ type: 'error', data: '未启用多模态模型，请先在右上角“模型 → 多模态模型”中配置并启用' })
        return { channel }
      }
      modelRouter.callModelStream(
        multimodalModel,
        message,
        storageManager.getConfig(),
        (text: string) => send({ type: 'chunk', data: text }),
        (error: string) => send({ type: 'error', data: error }),
        () => send({ type: 'done' }),
        channel,
        images
      ).catch((err: any) => {
        send({ type: 'error', data: err.message || '多模态模型调用失败' })
      })
      return { channel }
    }

    // P0 隐形内核：路由业务意图，装配 skill/工作流/输出契约，原文照存照显
    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // 渠道会话双向桥接：客户端发送的消息复用渠道 ACP 会话，回复同时发回渠道
    if (channelManager.handleClientTurn(sessionId, prepared, send)) {
      return { channel }
    }

    intentRouter.recordStart(prepared)

    // 图片/视频生成任务自动路由：按任务类型走"第一个已启用"的对应模型（不走 Hermes）
    const taskType = modelRouter.detectTaskType(message)
    if (taskType === 'image' || taskType === 'video') {
      const taskModel = modelRouter.getFirstEnabled(taskType)
      if (!taskModel) {
        const label = taskType === 'image' ? '图片' : '视频'
        const error = `未启用${label}模型，请先在"模型接入配置"中启用并配置对应模型`
        intentRouter.recordEnd(prepared.taskId, 'error', error)
        send({ type: 'error', data: error })
        return { channel }
      }
      modelRouter.callModelStream(
        taskModel,
        message,
        storageManager.getConfig(),
        (text: string) => send({ type: 'chunk', data: text }),
        (error: string) => {
          intentRouter.recordEnd(prepared.taskId, 'error', error)
          send({ type: 'error', data: error })
        },
        () => {
          intentRouter.recordEnd(prepared.taskId, 'done')
          send({ type: 'done' })
        },
        channel
      ).catch((err: any) => {
        intentRouter.recordEnd(prepared.taskId, 'error', err.message)
        send({ type: 'error', data: err.message })
      })
      return { channel }
    }

    // 发送前检查：没有任何"启用且填了 Key"的对话模型时直接明确提示，
    // 避免 Hermes 用空配置调用模型后透传裸 401
    if (!hasUsableDialogueModel()) {
      const error = '未启用对话模型：请打开"模型接入配置"，启用对话模型并填写 API Key'
      intentRouter.recordEnd(prepared.taskId, 'error', error)
      send({ type: 'error', data: error })
      return { channel }
    }

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
        send({ type: 'error', data: friendlyModelError(error) })
      }
    }).catch((err: any) => {
      intentRouter.recordEnd(prepared.taskId, 'error', err.message)
      send({ type: 'error', data: friendlyModelError(err.message) })
    })

    return { channel }
  })

  // 非流式发送
  ipcMain.handle('chat:send', async (_event, message: string, sessionId: string, _modelOverride?: string, images?: string[], intentMeta?: IntentMeta) => {
    // 带图片时直接走多模态模型，不经过 Hermes 文本 ACP
    if (images && images.length > 0) {
      const multimodalModel = modelRouter.getMultimodalModel()
      if (!multimodalModel) {
        return { success: false, error: '未启用多模态模型，请先在右上角“模型 → 多模态模型”中配置并启用' }
      }
      const result = await modelRouter.callModel(multimodalModel, message, storageManager.getConfig(), images)
      return result.success
        ? { success: true, content: result.content }
        : { success: false, error: result.error }
    }

    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // 渠道会话双向桥接（非流式备用路径）
    const channelResult = await channelManager.handleClientSend(sessionId, prepared)
    if (channelResult) return channelResult

    intentRouter.recordStart(prepared)

    // 图片/视频生成任务自动路由（与流式一致）
    const taskType = modelRouter.detectTaskType(message)
    if (taskType === 'image' || taskType === 'video') {
      const taskModel = modelRouter.getFirstEnabled(taskType)
      if (!taskModel) {
        const label = taskType === 'image' ? '图片' : '视频'
        const error = `未启用${label}模型，请先在"模型接入配置"中启用并配置对应模型`
        intentRouter.recordEnd(prepared.taskId, 'error', error)
        return { success: false, error }
      }
      const result = await modelRouter.callModel(taskModel, message, storageManager.getConfig())
      intentRouter.recordEnd(prepared.taskId, result.success ? 'done' : 'error', result.error)
      return result.success
        ? { success: true, content: result.content }
        : { success: false, error: result.error }
    }

    // 发送前检查（与流式一致）：没有可用对话模型时明确提示
    if (!hasUsableDialogueModel()) {
      const error = '未启用对话模型：请打开"模型接入配置"，启用对话模型并填写 API Key'
      intentRouter.recordEnd(prepared.taskId, 'error', error)
      return { success: false, error }
    }

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
          resolve({ success: false, error: friendlyModelError(error) })
        }
      }).catch((err: any) => {
        intentRouter.recordEnd(prepared.taskId, 'error', err.message)
        resolve({ success: false, error: friendlyModelError(err.message) })
      })
    })
  })

  // 停止生成
  ipcMain.handle('chat:stop', async () => {
    modelRouter.abortAll()
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
    try {
      const result = await modelRouter.listModels(provider)
      logManager.info(`model:list ${provider?.id || provider?.modelName || ''} -> ${result.success ? (result.models?.length || 0) + ' models' : result.message}`)
      return result
    } catch (err: any) {
      logManager.error('model:list handler error', err)
      return { success: false, message: `获取模型列表失败: ${err?.message || err}` }
    }
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

  ipcMain.handle('update:install', async (_event, filePath: string, updateType: 'incremental' | 'full') => {
    return giteeUpdater.install(filePath, updateType || 'full')
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
  ipcMain.handle('app:version', async () => {
    return app.getVersion()
  })

  // 渲染进程可发起显式退出，主进程统一弹确认框并停止服务
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

/**
 * 应用菜单：标题栏由渲染层自绘（图标+系统名称+中文菜单同行），
 * 原生标题栏隐藏后菜单条随之消失，这里显式移除，避免多出一条英文菜单。
 */
function setupAppMenu() {
  Menu.setApplicationMenu(null)
}

/**
 * 窗口控制：渲染层自绘标题栏上的最小化/最大化/关闭按钮，
 * 以及"视图/窗口/帮助"菜单所需的窗口操作，全部经由 IPC 转发。
 */
function registerWindowControlHandlers() {
  ipcMain.handle('app:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('app:toggleMaximize', () => toggleMaximizeAnimated())

  // 关闭窗口：走与点 X 相同的 close 事件 → 隐藏到托盘，服务继续运行
  ipcMain.handle('app:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('app:openDevTools', () => {
    mainWindow?.webContents.openDevTools()
  })

  // 查询窗口是否最大化（渲染层据此切换"最大化/还原"图标）
  ipcMain.handle('app:isMaximized', () => {
    return manualMaximized || (mainWindow?.isMaximized() ?? false)
  })

  ipcMain.handle('app:zoom', (_event, dir: 'in' | 'out' | 'reset') => {
    const wc = mainWindow?.webContents
    if (!wc) return
    const current = wc.getZoomLevel()
    if (dir === 'in') wc.setZoomLevel(Math.min(current + 0.5, 3))
    else if (dir === 'out') wc.setZoomLevel(Math.max(current - 0.5, -3))
    else wc.setZoomLevel(0)
  })

  ipcMain.handle('app:about', () => {
    dialog.showMessageBox({
      type: 'info',
      title: '关于',
      message: 'Hermes 人事行政一体化智能专家',
      detail: `版本 ${app.getVersion()}\n面向中小企业的人事+行政一体化 AI 智能助手`,
      buttons: ['确定']
    }).catch(() => {})
  })
}

/**
 * 最大化/还原慢动画：手动对窗口 bounds 做缓动插值。
 * 状态由 manualMaximized 自行维护，并通过 maximizedChanged 推送，
 * 标题栏按钮图标随之切换；双击标题栏、窗口菜单都走这里。
 */
async function toggleMaximizeAnimated(): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed() || animTimer) return

  // 原生最大化（如 Win+↑ / 系统贴靠）直接还原，不走手动动画
  if (win.isMaximized()) {
    win.unmaximize()
    return
  }

  if (manualMaximized) {
    manualMaximized = false
    const target = savedNormalBounds || { x: 100, y: 100, width: 1400, height: 900 }
    await animateWindowTo(target, 350)
  } else {
    savedNormalBounds = win.getBounds()
    manualMaximized = true
    const workArea = screen.getDisplayMatching(savedNormalBounds).workArea
    await animateWindowTo(workArea, 350)
  }
  win.webContents.send('app:maximizedChanged', manualMaximized)
}

/** 对窗口位置/尺寸做 ease-out 缓动插值动画 */
function animateWindowTo(target: Electron.Rectangle, duration: number): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return Promise.resolve()

  const start = win.getBounds()
  const startTime = Date.now()

  return new Promise((resolve) => {
    animTimer = setInterval(() => {
      const t = Math.min((Date.now() - startTime) / duration, 1)
      const ease = 1 - Math.pow(1 - t, 3) // ease-out cubic，末尾减速更自然
      const bounds = {
        x: Math.round(start.x + (target.x - start.x) * ease),
        y: Math.round(start.y + (target.y - start.y) * ease),
        width: Math.round(start.width + (target.width - start.width) * ease),
        height: Math.round(start.height + (target.height - start.height) * ease),
      }
      win.setBounds(bounds)
      if (t >= 1 && animTimer) {
        clearInterval(animTimer)
        animTimer = null
        resolve()
      }
    }, 16)
  })
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

// 单实例锁：避免用户重复启动导致 Hermes 服务/渠道 Bot 多开
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  // 已有实例运行时，第二次启动只唤起主窗口，不创建新实例
  app.on('second-instance', () => {
    showMainWindow()
  })

  // 应用生命周期
  app.whenReady().then(() => {
    // 系统关机/注销时放行关闭，避免隐藏窗口逻辑阻止系统关机
    powerMonitor.on('shutdown', () => {
      isQuitting = true
      channelManager?.stopAll().finally(() => hermesManager?.stop())
    })

    createTray()
    setupAppMenu()
    initializeApp()
  })
}

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

