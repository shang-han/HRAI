import { contextBridge, ipcRenderer } from 'electron'

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
    create: (name?: string) => ipcRenderer.invoke('session:create', name),
    delete: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
    switch: (sessionId: string) => ipcRenderer.invoke('session:switch', sessionId),
    rename: (sessionId: string, name: string) => ipcRenderer.invoke('session:rename', sessionId, name),
    getMessages: (sessionId: string) => ipcRenderer.invoke('session:getMessages', sessionId),
    saveMessage: (sessionId: string, message: any) => ipcRenderer.invoke('session:saveMessage', sessionId, message),
  },

  // 聊天模块
  chat: {
    send: (message: string, sessionId: string, modelOverride?: string, intent?: any) =>
      ipcRenderer.invoke('chat:send', message, sessionId, modelOverride, intent),
    stream: (message: string, sessionId: string, modelOverride?: string, intent?: any) =>
      ipcRenderer.invoke('chat:stream', message, sessionId, modelOverride, intent),
    stop: () => ipcRenderer.invoke('chat:stop'),
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

  // 文件模块
  file: {
    export: (format: string, content: any, filePath?: string) =>
      ipcRenderer.invoke('file:export', format, content, filePath),
    import: () => ipcRenderer.invoke('file:import'),
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
    create: (name?: string) => Promise<any>
    delete: (sessionId: string) => Promise<any>
    switch: (sessionId: string) => Promise<any>
    rename: (sessionId: string, name: string) => Promise<any>
    getMessages: (sessionId: string) => Promise<any>
    saveMessage: (sessionId: string, message: any) => Promise<any>
  }
  chat: {
    send: (message: string, sessionId: string, modelOverride?: string, intent?: any) => Promise<any>
    stream: (message: string, sessionId: string, modelOverride?: string, intent?: any) => Promise<any>
    stop: () => Promise<any>
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
  file: {
    export: (format: string, content: any, filePath?: string) => Promise<any>
    import: () => Promise<any>
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
