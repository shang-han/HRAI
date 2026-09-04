import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor, screen } from 'electron'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { HermesManager } from './hermes-manager'
import { StorageManager } from './storage-manager'
import { ActivationManager } from './activation-manager'
import { ModelRouter } from './model-router'
import { FileEngine } from './file-engine'
import { LogManager } from './log-manager'
import { IntentRouter, IntentMeta } from './intent-router'
import { getFormatStore } from './format/format-store'
import { registerFormatIpc } from './format/format-ipc'
import { snapshotOutputDir, harvestNewXlsx } from './format/format-signals'
import type { OutputSnapshot } from './format/format-signals'
import type { SkeletonStore } from './format/skeleton-store'
import { ChannelManager } from './channel-engine/channel-manager'
import { GiteeUpdater } from './gitee-updater'
import { ChannelId } from './channel-engine/types'
import { KnowledgeManager } from './knowledge-manager'

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
let knowledgeManager: KnowledgeManager
// P2 结构复用：格式模板库单例。召回（intent-router）与 IPC（format:*）共用同一实例，
// 否则「prompt 里套用的格式」和「我的格式 Tab 里看到的」会是两个互不可见的状态。
let formatStore: SkeletonStore | null = null
let tray: Tray | null = null
let scheduleTimer: ReturnType<typeof setInterval> | null = null
// P1-3：格式模板 90 天衰减的每日定时器
let formatDecayTimer: ReturnType<typeof setInterval> | null = null
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
// 权限审批自动拒绝超时。改这个值必须同步改 ChatArea 的 PERMISSION_TIMEOUT_SEC（横幅倒计时），
// 两者不一致时横幅会显示错误的时间或提前收起。
const PERMISSION_TIMEOUT_MS = 60 * 1000
// 前端会话 -> 上下文占用/缓存用量快照。
// HermesManager 只认 ACP 会话 id，这里保存反查后的结果，
// 供渲染进程挂载/切会话时一次性取（IPC 推送只覆盖"变化时"）。
const usageBySession = new Map<string, any>()

// P1-1：output 目录 -> 进行中的采集任务（taskId）集合。
// 两个任务同时跑、共用一个 output：快照按任务隔离但目录不隔离，A 的采集可能把
// B 刚产出的文件挂到 A 的 intentId。对策是「宁可不采，不可错采」：
// 同目录还有别的任务在采集窗口内时，本趟采集直接跳过。
const harvestTasksByDir = new Map<string, Set<string>>()

/**
 * 聊天前置检查：返回"为什么不能用"的说明，null 表示可以发送。
 * 语义：优先用输入框下拉选中的模型，没选过用配置页"默认"，不做自动回退。
 */
function dialogueModelIssue(): string | null {
  const cfg: any = storageManager?.getConfig() || {}
  const list = cfg.modelConfig?.dialogue || []
  const selected =
    list.find((p: any) => p.id === cfg.selectedModels?.dialogue && p.enabled !== false) ||
    list.find((p: any) => p.isPrimary && p.enabled !== false)
  if (!selected) {
    return '尚未选择对话模型：请在输入框的模型下拉中选择一个模型'
  }
  if (!(selected.apiKey && selected.apiKey.trim())) {
    return `所选模型「${selected.name}」未填写 API Key，请在"模型接入配置"中补充`
  }
  return null
}

