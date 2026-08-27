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
  /** 输入框下拉的选择（每类一个模型 id），独立于配置页"默认"（isPrimary） */
  selectedModels: Partial<Record<'dialogue' | 'image' | 'video' | 'multimodal', string>>
  shortcuts: Record<string, string>
  layout: {
    sidebarCollapsed: boolean
    /** 侧边栏展开时的宽度（px），用户拖拽调整后持久化 */
    sidebarWidth: number
    inputMode: 'single' | 'multi'
  }
  loaded: boolean

  // Actions
  setTheme: (theme: 'light' | 'dark') => void
  setModelConfig: (type: string, providers: ModelProvider[]) => void
  setSelectedModel: (type: string, id: string) => void
  setShortcut: (key: string, value: string) => void
  toggleSidebar: () => void
  /**
   * 设置侧边栏宽度。
   * persist=false（默认）只更新内存：拖动过程中每帧都会调，
   * 若每次都写配置文件，一次拖动就是上百次 IPC + 磁盘写。
   * 松手时再用 persist=true 落盘一次。
   */
  setSidebarWidth: (width: number, persist?: boolean) => void
  setInputMode: (mode: 'single' | 'multi') => void
  loadConfig: () => Promise<void>
}

/* 侧边栏宽度区间。
   下限 240：再窄业务导航三级条目（pl-8 缩进 + 右侧箭头）就只剩几个字，没法用。
   上限 560：更宽纯属浪费，且拖动时还会再受窗口宽度约束（见 Sidebar.startResizeWidth）。 */
export const SIDEBAR_MIN_W = 240
export const SIDEBAR_MAX_W = 560
export const SIDEBAR_DEFAULT_W = 340
/** 收起态宽度，与展开态共用同一个 inline width 以便 CSS 过渡能插值 */
export const SIDEBAR_COLLAPSED_W = 48

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
  selectedModels: {},
  shortcuts: {},
  layout: {
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT_W,
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

  // 输入框选择模型：只更新 selectedModels，不回写模型配置的"默认"（isPrimary）
  setSelectedModel: async (type, id) => {
    const selectedModels = { ...get().selectedModels, [type]: id }
    set({ selectedModels })
    await window.electronAPI.config.set('selectedModels', selectedModels)
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

  setSidebarWidth: async (width, persist = false) => {
    const layout = { ...get().layout, sidebarWidth: width }
    set({ layout })
    if (persist) await window.electronAPI.config.set('layout', layout)
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
        selectedModels: config.selectedModels || {},
        shortcuts: config.shortcuts || {},
        // layout 必须与默认值逐字段合并，不能整体替换：
        // 老版本持久化下来的 layout 里没有 sidebarWidth，整体替换会让它变成
        // undefined，侧边栏宽度直接塌掉。以后往 layout 加字段同理。
        layout: { ...get().layout, ...(config.layout || {}) },
        loaded: true
      })
    } catch (err) {
      console.error('加载配置失败:', err)
      set({ loaded: true })
    }
  }
}))
