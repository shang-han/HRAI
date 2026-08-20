import { create } from 'zustand'

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

interface ConfigState {
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
  loaded: boolean

  // Actions
  setTheme: (theme: 'light' | 'dark') => void
  setModelConfig: (type: string, providers: ModelProvider[]) => void
  setShortcut: (key: string, value: string) => void
  toggleSidebar: () => void
  setInputMode: (mode: 'single' | 'multi') => void
  loadConfig: () => Promise<void>
}

// 预设模型列表（apiKey/enabled 由 defaultModelConfig 填充）
const MODEL_PRESETS: Array<Omit<ModelProvider, 'apiKey' | 'enabled'>> = [
  // 对话模型
  { id: 'deepseek-chat', name: 'DeepSeek', provider: 'DeepSeek', type: 'dialogue', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', modelName: 'deepseek-chat', params: { temperature: 0.7, max_tokens: 65536 } },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'DeepSeek', type: 'dialogue', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', modelName: 'deepseek-reasoner', params: { temperature: 0.7, max_tokens: 65536 } },
  { id: 'qwen-turbo', name: '通义千问 Turbo', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', modelName: 'qwen-turbo', params: { temperature: 0.7 } },
  { id: 'qwen-plus', name: '通义千问 Plus', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', modelName: 'qwen-plus', params: { temperature: 0.7 } },
  { id: 'qwen-max', name: '通义千问 Max', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', modelName: 'qwen-max', params: { temperature: 0.7 } },
  { id: 'glm-4', name: '智谱 GLM-4', provider: '智谱', type: 'dialogue', apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', modelName: 'glm-4', params: { temperature: 0.7 } },
  // 图片模型
  { id: 'wanx-v1', name: '通义万相', provider: '阿里云', type: 'image', apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', modelName: 'wanx-v1', params: { size: '1024*1024' } },
  { id: 'dall-e-3', name: 'DALL-E 3', provider: 'OpenAI', type: 'image', apiEndpoint: 'https://api.openai.com/v1/images/generations', modelName: 'dall-e-3', params: { size: '1024x1024' } },
  // 多模态模型
  { id: 'qwen-vl-max', name: 'Qwen-VL Max', provider: '阿里云', type: 'multimodal', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', modelName: 'qwen-vl-max', params: {} },
  { id: 'deepseek-chat-vl', name: 'DeepSeek VL2', provider: 'DeepSeek', type: 'multimodal', apiEndpoint: 'https://api.deepseek.com/chat/completions', modelName: 'deepseek-chat', params: {} },
  // 视频模型
  { id: 'kling-v1', name: '可灵', provider: '快手', type: 'video', apiEndpoint: 'https://api.klingai.com/v1/videos/text2video', modelName: 'kling-v1', params: { duration: 10 } },
]

// 默认启用的模型（每个类型一个）
const defaultModelConfig = {
  dialogue: MODEL_PRESETS.filter(p => p.type === 'dialogue').map((p, i) => ({ ...p, apiKey: '', enabled: p.id === 'deepseek-chat', isPrimary: i === 0 })),
  image: MODEL_PRESETS.filter(p => p.type === 'image').map(p => ({ ...p, apiKey: '', enabled: true })),
  video: MODEL_PRESETS.filter(p => p.type === 'video').map(p => ({ ...p, apiKey: '', enabled: false })),
  multimodal: MODEL_PRESETS.filter(p => p.type === 'multimodal').map(p => ({ ...p, apiKey: '', enabled: true })),
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  theme: 'light',
  modelConfig: defaultModelConfig,
  shortcuts: {},
  layout: {
    sidebarCollapsed: false,
    inputMode: 'single'
  },
  loaded: false,

  setTheme: async (theme) => {
    set({ theme })
    await window.electronAPI.config.set('theme', theme)
  },

  setModelConfig: async (type, providers) => {
    const config = get().modelConfig
    const newConfig = { ...config, [type]: providers }
    set({ modelConfig: newConfig })
    await window.electronAPI.config.set('modelConfig', newConfig)
  },

  setShortcut: async (key, value) => {
    const shortcuts = { ...get().shortcuts, [key]: value }
    set({ shortcuts })
    await window.electronAPI.config.set('shortcuts', shortcuts)
  },

  toggleSidebar: async () => {
    const collapsed = !get().layout.sidebarCollapsed
    set({ layout: { ...get().layout, sidebarCollapsed: collapsed } })
    await window.electronAPI.config.set('layout', { ...get().layout, sidebarCollapsed: collapsed })
  },

  setInputMode: async (mode) => {
    set({ layout: { ...get().layout, inputMode: mode } })
    await window.electronAPI.config.set('layout', { ...get().layout, inputMode: mode })
  },

  loadConfig: async () => {
    try {
      const config = await window.electronAPI.config.get()
      set({
        theme: config.theme || 'light',
        modelConfig: config.modelConfig || get().modelConfig,
        shortcuts: config.shortcuts || {},
        layout: config.layout || get().layout,
        loaded: true
      })
    } catch (err) {
      console.error('加载配置失败:', err)
      set({ loaded: true })
    }
  }
}))