/** 把底层模型错误翻译成人话（避免裸 401 透传给用户） */
function friendlyModelError(error: string): string {
  const e = String(error || '').toLowerCase()
  if (e.includes('401') || e.includes('authentication')) {
    return '模型认证失败（401）：请打开"模型接入配置"，启用对话模型并填写正确的 API Key'
  }
  if (e.includes('internal error')) {
    return '任务执行出错，请重试（若长时间未响应可先点"停止"）'
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

function startScheduledTaskChecker() {
  if (scheduleTimer) return
  scheduleTimer = setInterval(() => {
    try { checkScheduledTasks() } catch { /* ignore */ }
  }, 15 * 1000)
  scheduleTimer.unref?.()
  checkScheduledTasks()
}

function checkScheduledTasks() {
  if (!storageManager) return
  const now = Date.now()
  const tasks = storageManager.getScheduledTasks()
  for (const task of tasks) {
    if (!task.enabled) continue
    const due = new Date(task.dueAt).getTime()
    if (!Number.isFinite(due) || due > now) continue
    fireScheduledTask(task)
  }
}

async function fireScheduledTask(task: any) {
  const nowIso = new Date().toISOString()
  const updates: any = { lastFiredAt: nowIso }
  if (task.repeat && task.repeat !== 'none') {
    const next = new Date(nowIso)
    if (task.repeat === 'daily') next.setDate(next.getDate() + 1)
    else if (task.repeat === 'weekly') next.setDate(next.getDate() + 7)
    else if (task.repeat === 'monthly') next.setMonth(next.getMonth() + 1)
    updates.dueAt = next.toISOString()
  } else {
    updates.enabled = false
  }
  storageManager.updateScheduledTask(task.id, updates)

  const sessionId = task.sessionId || storageManager.getSessions()[0]?.id || ''
  const messages: any[] = []
  if (!sessionId) {
    logManager?.warn('定时任务触发失败：没有可用会话')
    mainWindow?.webContents.send('schedule:fired', { taskId: task.id, sessionId: '', messages: [] })
    return
  }

  try {
    if (task.kind === 'task') {
      const userMessage = {
        id: Date.now().toString(),
        role: 'user' as const,
        content: `⏰ 定时任务：${task.title || ''}
${task.content || ''}`,
        timestamp: new Date().toISOString()
      }
      storageManager.saveMessage(sessionId, userMessage)
      messages.push(userMessage)

      const sessionResult = await ensureHermesSession(sessionId)
      if ('error' in sessionResult) {
        const errorMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant' as const,
          content: `⚠️ 定时任务执行失败：${sessionResult.error}`,
          timestamp: new Date().toISOString()
        }
        storageManager.saveMessage(sessionId, errorMessage)
        messages.push(errorMessage)
      } else {
        let full = ''
        let errorText: string | null = null
        try {
          await hermesManager.sendPrompt(task.content || task.title || '', sessionResult.sessionId, {
            onText: (text: string) => { full += text },
            onThinking: () => {},
            onDone: () => {},
            onError: (error: string) => { errorText = error }
          })
        } catch (err: any) {
          errorText = err.message || '定时任务执行失败'
        }
        const assistantMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant' as const,
          content: errorText
            ? `⚠️ 定时任务执行失败：${errorText}`
            : (full || '（智能体未返回内容）'),
          timestamp: new Date().toISOString()
        }
        storageManager.saveMessage(sessionId, assistantMessage)
        messages.push(assistantMessage)
      }
    } else {
      const reminderMessage = {
        id: Date.now().toString(),
        role: 'assistant' as const,
        content: `🔔 定时提醒：${task.title || ''}
${task.content || ''}`,
        timestamp: new Date().toISOString()
      }
      storageManager.saveMessage(sessionId, reminderMessage)
      messages.push(reminderMessage)
    }
  } catch (err: any) {
    logManager?.error('定时任务执行失败', err)
    const errorMessage = {
      id: Date.now().toString(),
      role: 'assistant' as const,
      content: `⚠️ 定时任务执行异常：${err.message}`,
      timestamp: new Date().toISOString()
    }
    storageManager.saveMessage(sessionId, errorMessage)
    messages.push(errorMessage)
  }

  mainWindow?.webContents.send('schedule:fired', { taskId: task.id, sessionId, messages })
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

  // 初始化企业文档资产库（确认采纳的文件 -> 结构化资产，供意图路由检索注入）
  knowledgeManager = new KnowledgeManager(logManager)
  knowledgeManager.init()
  intentRouter.setKnowledgeManager(knowledgeManager)

  // 提示词里的"当前工作目录"要按会话真实 cwd 生成，先把内置工作区告诉意图路由
  intentRouter.setDefaultWorkDir(hermesManager.getWorkspacePath())

  // 初始化格式模板库（P2 结构复用：把用户惯用格式注入 prompt）。
  // 必须 await：registerIpcHandlers() 在下面就要用这个实例注册 format:* 通道。
  // 失败只降级（结构复用不可用），不阻断启动。
  try {
    formatStore = await getFormatStore()
    intentRouter.setFormatStore(formatStore)
    logManager.info('格式模板库初始化完成')
    // P1-3：90 天衰减此前零调用，永不生效。启动即跑一次，之后每天一次。
    // 衰减配置默认只含 candidate/active（不含 instance），不会打断复用累计；
    // 失败只 warn —— 衰减是后台清理，绝不能阻断启动。
    const runDecay = (s: SkeletonStore) => {
      void s.applyDecay()
        .then((r) => {
          if (r.decayed.length > 0) {
            logManager.info(`[格式衰减] 扫描 ${r.scanned} 条，归档 ${r.decayed.length} 条长期未用模板`)
          }
        })
        .catch((err: any) => {
          logManager.warn(`[格式衰减] 执行失败（不影响主流程）：${err?.message || err}`)
        })
    }
    runDecay(formatStore)
    formatDecayTimer = setInterval(() => {
      if (formatStore) runDecay(formatStore)
    }, 24 * 60 * 60 * 1000)
  } catch (err: any) {
    logManager.warn(`格式模板库初始化失败，结构复用不可用: ${err.message}`)
  }

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
      // 防止窗口未打开时审批挂死：60 秒后自动拒绝。
      // 宁可让用户看到失败重发，也不要干等 5 分钟 —— 弹窗被遮挡时用户根本不知道要审批。
      setTimeout(() => {
        if (pendingApprovals.has(payload.requestId)) {
          pendingApprovals.delete(payload.requestId)
          resolve(false)
          // 超时路径也要推 resolved，否则 ChatArea 的兜底横幅不会消失（会一直显示倒计时）
          mainWindow?.webContents.send('permission:resolved', { requestId: payload.requestId })
        }
      }, PERMISSION_TIMEOUT_MS)
      mainWindow?.webContents.send('permission:request', payload)
    })
  })


  // 上下文占用/缓存用量：内核按 ACP 会话 id 上报，这里反查回前端会话 id 再推给界面。
  // 反查用遍历而不是再维护一张反向表：hermesSessions 的规模等于会话数（几十条量级），
  // 而两张表同步失配的代价是用量显示串到别的会话上——不值得为这点开销冒险。
  hermesManager.onUsage((acpSessionId: string, usage: any) => {
    let frontendId = ''
    for (const [fid, aid] of hermesSessions) {
      if (aid === acpSessionId) { frontendId = fid; break }
    }
    if (!frontendId) return
    usageBySession.set(frontendId, usage)
    mainWindow?.webContents.send('usage:update', { sessionId: frontendId, usage })
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

  // 启动定时提醒检查器
  startScheduledTaskChecker()

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
  hermesManager.writeHermesConfig(
    allModels,
    undefined,
    undefined,
    (storageManager.getConfig() as any)?.permissionMode || 'ask',
    (storageManager.getConfig() as any)?.selectedModels?.dialogue
  )
}

/**
 * 确保 Hermes 已启动并为该渲染端会话创建 ACP 会话。
 * 失败时返回可展示的准确原因（区分"内核没起来"与"会话创建超时"），
 * 不再统一误报"智能体未运行"。
 */
async function ensureHermesSession(sessionId: string): Promise<{ sessionId: string } | { error: string }> {
  try {
    if (!hermesManager.isRunning) {
      syncHermesConfig()
      await hermesManager.start()
      if (!hermesManager.isRunning) {
        return { error: 'Hermes 智能体未运行（Python 内核启动失败），请检查日志后重试' }
      }
    }
    let hermesSessionId = hermesSessions.get(sessionId)
    if (!hermesSessionId) {
      // 每个前端会话按自己的工作目录开 ACP 会话。空 workDir = 内置工作区，
      // 由 HermesManager.sessionCwd() 兜底，这里不做回填。
      const workDir = storageManager.getSessionById(sessionId)?.workDir || ''
      hermesSessionId = await hermesManager.createSession(workDir)
      hermesSessions.set(sessionId, hermesSessionId)
      // 内核在 session/new 里就推了第一条 usage_update，那时映射还没建立，
      // onUsage 的反查必然落空。这里补一次同步，否则"新会话的初始占用率"
      // 要等到第一轮对话结束才出现。
      const initial = hermesManager.getUsage(hermesSessionId)
      if (initial) {
        usageBySession.set(sessionId, initial)
        mainWindow?.webContents.send('usage:update', { sessionId, usage: initial })
      }
    }
    return { sessionId: hermesSessionId }
  } catch (err: any) {
    const msg = String(err?.message || err || '')
    logManager?.warn(`Hermes 会话创建失败: ${msg}`)
    if (msg.toLowerCase().includes('timeout') || msg.includes('超时')) {
      return { error: '智能体正忙（会话创建超时），请稍等几秒后重试' }
    }
    return { error: `Hermes 会话创建失败：${msg}` }
  }
}

/**
 * 校验用户选定的会话工作目录。
 *
 * 空串是合法输入，含义是"用内置工作区"。其余情况必须落在真实目录上，
 * 并挡掉两类会造成实际损害的选择：
 *  1) 盘符根目录（D:\ / /）——智能体的读写与命令都在 cwd 里跑，权限模式为 auto 时
 *     一条误判的清理命令就能扫掉整个盘；这类目录也没有任何"项目"语义。
 *  2) Hermes 安装目录内部——resources/hermes 下有内核自己的 AGENTS.md，
 *     Python 侧 runtime_cwd._is_install_tree() 正是为此设了防线；把 cwd 指进去会
 *     让贡献者文档变成"项目上下文"，且 AI 有机会改坏内核自身。
 */
function validateWorkDir(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const input = (raw || '').trim()
  if (!input) return { ok: true, path: '' }

  let resolved: string
  try {
    resolved = path.resolve(input)
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: '所选路径不是一个文件夹' }
    }
  } catch {
    return { ok: false, error: '目录不存在或无法访问，请重新选择' }
  }

  if (path.dirname(resolved) === resolved) {
    return { ok: false, error: '不能直接使用磁盘根目录，请选择具体的项目/资料文件夹' }
  }

  // 大小写不敏感 + 以 sep 结尾比较，避免 "…\hermes-x" 被误判为 "…\hermes" 的子目录
  const install = path.resolve(hermesManager.getInstallRoot()).toLowerCase()
  const target = resolved.toLowerCase()
  if (target === install || target.startsWith(install + path.sep)) {
    return { ok: false, error: '不能选择 Hermes 智能体自身的安装目录，请另选一个工作文件夹' }
  }

  // 手动浏览到内置工作区时归一成空串，让它和"选内置工作区"这个选项完全等价：
  // 否则同一个目录会存成绝对路径，提示词里走"用户自选目录"分支，
  // 反而丢掉 company_context.json / AGENTS.md 那几条说明。
  if (target === path.resolve(hermesManager.getWorkspacePath()).toLowerCase()) {
    return { ok: true, path: '' }
  }

  return { ok: true, path: resolved }
}

