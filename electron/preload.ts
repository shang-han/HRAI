import { contextBridge, ipcRenderer } from 'electron'
// 仅类型导入：编译期被完全擦除，不会把主进程的 hermes-manager 打进 preload 包，
// 用量结构因此只有一份定义（渲染侧的 src/global.d.ts 是另一套项目，只能手抄）。
import type { SessionUsage } from './hermes-manager'

// 暴露安全的 IPC 接口给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 激活模块
  activation: {
    activate: (code: string) => ipcRenderer.invoke('activation:activate', code),
    validate: () => ipcRenderer.invoke('activation:validate'),
    status: () => ipcRenderer.invoke('activation:status'),
  },

  // 会话模块
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    create: (name?: string, workDir?: string) => ipcRenderer.invoke('session:create', name, workDir),
    setWorkDir: (sessionId: string, workDir: string) => ipcRenderer.invoke('session:setWorkDir', sessionId, workDir),
    delete: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
    switch: (sessionId: string) => ipcRenderer.invoke('session:switch', sessionId),
    rename: (sessionId: string, name: string) => ipcRenderer.invoke('session:rename', sessionId, name),
    getMessages: (sessionId: string) => ipcRenderer.invoke('session:getMessages', sessionId),
    saveMessage: (sessionId: string, message: any) => ipcRenderer.invoke('session:saveMessage', sessionId, message),
    setWorkPriority: (sessionId: string, data: { title: string; background: string; targetAudience: string; scenario: string }) =>
      ipcRenderer.invoke('session:setWorkPriority', sessionId, data),
    restoreWorkPriority: (sessionId: string, historyIndex: number) =>
      ipcRenderer.invoke('session:restoreWorkPriority', sessionId, historyIndex),
    clearWorkPriority: (sessionId: string) =>
      ipcRenderer.invoke('session:clearWorkPriority', sessionId),
    deleteWorkPriorityHistory: (sessionId: string, historyIndex: number) =>
      ipcRenderer.invoke('session:deleteWorkPriorityHistory', sessionId, historyIndex),
  },

  // 聊天模块
  chat: {
    send: (message: string, sessionId: string, modelOverride?: string, images?: string[], intent?: any) =>
      ipcRenderer.invoke('chat:send', message, sessionId, modelOverride, images, intent),
    stream: (message: string, sessionId: string, modelOverride?: string, images?: string[], intent?: any) =>
      ipcRenderer.invoke('chat:stream', message, sessionId, modelOverride, images, intent),
    stop: (sessionId?: string) => ipcRenderer.invoke('chat:stop', sessionId),
    command: (command: string, sessionId: string) =>
      ipcRenderer.invoke('chat:command', command, sessionId),
    onStreamData: (channel: string, callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
  },

  // 模型模块
  model: {
    test: (provider: any) => ipcRenderer.invoke('model:test', provider),
    list: (provider: any) => ipcRenderer.invoke('model:list', provider),
  },

  // 配置模块
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
  },

  // 模板模块
  template: {
    list: () => ipcRenderer.invoke('template:list'),
    create: (template: any) => ipcRenderer.invoke('template:create', template),
    update: (id: string, template: any) => ipcRenderer.invoke('template:update', id, template),
    delete: (id: string) => ipcRenderer.invoke('template:delete', id),
    import: (filePath: string) => ipcRenderer.invoke('template:import', filePath),
    export: (filePath: string) => ipcRenderer.invoke('template:export', filePath),
  },

  // 格式模板库（P2 结构复用：用户惯用 xlsx 格式）
  // 删除=归档（不物理删），导入冲突自动并存改名（不静默覆盖）—— 这两条由 store 保证
  format: {
    list: (includeArchived?: boolean) =>
      ipcRenderer.invoke('format:list', includeArchived ? { includeArchived } : undefined),
    get: (id: string) => ipcRenderer.invoke('format:get', id),
    preview: (id: string) => ipcRenderer.invoke('format:preview', id),
    candidates: (dir?: string) => ipcRenderer.invoke('format:candidates', dir ? { dir } : undefined),
    extract: (filePath: string) => ipcRenderer.invoke('format:extract', { filePath }),
    save: (input: any) => ipcRenderer.invoke('format:save', input),
    update: (id: string, patch: any) => ipcRenderer.invoke('format:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('format:delete', id),
    reject: (id: string) => ipcRenderer.invoke('format:reject', id),
    // P1-2 隐式接受：套用后未拒绝且继续发消息时由前端触发（acceptCount++，可升 active）
    accept: (id: string) => ipcRenderer.invoke('format:accept', id),
    exportAll: () => ipcRenderer.invoke('format:exportAll'),
    importAll: () => ipcRenderer.invoke('format:importAll'),
    // P2 第 6 步：主进程在 prepare() 命中格式时推一次，ChatArea 据此显示套用提示条
    onApplied: (callback: (payload: any) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('format:applied', listener)
      return () => ipcRenderer.removeListener('format:applied', listener)
    }
  },

  // 定时任务/提醒模块
  schedule: {
    list: () => ipcRenderer.invoke('schedule:list'),
    create: (task: any) => ipcRenderer.invoke('schedule:create', task),
    update: (id: string, updates: any) => ipcRenderer.invoke('schedule:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('schedule:delete', id),
    onFired: (callback: (task: any) => void) => {
      const listener = (_event: any, task: any) => callback(task)
      ipcRenderer.on('schedule:fired', listener)
      return () => ipcRenderer.removeListener('schedule:fired', listener)
    },
  },

  // 文件模块
  file: {
    export: (format: string, content: any, filePath?: string) =>
      ipcRenderer.invoke('file:export', format, content, filePath),
    import: () => ipcRenderer.invoke('file:import'),
  },

  // 企业文档资产模块（用户确认的产出文件 -> AI 可检索引用的知识资产）
  knowledge: {
    list: () => ipcRenderer.invoke('knowledge:list'),
    candidates: (sessionId?: string) => ipcRenderer.invoke('knowledge:candidates', sessionId),
    add: (filePath: string, sessionId?: string) => ipcRenderer.invoke('knowledge:add', filePath, sessionId),
    remove: (id: string) => ipcRenderer.invoke('knowledge:remove', id),
  },

  // 会话工作目录模块
  workdir: {
    info: () => ipcRenderer.invoke('workdir:info'),
    pick: (current?: string) => ipcRenderer.invoke('workdir:pick', current),
    reveal: (dir?: string) => ipcRenderer.invoke('workdir:reveal', dir),
  },

  // 上下文占用 / 提示词缓存用量
  usage: {
    get: (sessionId: string) => ipcRenderer.invoke('usage:get', sessionId),
    onUpdate: (callback: (payload: { sessionId: string; usage: any }) => void) => {
      const listener = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('usage:update', listener)
      return () => ipcRenderer.removeListener('usage:update', listener)
    },
  },

  // 公告模块
  announcement: {
    check: () => ipcRenderer.invoke('announcement:check'),
    markRead: () => ipcRenderer.invoke('announcement:markRead'),
  },

  // 系统模块
  system: {
    networkStatus: () => ipcRenderer.invoke('system:networkStatus'),
    fingerprint: () => ipcRenderer.invoke('system:fingerprint'),
  },

  // Hermes 状态
  hermes: {
    status: () => ipcRenderer.invoke('hermes:status'),
    healthCheck: () => ipcRenderer.invoke('hermes:healthCheck'),
    commands: () => ipcRenderer.invoke('hermes:commands'),
  },

  // 日志模块
  log: {
    getLevel: () => ipcRenderer.invoke('log:getLevel'),
    setLevel: (level: string) => ipcRenderer.invoke('log:setLevel', level),
  },

  // 企业画像模块
  company: {
    status: () => ipcRenderer.invoke('company:status'),
    saveAnswers: (answers: Record<string, string>) => ipcRenderer.invoke('company:saveAnswers', answers),
  },

  // 渠道接入模块
  channel: {
    status: () => ipcRenderer.invoke('channel:status'),
    config: () => ipcRenderer.invoke('channel:config'),
    save: (channel: string, config: any) => ipcRenderer.invoke('channel:save', channel, config),
    scanBegin: (channel: string) => ipcRenderer.invoke('channel:scanBegin', channel),
    scanPoll: (channel: string, session: string) => ipcRenderer.invoke('channel:scanPoll', channel, session),
    onTranscript: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('channel:transcript', listener)
      return () => ipcRenderer.removeListener('channel:transcript', listener)
    },
  },

  // 在线升级模块
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: (filePath: string, updateType: string) => ipcRenderer.invoke('update:install', filePath, updateType),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    onProgress: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('update:progress', listener)
      return () => ipcRenderer.removeListener('update:progress', listener)
    },
  },

  // 权限审批模块
  permission: {
    onRequest: (callback: (data: any) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('permission:request', listener)
      return () => ipcRenderer.removeListener('permission:request', listener)
    },
    // 审批结束（用户点了允许/拒绝，或主进程超时自动拒绝）时推一次，供 ChatArea 收起兜底横幅。
    // ipcRenderer.on 支持多个监听者，TopBar 已有的 onRequest 订阅不受影响。
    onResolved: (callback: (data: { requestId: number }) => void) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('permission:resolved', listener)
      return () => ipcRenderer.removeListener('permission:resolved', listener)
    },
    respond: (requestId: number, allow: boolean) => ipcRenderer.invoke('permission:respond', requestId, allow),
  },

  // 应用生命周期模块
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    // 自绘标题栏窗口控制（minimize / toggleMaximize / close 由主进程执行）
    minimize: () => ipcRenderer.invoke('app:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('app:toggleMaximize'),
    close: () => ipcRenderer.invoke('app:close'),
    openDevTools: () => ipcRenderer.invoke('app:openDevTools'),
    zoom: (dir: 'in' | 'out' | 'reset') => ipcRenderer.invoke('app:zoom', dir),
    about: () => ipcRenderer.invoke('app:about'),
    isMaximized: () => ipcRenderer.invoke('app:isMaximized'),
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const listener = (_event: any, maximized: boolean) => callback(maximized)
      ipcRenderer.on('app:maximizedChanged', listener)
      return () => ipcRenderer.removeListener('app:maximizedChanged', listener)
    },
    version: () => ipcRenderer.invoke('app:version'),
  },
})

