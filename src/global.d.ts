// Electron API 类型声明（渲染进程使用）
export {}

/**
 * 上下文占用 / 提示词缓存用量（结构与 electron/hermes-manager.ts 的 SessionUsage 一致）。
 * 渲染侧和 electron 侧是两个 tsconfig 项目，这里只能手抄一份；
 * 改字段时两边必须一起改。
 */
export interface SessionUsage {
  /** 模型上下文窗口（token）。0 = 内核还没报过 */
  size: number
  /** 当前请求预估占用（token） */
  used: number
  /** 最近一轮真实用量；input 已含缓存命中部分 */
  lastTurn: { input: number; output: number; total: number; cachedRead: number; thought: number } | null
  totalInput: number
  totalCachedRead: number
  /** 是否真的命中过缓存（>0）。为 false 时不能断言"线路不支持"，只能说没命中 */
  cacheObserved: boolean
  turns: number
  updatedAt: number
}

declare global {
  interface Window {
    electronAPI: {
      activation: {
        activate: (code: string) => Promise<{ success: boolean; message: string }>
        validate: () => Promise<{ valid: boolean; message: string }>
        status: () => Promise<{ activated: boolean; message: string; license?: any }>
      }
      session: {
        list: () => Promise<Array<{
          id: string; name: string; createdAt: string; updatedAt: string;
          messageCount: number; workPriority?: any; workDir?: string
        }>>
        create: (name?: string, workDir?: string) => Promise<{ id: string; name: string; createdAt: string }>
        setWorkDir: (sessionId: string, workDir: string) =>
          Promise<{ success: boolean; workDir?: string; error?: string }>
        delete: (sessionId: string) => Promise<boolean>
        switch: (sessionId: string) => Promise<boolean>
        rename: (sessionId: string, name: string) => Promise<boolean>
        getMessages: (sessionId: string) => Promise<Array<{
          id: string; role: 'user' | 'assistant' | 'system';
          content: string; timestamp: string; model?: string; images?: string[]
        }>>
        saveMessage: (sessionId: string, message: any) => Promise<boolean>
        setWorkPriority: (sessionId: string, data: { title: string; background: string; targetAudience: string; scenario: string }) => Promise<any>
        restoreWorkPriority: (sessionId: string, historyIndex: number) => Promise<boolean>
        clearWorkPriority: (sessionId: string) => Promise<boolean>
        deleteWorkPriorityHistory: (sessionId: string, historyIndex: number) => Promise<boolean>
      }
      chat: {
        send: (message: string, sessionId: string, modelOverride?: string, images?: string[], intent?: { hint?: string; id?: string }) =>
          Promise<{ success: boolean; content?: string; error?: string }>
        stream: (message: string, sessionId: string, modelOverride?: string, images?: string[], intent?: { hint?: string; id?: string }) =>
          Promise<{ channel: string }>
        stop: (sessionId?: string) => Promise<boolean>
        command: (command: string, sessionId: string) =>
          Promise<{ success: boolean; error?: string }>
        onStreamData: (channel: string, callback: (data: { type: 'chunk' | 'done' | 'error'; data?: string }) => void) =>
          () => void
      }
      model: {
        test: (provider: any) => Promise<{ success: boolean; message: string }>
        list: (provider: any) => Promise<{ success: boolean; models?: string[]; message?: string }>
      }
      config: {
        get: () => Promise<any>
        set: (key: string, value: any) => Promise<boolean>
      }
      template: {
        list: () => Promise<any[]>
        create: (template: any) => Promise<any>
        update: (id: string, template: any) => Promise<boolean>
        delete: (id: string) => Promise<boolean>
        import: (filePath: string) => Promise<{ success: boolean; templates?: any[]; error?: string }>
        export: (filePath: string) => Promise<{ success: boolean; error?: string }>
      }
      // 格式模板库（P2 结构复用）。删除=归档，导入冲突并存改名
      format: {
        list: (includeArchived?: boolean) => Promise<any[]>
        get: (id: string) => Promise<any>
        preview: (id: string) => Promise<any>
        candidates: (dir?: string) => Promise<Array<{ filePath: string; fileName: string; skeleton: any }>>
        extract: (filePath: string) => Promise<{ ok: boolean; reason?: string; skeleton?: any }>
        save: (input: any) => Promise<any>
        update: (id: string, patch: any) => Promise<any>
        delete: (id: string) => Promise<boolean>
        reject: (id: string) => Promise<any>
        /** P1-2 隐式接受：套用后未拒绝且继续发消息时触发（acceptCount++，可升 active） */
        accept: (id: string) => Promise<any>
        // 用户取消弹框时返回 { success: false }，因此这里是可辨识联合
        exportAll: () => Promise<{ success: boolean; count?: number; message?: string }>
        importAll: () => Promise<
          { success: false; message: string } |
          { imported: number; skipped: number; renamed: Array<{ id: string; name: string }>; overwritten: string[]; conflicts: any[]; unresolved: string[]; errors: string[] }
        >
        /** P2 第 6 步：主进程 prepare() 命中格式时推送一次 */
        onApplied: (callback: (payload: FormatAppliedPayload) => void) => () => void
      }
      schedule: {
        list: () => Promise<Array<{ id: string; title: string; content: string; dueAt: string; repeat: 'none' | 'daily' | 'weekly' | 'monthly'; kind: 'reminder' | 'task'; sessionId: string; enabled: boolean; lastFiredAt?: string | null; createdAt: string }>>
        create: (task: { title: string; content?: string; dueAt?: string; repeat?: 'none' | 'daily' | 'weekly' | 'monthly'; kind?: 'reminder' | 'task'; sessionId?: string }) => Promise<{ success: boolean; task?: any; error?: string }>
        update: (id: string, updates: any) => Promise<{ success: boolean }>
        delete: (id: string) => Promise<{ success: boolean }>
        onFired: (callback: (task: any) => void) => () => void
      }
      file: {
        export: (format: string, content: any, filePath?: string) => Promise<{ success: boolean; message?: string; error?: string }>
        import: () => Promise<{ success: boolean; content?: string; type?: string; error?: string }>
      }
      workdir: {
        /** defaultPath=内置工作区绝对路径；last=上次使用（空串=内置）；recent=快选历史（均已过滤失效目录） */
        info: () => Promise<{ defaultPath: string; last: string; recent: string[] }>
        pick: (current?: string) => Promise<{ success: boolean; path?: string; error?: string }>
        reveal: (dir?: string) => Promise<{ success: boolean; error?: string }>
      }
      usage: {
        /** 挂载/切会话时主动拉一次；没有数据（会话还没对话过）返回 null */
        get: (sessionId: string) => Promise<SessionUsage | null>
        /** usage 为 null 表示该会话的智能体上下文已被丢弃（删会话/改工作目录） */
        onUpdate: (callback: (payload: { sessionId: string; usage: SessionUsage | null }) => void) => () => void
      }
      knowledge: {
        list: () => Promise<Array<{
          id: string
          fileName: string
          ext: string
          size: number
          mtime: number
          sessionId?: string
          addedAt: string
          title: string
          keywords: string[]
          totalChars: number
        }>>
        /** 列出会话产出目录 output/ 下的候选文件（返回按修改时间倒序） */
        candidates: (sessionId?: string) => Promise<Array<{ path: string; fileName: string; ext: string; size: number; mtime: number }>>
        add: (filePath: string, sessionId?: string) => Promise<{ success: boolean; asset?: any; error?: string }>
        remove: (id: string) => Promise<{ success: boolean }>
      }
      announcement: {
        check: () => Promise<{ hasNew: boolean; content: string }>
        markRead: () => Promise<void>
      }
      system: {
        networkStatus: () => Promise<{ online: boolean }>
        fingerprint: () => Promise<string>
      }
      hermes: {
        status: () => Promise<{ isRunning: boolean; port: number; pid: number | null }>
        healthCheck: () => Promise<boolean>
        commands: () => Promise<Array<{ name: string; description?: string; input_hint?: string }>>
      }
      log: {
        getLevel: () => Promise<string>
        setLevel: (level: string) => Promise<void>
      }
      app: {
        quit: () => Promise<{ confirmed: boolean }>
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
      permission: {
        onRequest: (callback: (data: { requestId: number; title: string; command: string; description: string }) => void) => () => void
        /** 审批结束（用户点了允许/拒绝，或主进程超时自动拒绝）时推一次 */
        onResolved: (callback: (data: { requestId: number }) => void) => () => void
        respond: (requestId: number, allow: boolean) => Promise<boolean>
      }
      update: {
        check: () => Promise<{ hasUpdate: boolean; latestVersion: string; currentVersion: string; releaseNotes: string; downloadUrl: string; fileName: string; size: number; publishedAt: string; updateType: 'incremental' | 'full'; deltaUrl: string; deltaFileName: string; deltaSize: number }>
        download: () => Promise<{ filePath: string; updateType: 'incremental' | 'full' }>
        install: (filePath: string, updateType: 'incremental' | 'full') => Promise<void>
        cancel: () => Promise<boolean>
        onProgress: (callback: (data: { total: number; downloaded: number; percent: number; filePath: string }) => void) => () => void
      }
      company: {
        status: () => Promise<{ completed: boolean; profile?: any; knowledge?: any }>
        saveAnswers: (answers: Record<string, string>) => Promise<{ success: boolean }>
      }
      channel: {
        status: () => Promise<Array<{ id: string; label: string; enabled: boolean; state: string; detail: string }>>
        config: () => Promise<any>
        save: (channel: string, config: any) => Promise<{ success: boolean; message?: string }>
        scanBegin: (channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu') => Promise<{ status: string; qrUrl?: string; qrDataUrl?: string; session?: string; interval?: number; error?: string }>
        scanPoll: (channel: 'weixin' | 'wecom' | 'dingtalk' | 'feishu', session: string) => Promise<any>
        onTranscript: (callback: (data: { sessionId: string; channel: string; chatId: string; messages: Array<{ id: string; role: string; content: string; timestamp: string }> }) => void) => () => void
      }
    }
  }

  /** P2 第 6 步：format:applied 推送载荷 —— 本次装配实际套用的格式模板 */
  interface FormatAppliedPayload {
    sessionId: string
    formatApplied: {
      id: string
      name: string
      lifecycle: string
      intentId?: string
      /** 主表字段名，供展开预览 */
      columns: string[]
    }
  }
}