/**
 * 丢弃一个前端会话对应的 ACP 会话，并连带清掉它的用量统计。
 *
 * 两处调用（删会话 / 改工作目录）都必须把用量一起清零：ACP 会话被丢弃后
 * 下一轮会用新 cwd 重开会话，智能体侧上下文是真的归零了，
 * 界面上继续挂着旧占用率就是在撒谎。
 */
function dropHermesSession(sessionId: string): void {
  const acpId = hermesSessions.get(sessionId)
  if (acpId) hermesManager.clearUsage(acpId)
  hermesSessions.delete(sessionId)
  usageBySession.delete(sessionId)
  mainWindow?.webContents.send('usage:update', { sessionId, usage: null })
}

/**
 * 会话的产出目录（P0-2）：自定义 workDir 优先，没有回退内置工作区。
 * 必须与 knowledge:candidates 的取目录口径一致，否则自定义目录会话的新产出全漏采。
 */
function getSessionOutputDir(sessionId?: string): string {
  const workDir = storageManager.getSessionById(sessionId || '')?.workDir || hermesManager.getWorkspacePath()
  return path.join(workDir, 'output')
}

/** P1-1：任务窗口起点（打快照时）注册，采集最后一趟跑完后注销 */
function registerHarvestTask(dir: string, taskId: string): void {
  if (!dir || !taskId) return
  let set = harvestTasksByDir.get(dir)
  if (!set) {
    set = new Set()
    harvestTasksByDir.set(dir, set)
  }
  set.add(taskId)
}

