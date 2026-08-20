// Electron API 类型声明（渲染进程使用）
export {}

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
          messageCount: number; workPriority?: any
        }>>
        create: (name?: string) => Promise<{ id: string; name: string; createdAt: string }>
        delete: (sessionId: string) => Promise<boolean>
        switch: (sessionId: string) => Promise<boolean>
        rename: (sessionId: string, name: string) => Promise<boolean>
        getMessages: (sessionId: string) => Promise<Array<{
          id: string; role: 'user' | 'assistant' | 'system';
          content: string; timestamp: string; model?: string; images?: string[]
        }>>
        saveMessage: (sessionId: string, message: any) => Promise<boolean>
      }
      chat: {
        send: (message: string, sessionId: string, modelOverride?: string, intent?: { hint?: string; id?: string }) =>
          Promise<{ success: boolean; content?: string; error?: string }>
        stream: (message: string, sessionId: string, modelOverride?: string, intent?: { hint?: string; id?: string }) =>
          Promise<{ channel: string }>
        stop: () => Promise<boolean>
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
      file: {
        export: (format: string, content: any, filePath?: string) => Promise<{ success: boolean; message?: string; error?: string }>
        import: () => Promise<{ success: boolean; content?: string; type?: string; error?: string }>
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
      }
      permission: {
        onRequest: (callback: (data: { requestId: number; title: string; command: string; description: string }) => void) => () => void
        respond: (requestId: number, allow: boolean) => Promise<boolean>
      }
      update: {
        check: () => Promise<{ hasUpdate: boolean; latestVersion: string; currentVersion: string; releaseNotes: string; downloadUrl: string; fileName: string; size: number; publishedAt: string }>
        download: () => Promise<string>
        install: (filePath: string) => Promise<void>
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
}