// TypeScript 类型声明
export interface ElectronAPI {
  activation: {
    activate: (code: string) => Promise<any>
    validate: () => Promise<any>
    status: () => Promise<any>
  }
  session: {
    list: () => Promise<any>
    create: (name?: string, workDir?: string) => Promise<any>
    setWorkDir: (sessionId: string, workDir: string) => Promise<any>
    delete: (sessionId: string) => Promise<any>
    switch: (sessionId: string) => Promise<any>
    rename: (sessionId: string, name: string) => Promise<any>
    getMessages: (sessionId: string) => Promise<any>
    saveMessage: (sessionId: string, message: any) => Promise<any>
    setWorkPriority: (sessionId: string, data: { title: string; background: string; targetAudience: string; scenario: string }) => Promise<any>
    restoreWorkPriority: (sessionId: string, historyIndex: number) => Promise<boolean>
    clearWorkPriority: (sessionId: string) => Promise<boolean>
    deleteWorkPriorityHistory: (sessionId: string, historyIndex: number) => Promise<boolean>
  }
  chat: {
    send: (message: string, sessionId: string, modelOverride?: string, intent?: any) => Promise<any>
    stream: (message: string, sessionId: string, modelOverride?: string, intent?: any) => Promise<any>
    stop: (sessionId?: string) => Promise<any>
    command: (command: string, sessionId: string) => Promise<any>
    onStreamData: (channel: string, callback: (data: any) => void) => () => void
  }
  model: {
    test: (provider: any) => Promise<any>
    list: (provider: any) => Promise<any>
  }
  config: {
    get: () => Promise<any>
    set: (key: string, value: any) => Promise<any>
  }
  template: {
    list: () => Promise<any>
    create: (template: any) => Promise<any>
    update: (id: string, template: any) => Promise<any>
    delete: (id: string) => Promise<any>
    import: (filePath: string) => Promise<any>
    export: (filePath: string) => Promise<any>
  }
  format: {
    list: (includeArchived?: boolean) => Promise<any[]>
    get: (id: string) => Promise<any>
    preview: (id: string) => Promise<any>
    candidates: (dir?: string) => Promise<any[]>
    extract: (filePath: string) => Promise<any>
    save: (input: any) => Promise<any>
    update: (id: string, patch: any) => Promise<any>
    delete: (id: string) => Promise<any>
    reject: (id: string) => Promise<any>
    accept: (id: string) => Promise<any>
    exportAll: () => Promise<any>
    importAll: () => Promise<any>
    onApplied: (callback: (payload: { sessionId: string; formatApplied: any }) => void) => () => void
  }
  schedule: {
    list: () => Promise<any[]>
    create: (task: any) => Promise<any>
    update: (id: string, updates: any) => Promise<any>
    delete: (id: string) => Promise<any>
    onFired: (callback: (task: any) => void) => () => void
  }
  file: {
    export: (format: string, content: any, filePath?: string) => Promise<any>
    import: () => Promise<any>
  }
  workdir: {
    info: () => Promise<any>
    pick: (current?: string) => Promise<any>
    reveal: (dir?: string) => Promise<any>
  }
  usage: {
    get: (sessionId: string) => Promise<SessionUsage | null>
    onUpdate: (callback: (payload: { sessionId: string; usage: SessionUsage | null }) => void) => () => void
  }
  announcement: {
    check: () => Promise<any>
    markRead: () => Promise<any>
  }
  system: {
    networkStatus: () => Promise<any>
    fingerprint: () => Promise<any>
  }
  hermes: {
    status: () => Promise<any>
    healthCheck: () => Promise<any>
    commands: () => Promise<any[]>
  }
  log: {
    getLevel: () => Promise<any>
    setLevel: (level: string) => Promise<any>
  }
  app: {
    quit: () => Promise<any>
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    openDevTools: () => Promise<void>
    zoom: (dir: 'in' | 'out' | 'reset') => Promise<void>
    about: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
    version: () => Promise<string>
  }
  update: {
    check: () => Promise<any>
    download: () => Promise<any>
    install: (filePath: string, updateType: string) => Promise<any>
    cancel: () => Promise<any>
    onProgress: (callback: (data: any) => void) => () => void
  }
  permission: {
    onRequest: (callback: (data: any) => void) => () => void
    onResolved: (callback: (data: { requestId: number }) => void) => () => void
    respond: (requestId: number, allow: boolean) => Promise<any>
  }
  company: {
    status: () => Promise<any>
    saveAnswers: (answers: Record<string, string>) => Promise<any>
  }
  channel: {
    status: () => Promise<any>
    config: () => Promise<any>
    save: (channel: string, config: any) => Promise<any>
    scanBegin: (channel: string) => Promise<any>
    scanPoll: (channel: string, session: string) => Promise<any>
    onTranscript: (callback: (data: any) => void) => () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