/** P1-1：注销采集任务（最后一趟跑完 / 任务出错提前收摊时调用），空集合顺手删键防泄漏 */
function unregisterHarvestTask(dir: string, taskId: string): void {
  const set = harvestTasksByDir.get(dir)
  if (!set) return
  set.delete(taskId)
  if (set.size === 0) harvestTasksByDir.delete(dir)
}

/** P1-1：同目录是否还有「别的」任务在采集窗口内 —— 有就不能采，新文件可能属于别的意图 */
function hasOtherHarvestTask(dir: string, taskId: string): boolean {
  const set = harvestTasksByDir.get(dir)
  if (!set) return false
  for (const id of set) {
    if (id !== taskId) return true
  }
  return false
}

/**
 * P2 第 6C 步：采纳信号自动采集（设计 §7 信号③）。
 * 任务完成后把 output 目录里「本次新产出」的 xlsx 抽骨架交给 formatStore.addInstance——
 * 同族聚合、useCount++、累计升格全由 store 负责。两趟扫描（t+3s 主扫、t+30s 兜底晚落盘的文件），
 * 快照在 harvest 内部回写，第二趟不会重复计数。后台增强，任何失败只记日志。
 *
 * dir 由调用方按会话 workDir 解析后传入（P0-2）；taskId 用于并发任务互斥（P1-1）。
 */
function scheduleFormatHarvest(prepared: ReturnType<IntentRouter['prepare']>, snapshot: OutputSnapshot, dir: string) {
  if (!formatStore || !prepared.intent) return
  const taskId = prepared.taskId
  const ctx = {
    intentId: prepared.intent.id,
    intentLabel: prepared.intent.labels?.[0],
    workflow: prepared.intent.workflow
  }
  const run = async (tag: string, isLast: boolean) => {
    try {
      // P1-1：并发任务共用同一 output 目录时，快照 diff 无法区分新文件归属哪个意图，
      // 错采会把 B 任务的产出挂到 A 的 intentId 上 —— 宁可不采，不可错采。
      if (hasOtherHarvestTask(dir, taskId)) {
        logManager.warn('[格式信号采集] 多个任务共用输出目录，为避免跨意图误归属，本次跳过')
        return
      }
      const report = await harvestNewXlsx(formatStore!, dir, snapshot, ctx)
      if (report.harvested > 0) {
        const detail = report.outcomes
          .map(o => `${path.basename(o.filePath)}→${o.action}${o.promotedTo ? `（升格为${o.promotedTo}）` : ''}`)
          .join('、')
        logManager.info(`[格式信号采集:${tag}] 新产出 ${report.harvested} 个 xlsx：${detail}`)
      }
    } catch (err: any) {
      logManager.warn(`[格式信号采集:${tag}] 失败（不影响主流程）：${err?.message || err}`)
    } finally {
      // 最后一趟（t+30s）跑完即注销本任务；跳过/失败也要注销，否则会把同目录后续采集永久卡死
      if (isLast) unregisterHarvestTask(dir, taskId)
    }
  }
  setTimeout(() => { void run('t+3s', false) }, 3_000)
  setTimeout(() => { void run('t+30s', true) }, 30_000)
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

  ipcMain.handle('session:create', async (_event, name?: string, workDir?: string) => {
    // 区分"显式传目录"和"没传"：弹窗一定会传字符串（空串=内置工作区），
    // 而 /new 斜杠命令这类隐式建会话传的是 undefined。两者语义不同：
    //   显式 → 用它，并写进偏好（last/recent）；
    //   隐式 → 沿用上次用过的目录，且绝不回写偏好——否则一次 /new 就会把
    //           last 冲成空串，用户下次开弹窗发现"沿用上次"退回了内置工作区。
    const explicit = typeof workDir === 'string'
    const wanted = explicit ? workDir : storageManager.getWorkDirPrefs().last
    const check = validateWorkDir(wanted || '')
    // 目录非法时不阻断建会话：退回内置工作区，用户随后可在会话上改。
    // 直接抛错会让"新建会话"这个基础动作因为一个可恢复的选择失败。
    const dir = check.ok ? check.path : ''
    if (!check.ok) logManager?.warn(`新建会话的工作目录无效（已回退内置工作区）: ${check.error}`)
    const session = storageManager.createSession(name, dir)
    // 空串也要写进 last，"默认沿用上次"在用户特意选内置工作区时才成立
    if (explicit) storageManager.pushRecentWorkDir(dir)
    return session
  })

  /**
   * 改会话工作目录。必须同时丢掉 hermesSessions 里的 ACP 会话映射：
   * cwd 是 session/new 的入参，已建立的 ACP 会话改不了 cwd，
   * 下一轮对话会用新目录重开一个会话——代价是智能体侧上下文归零
   * （前端聊天记录不受影响），所以 UI 上必须做二次确认。
   */
  ipcMain.handle('session:setWorkDir', async (_event, sessionId: string, workDir: string) => {
    const check = validateWorkDir(workDir || '')
    if (!check.ok) return { success: false, error: check.error }
    if (!storageManager.setSessionWorkDir(sessionId, check.path)) {
      return { success: false, error: '会话不存在' }
    }
    dropHermesSession(sessionId)
    storageManager.pushRecentWorkDir(check.path)
    logManager?.info(`会话 ${sessionId} 工作目录已切换为: ${check.path || '内置工作区'}`)
    return { success: true, workDir: check.path }
  })

  ipcMain.handle('session:delete', async (_event, sessionId: string) => {
    dropHermesSession(sessionId)
    return storageManager.deleteSession(sessionId)
  })

  /**
   * 取某会话的上下文占用/缓存用量快照。
   * 推送（usage:update）只在变化时发，渲染进程挂载和切会话时得主动拉一次，
   * 否则切回一个老会话会看到空白，直到下一轮对话结束才恢复。
   */
  ipcMain.handle('usage:get', async (_event, sessionId: string) => {
    return usageBySession.get(sessionId) || null
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
    // P1 perf：首 chunk 延迟埋点（从 IPC 起算 → 模型首 token 抵达）
    const tIpcStart = Date.now()
    let firstChunkLogged = false

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
        (error: string) => send({ type: 'error', data: friendlyModelError(error) }),
        () => send({ type: 'done' }),
        channel,
        images
      ).catch((err: any) => {
        send({ type: 'error', data: friendlyModelError(err.message || '多模态模型调用失败') })
      })
      return { channel }
    }

    // P0 隐形内核：路由业务意图，装配 skill/工作流/输出契约，原文照存照显
    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // P2 第 6 步：把"本次实际套用了哪个格式模板"推给前端，让 ChatArea 显示套用提示条
    if (prepared.formatApplied) {
      mainWindow?.webContents.send('format:applied', {
        sessionId: sessionId || '',
        formatApplied: prepared.formatApplied
      })
    }

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
        // 即时错误走返回值带回（事件通道存在订阅竞态，会丢）
        return { channel, error }
      }
      // 图片/视频为异步生成类接口：用非流式调用，完成后一次性回传结果
      const result = await modelRouter.callModel(taskModel, message, storageManager.getConfig())
      if (result.success) {
        intentRouter.recordEnd(prepared.taskId, 'done')
        send({ type: 'chunk', data: result.content || '' })
        send({ type: 'done' })
      } else {
        intentRouter.recordEnd(prepared.taskId, 'error', result.error)
        send({ type: 'error', data: friendlyModelError(result.error || '模型调用失败') })
      }
      return { channel }
    }

    // 发送前检查：用输入框中选中的模型，未选择/没 Key 时明确提示
    const modelIssue = dialogueModelIssue()
    if (modelIssue) {
      intentRouter.recordEnd(prepared.taskId, 'error', modelIssue)
      // 即时错误走返回值带回（事件通道存在订阅竞态，会丢）
      return { channel, error: modelIssue }
    }

    const sessionResult = await ensureHermesSession(sessionId)
    if ('error' in sessionResult) {
      intentRouter.recordEnd(prepared.taskId, 'error', sessionResult.error)
      return { channel, error: sessionResult.error }
    }

    // P2 6C：发任务前快照 output，任务完成后 diff 出新产出 xlsx 做信号采集。
    // 目录按会话 workDir 解析（P0-2：自定义目录会话不再漏采）；
    // 任务窗口起点注册采集任务（P1-1：并发任务共用目录时互斥，防止跨意图误归属）
    const outputDir = getSessionOutputDir(sessionId)
    const formatSnap = snapshotOutputDir(outputDir)
    registerHarvestTask(outputDir, prepared.taskId)

    hermesManager.sendPrompt(prepared.prompt, sessionResult.sessionId, {
      onText: (text: string) => {
        if (!firstChunkLogged) {
          firstChunkLogged = true
          logManager.info(`[perf] chat:stream 首 chunk 延迟 ${Date.now() - tIpcStart}ms（从 IPC 起到首个 token）`)
        }
        send({ type: 'chunk', data: text })
      },
      onThinking: (text: string) => send({ type: 'thinking', data: text }),
      onDone: () => {
        intentRouter.recordEnd(prepared.taskId, 'done')
        scheduleFormatHarvest(prepared, formatSnap, outputDir)
        send({ type: 'done' })
      },
      onError: (error: string) => {
        intentRouter.recordEnd(prepared.taskId, 'error', error)
        // 任务出错不采集，采集任务注册要就地撤掉（P1-1），否则会卡住同目录后续采集
        unregisterHarvestTask(outputDir, prepared.taskId)
        send({ type: 'error', data: friendlyModelError(error) })
      }
    }).catch((err: any) => {
      intentRouter.recordEnd(prepared.taskId, 'error', err.message)
      unregisterHarvestTask(outputDir, prepared.taskId)
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
        : { success: false, error: friendlyModelError(result.error || '多模态模型调用失败') }
    }

    const prepared = intentRouter.prepare(message, intentMeta, sessionId)

    // P2 第 6 步：把"本次实际套用了哪个格式模板"推给前端，让 ChatArea 显示套用提示条
    if (prepared.formatApplied) {
      mainWindow?.webContents.send('format:applied', {
        sessionId: sessionId || '',
        formatApplied: prepared.formatApplied
      })
    }

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
        : { success: false, error: friendlyModelError(result.error || '模型调用失败') }
    }

    // 发送前检查（与流式一致）：未选择/没 Key 时明确提示
    const modelIssue = dialogueModelIssue()
    if (modelIssue) {
      intentRouter.recordEnd(prepared.taskId, 'error', modelIssue)
      return { success: false, error: modelIssue }
    }

    const sessionResult = await ensureHermesSession(sessionId)
    if ('error' in sessionResult) {
      intentRouter.recordEnd(prepared.taskId, 'error', sessionResult.error)
      return { success: false, error: sessionResult.error }
    }

    // P2 6C：发任务前快照 output，任务完成后 diff 出新产出 xlsx 做信号采集。
    // 目录按会话 workDir 解析（P0-2：自定义目录会话不再漏采）；
    // 任务窗口起点注册采集任务（P1-1：并发任务共用目录时互斥，防止跨意图误归属）
    const outputDir = getSessionOutputDir(sessionId)
    const formatSnap = snapshotOutputDir(outputDir)
    registerHarvestTask(outputDir, prepared.taskId)

    return new Promise((resolve) => {
      let full = ''
      hermesManager.sendPrompt(prepared.prompt, sessionResult.sessionId, {
        onText: (text: string) => { full += text },
        onThinking: () => {},
        onDone: () => {
          intentRouter.recordEnd(prepared.taskId, 'done')
          scheduleFormatHarvest(prepared, formatSnap, outputDir)
          resolve({ success: true, content: full })
        },
        onError: (error: string) => {
          intentRouter.recordEnd(prepared.taskId, 'error', error)
          // 任务出错不采集，采集任务注册要就地撤掉（P1-1），否则会卡住同目录后续采集
          unregisterHarvestTask(outputDir, prepared.taskId)
          resolve({ success: false, error: friendlyModelError(error) })
        }
      }).catch((err: any) => {
        intentRouter.recordEnd(prepared.taskId, 'error', err.message)
        unregisterHarvestTask(outputDir, prepared.taskId)
        resolve({ success: false, error: friendlyModelError(err.message) })
      })
    })
  })

  // 停止生成
  // 支持 per-session：传入 sessionId 时只取消该会话的后台流式 + Hermes 回合，
  // 不影响其他正在生成的会话；不传则保持旧行为（全局停止，兼容旧调用方）。
  ipcMain.handle('chat:stop', async (_event, sessionId?: string) => {
    if (sessionId) {
      hermesManager.cancelSession(sessionId).catch(() => {})
      modelRouter.abortBySessionId(sessionId)
    } else {
      modelRouter.abortAll()
      hermesManager.stopGeneration().catch(() => {})
    }
    return true
  })

  // 发送斜杠命令（/stop、/new、/help 等），不打断当前流式回复
  ipcMain.handle('chat:command', async (_event, command: string, sessionId: string) => {
    try {
      const sessionResult = await ensureHermesSession(sessionId)
      if ('error' in sessionResult) {
        return { success: false, error: sessionResult.error }
      }
      await hermesManager.sendCommand(command, sessionResult.sessionId)
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
    const result = storageManager.setConfig(key, value)
    // 模型配置、输入框选择或权限模式变化时，同步重写 Hermes config.yaml
    // （approvals 块随权限模式变化，热缓存保存即生效）
    if (key === 'modelConfig' || key === 'selectedModels' || key === 'permissionMode') {
      const cfg: any = storageManager.getConfig() || {}
      const allModels: any[] = []
      for (const type of ['dialogue', 'image', 'video', 'multimodal']) {
        if (Array.isArray(cfg.modelConfig?.[type])) {
          allModels.push(...cfg.modelConfig[type])
        }
      }
      hermesManager.writeHermesConfig(
        allModels,
        undefined,
        undefined,
        cfg.permissionMode || 'ask',
        cfg.selectedModels?.dialogue
      )
      // 权限模式变化时重启智能体进程：清掉遗留的会话级批准，
      // 并让新的 approvals 配置与进程级权限提示词立即完整生效
      // （下一条消息会自动拉起新进程）
      if (key === 'permissionMode') {
        hermesManager.restartAgent().catch(() => {})
      }
    }
    return result
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

  // ============ 格式模板库（P2 结构复用） ============
  // 处理器逻辑在 format-handlers.ts（不依赖 electron，可单测）；这里只做注册。
  // format:candidates 需要扫 workspace/output 找候选 xlsx，所以把输出目录注进去。
  if (formatStore) {
    registerFormatIpc(formatStore, {
      getWorkspaceOutputDir: () => path.join(hermesManager.getWorkspacePath(), 'output'),
      dialogs: {
        saveJson: async (defaultPath: string) => {
          const r = await dialog.showSaveDialog(mainWindow!, {
            title: '导出「我的格式」',
            defaultPath,
            filters: [{ name: 'JSON 文件', extensions: ['json'] }]
          })
          return r.canceled ? null : (r.filePath || null)
        },
        openJson: async () => {
          const r = await dialog.showOpenDialog(mainWindow!, {
            title: '导入「我的格式」',
            properties: ['openFile'],
            filters: [{ name: 'JSON 文件', extensions: ['json'] }]
          })
          return (r.canceled || r.filePaths.length === 0) ? null : r.filePaths[0]
        }
      }
    })
  }

  // ============ 定时任务/提醒模块 ============
  ipcMain.handle('schedule:list', async () => {
    return storageManager.getScheduledTasks()
  })

  ipcMain.handle('schedule:create', async (_event, task: any) => {
    const dueAt = task?.dueAt ? new Date(task.dueAt).toISOString() : new Date().toISOString()
    const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(task?.repeat) ? task.repeat : 'none'
    const kind = task?.kind === 'task' ? 'task' : 'reminder'
    const title = String(task?.title || '').trim()
    const content = String(task?.content || '').trim()
    const sessionId = String(task?.sessionId || '') || storageManager.getSessions()[0]?.id || ''
    if (!title) return { success: false, error: '请填写标题' }
    if (!sessionId) return { success: false, error: '请选择目标会话' }
    return { success: true, task: storageManager.createScheduledTask({
      title,
      content,
      dueAt,
      repeat,
      kind,
      sessionId,
      enabled: true,
      lastFiredAt: null
    }) }
  })

  ipcMain.handle('schedule:update', async (_event, id: string, updates: any) => {
    if (!id) return { success: false, error: '缺少任务 ID' }
    const clean: any = { ...updates }
    if (clean.dueAt) clean.dueAt = new Date(clean.dueAt).toISOString()
    return { success: storageManager.updateScheduledTask(id, clean) }
  })

  ipcMain.handle('schedule:delete', async (_event, id: string) => {
    return { success: storageManager.deleteScheduledTask(id) }
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

  // ============ 企业文档资产模块 ============
  ipcMain.handle('knowledge:list', async () => {
    return knowledgeManager.list()
  })

  // 列某会话产出目录里的候选文件（采纳弹窗勾选用）
  ipcMain.handle('knowledge:candidates', async (_event, sessionId?: string) => {
    const workDir = storageManager.getSessionById(sessionId || '')?.workDir || hermesManager.getWorkspacePath()
    return knowledgeManager.candidates(workDir)
  })

  ipcMain.handle('knowledge:add', async (_event, filePath: string, sessionId?: string) => {
    return knowledgeManager.add(filePath, sessionId)
  })

  ipcMain.handle('knowledge:remove', async (_event, id: string) => {
    return knowledgeManager.remove(id)
  })

  // ============ 工作目录模块 ============
  // 会话工作目录 = 智能体的 cwd。这里只负责"选目录 / 给候选 / 打开目录"，
  // 真正生效在 session:create 与 session:setWorkDir。
  ipcMain.handle('workdir:info', async () => {
    // recent / last 里的目录可能已被删除或移走，先过滤再给前端，
    // 否则快选列表全是死路径，且"默认沿用上次"会直接选中一个不存在的目录
    const isDir = (p: string) => {
      try { return !!p && fs.statSync(p).isDirectory() } catch { return false }
    }
    const prefs = storageManager.getWorkDirPrefs()
    return {
      defaultPath: hermesManager.getWorkspacePath(),
      last: isDir(prefs.last) ? prefs.last : '',
      recent: prefs.recent.filter(isDir)
    }
  })

  ipcMain.handle('workdir:pick', async (_event, current?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择该会话的工作目录',
      // createDirectory 只在 macOS 生效，Windows 的对话框自带"新建文件夹"
      properties: ['openDirectory', 'createDirectory'],
      ...(current && fs.existsSync(current) ? { defaultPath: current } : {})
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false }
    const check = validateWorkDir(result.filePaths[0])
    if (!check.ok) return { success: false, error: check.error }
    return { success: true, path: check.path }
  })

  // 「在文件管理器中打开」防连点：同一路径短时间内只开一个窗口，
  // 避免连续点击堆出一排资源管理器窗口
  let lastReveal: { path: string; at: number } | null = null

  /**
   * Windows：枚举已打开的资源管理器窗口，同文件夹已开窗则置前激活该窗口，
   * 没有才新开。explorer.exe / shell.openPath 都会无条件叠开新窗口（实测），
   * 只能走 Shell.Application COM + SetForegroundWindow。
   *
   * 脚本必须落盘后用 -File 执行：-Command 内嵌 C# 里的双引号会被 Windows
   * 命令行转义弄坏，PowerShell 直接退出码 1（实测）。
   */
  const revealInExplorer = (target: string): Promise<{ success: boolean; error?: string }> => {
    // PowerShell 单引号字符串：路径里的单引号翻倍转义
    const winPath = target.replace(/'/g, "''")
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$targetPath = '${winPath}'`,
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Activate { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'",
      '$sh = New-Object -ComObject Shell.Application',
      '$found = $null',
      'foreach ($w in $sh.Windows()) { try { if ($w.Document.Folder.Self.Path -ieq $targetPath) { $found = $w; break } } catch { } }',
      'if ($found -ne $null) { [Win32Activate]::ShowWindow([IntPtr]$found.HWND, 9) | Out-Null; [Win32Activate]::SetForegroundWindow([IntPtr]$found.HWND) | Out-Null }',
      'else { Start-Process explorer.exe -ArgumentList $targetPath }'
    ].join('\n')
    const psFile = path.join(app.getPath('temp'), `hermes-reveal-${process.pid}.ps1`)
    try {
      fs.writeFileSync(psFile, script, 'utf-8')
    } catch (err: any) {
      return Promise.resolve({ success: false, error: `临时脚本写入失败：${err?.message}` })
    }
    return new Promise(resolve => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
        stdio: 'ignore',
        windowsHide: true
      })
      proc.once('error', err => resolve({ success: false, error: err.message }))
      proc.once('exit', code => {
        fs.unlink(psFile, () => {})
        resolve({ success: code === 0 })
      })
    })
  }

  ipcMain.handle('workdir:reveal', async (_event, dir?: string) => {
    const target = (dir || '').trim() || hermesManager.getWorkspacePath()
    const now = Date.now()
    // 3 秒内同一路径重复请求直接跳过：窗口已经打开，再开就是重复窗口
    const key = path.resolve(target).toLowerCase()
    if (lastReveal && lastReveal.path === key && now - lastReveal.at < 3000) {
      return { success: true }
    }
    lastReveal = { path: key, at: now }

    // Windows：先找已开窗的同路径窗口激活，没有才新开
    if (process.platform === 'win32') {
      return await revealInExplorer(target)
    }

    // macOS 用 AppleScript 让 Finder 聚焦已有窗口：同文件夹已开窗则置前激活，
    // 没有才新开（shell.openPath 每次都开新窗口）。
    if (process.platform === 'darwin') {
      const safePath = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = `tell application "Finder"
  set targetFolder to POSIX file "${safePath}"
  set found to false
  repeat with w in windows
    try
      if (target of w as text) is (targetFolder as text) then
        set found to true
        set index of w to 1
      end if
    end try
  end repeat
  if not found then open targetFolder
  activate
end tell`
      return new Promise(resolve => {
        const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' })
        proc.once('error', err => resolve({ success: false, error: err.message }))
        proc.once('exit', code => resolve({ success: code === 0 }))
      })
    }

    // 其他平台继续用 shell.openPath
    const err = await shell.openPath(target)
    return { success: !err, error: err || undefined }
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
    // 通知 ChatArea 收起兜底横幅。无论上面是否 resolve 到（已被超时自动拒绝）都要推，
    // 否则横幅会一直挂着等一个永远不会再来的信号。
    mainWindow?.webContents.send('permission:resolved', { requestId })
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
  if (formatDecayTimer) {
    clearInterval(formatDecayTimer)
    formatDecayTimer = null
  }
  channelManager?.stopAll().finally(() => hermesManager?.stop())
})

