import React, { useEffect, useRef, useState } from 'react'
import { useConfigStore } from '../store/configStore'
import { useSessionStore } from '../store/sessionStore'
import { App as AntApp, Button, Tooltip, Badge, Modal, Drawer, Tabs, Form, Input, Switch, Select, Alert, Card, Radio, Space, Tag, InputNumber, Slider, Popconfirm, Empty, Divider } from 'antd'
import {
  SettingOutlined,
  MoonOutlined,
  SunOutlined,
  BellOutlined,
  ApiOutlined,
  LinkOutlined,
  QuestionCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ThunderboltOutlined,
  PlusOutlined,
  DeleteOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  StarFilled
} from '@ant-design/icons'

type ModelType = 'dialogue' | 'image' | 'video' | 'multimodal'

interface ModelProvider {
  id: string
  name: string
  provider?: string
  type: ModelType
  apiEndpoint: string
  apiKey: string
  modelName: string
  params: Record<string, any>
  enabled: boolean
  isPrimary?: boolean
}

const TYPE_LABELS: Record<ModelType, string> = {
  dialogue: '对话模型',
  image: '图片模型',
  video: '视频模型',
  multimodal: '多模态模型'
}

// 预设模型
const MODEL_PRESETS: ModelProvider[] = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek', type: 'dialogue', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: '', modelName: 'deepseek-chat', params: { temperature: 0.7, max_tokens: 65536 }, enabled: true },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'DeepSeek', type: 'dialogue', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: '', modelName: 'deepseek-reasoner', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'qwen-turbo', name: '通义千问 Turbo', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '', modelName: 'qwen-turbo', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'qwen-plus', name: '通义千问 Plus', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '', modelName: 'qwen-plus', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'qwen-max', name: '通义千问 Max', provider: '阿里云', type: 'dialogue', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '', modelName: 'qwen-max', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'glm-4', name: '智谱 GLM-4', provider: '智谱 AI', type: 'dialogue', apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: '', modelName: 'glm-4', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'OpenAI', type: 'dialogue', apiEndpoint: 'https://api.openai.com/v1/chat/completions', apiKey: '', modelName: 'gpt-4o-mini', params: { temperature: 0.7, max_tokens: 65536 }, enabled: false },
  { id: 'wanx-v1', name: '通义万相', provider: '阿里云', type: 'image', apiEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', apiKey: '', modelName: 'wanx-v1', params: { size: '1024*1024' }, enabled: true },
  { id: 'dall-e-3', name: 'DALL-E 3', provider: 'OpenAI', type: 'image', apiEndpoint: 'https://api.openai.com/v1/images/generations', apiKey: '', modelName: 'dall-e-3', params: { size: '1024x1024' }, enabled: false },
  { id: 'qwen-vl-max', name: 'Qwen-VL Max', provider: '阿里云', type: 'multimodal', apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '', modelName: 'qwen-vl-max', params: { temperature: 0.7 }, enabled: true },
  { id: 'glm-4v', name: 'GLM-4V', provider: '智谱 AI', type: 'multimodal', apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: '', modelName: 'glm-4v', params: { temperature: 0.7 }, enabled: false },
  { id: 'kling-v1', name: '可灵', provider: '快手', type: 'video', apiEndpoint: 'https://api.klingai.com/v1/videos/text2video', apiKey: '', modelName: 'kling-v1', params: { duration: 10 }, enabled: false },
]

const TopBar: React.FC = () => {
  const { theme, setTheme, modelConfig, setModelConfig, layout, toggleSidebar } = useConfigStore()
  const { sessions, activeSessionId } = useSessionStore()
  const { message } = AntApp.useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelConfigOpen, setModelConfigOpen] = useState(false)
  const [channelConfigOpen, setChannelConfigOpen] = useState(false)
  const [announcementOpen, setAnnouncementOpen] = useState(false)
  const [announcementContent, setAnnouncementContent] = useState('')
  const [hasNewAnnouncement, setHasNewAnnouncement] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto' | 'readonly'>('ask')
  const [permissionRequest, setPermissionRequest] = useState<any>(null)
  const [updateOwner, setUpdateOwner] = useState('')
  const [updateRepo, setUpdateRepo] = useState('')
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [updateProgress, setUpdateProgress] = useState<any>(null)
  const [updateModalOpen, setUpdateModalOpen] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  const activeSession = sessions.find(s => s.id === activeSessionId)

  useEffect(() => {
    checkAnnouncement()
    // 读取当前权限模式
    window.electronAPI.config.get().then((cfg: any) => {
      if (cfg?.permissionMode) setPermissionMode(cfg.permissionMode)
      if (cfg?.update) {
        setUpdateOwner(cfg.update.owner || '')
        setUpdateRepo(cfg.update.repo || '')
      }
    }).catch(() => {})

    // 监听 Hermes ACP 审批请求（仅 ask 模式会收到）
    const offPermission = window.electronAPI.permission.onRequest((data) => {
      setPermissionRequest(data)
    })
    // 监听更新下载进度
    const offUpdate = window.electronAPI.update.onProgress((data) => setUpdateProgress(data))
    return () => { offPermission(); offUpdate() }
  }, [])

  const checkAnnouncement = async () => {
    try {
      const result = await window.electronAPI.announcement.check()
      setHasNewAnnouncement(result.hasNew)
      setAnnouncementContent(result.content)
      if (result.hasNew && result.content) {
        setAnnouncementOpen(true)
      }
    } catch { /* ignore */ }
  }

  const handleCheckUpdate = async () => {
    setUpdateBusy(true)
    try {
      const info = await window.electronAPI.update.check()
      setUpdateInfo(info)
      setUpdateModalOpen(true)
    } catch (err: any) {
      message.error(err?.message || '检查更新失败')
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleDownloadUpdate = async () => {
    setUpdateBusy(true)
    setUpdateProgress(null)
    try {
      const result = await window.electronAPI.update.download()
      setUpdateInfo((prev: any) => ({ ...prev, downloadedPath: result.filePath, updateType: result.updateType }))
      message.success(result.updateType === 'incremental' ? '增量更新包下载完成' : '全量更新包下载完成')
    } catch (err: any) {
      message.error(err?.message || '下载失败')
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleInstallUpdate = async () => {
    if (!updateInfo?.downloadedPath) return
    setUpdateBusy(true)
    try {
      await window.electronAPI.update.install(updateInfo.downloadedPath, updateInfo.updateType || 'full')
      setUpdateModalOpen(false)
      message.success('已打开安装程序，请按提示完成升级')
    } catch (err: any) {
      message.error(err?.message || '打开安装包失败')
    } finally {
      setUpdateBusy(false)
    }
  }

  // 启动时：读取版本号，并后台静默检查更新
  useEffect(() => {
    let mounted = true
    window.electronAPI.app.version().then(v => {
      if (mounted) setAppVersion(v)
    }).catch(() => {})

    window.electronAPI.update.check().then(info => {
      if (mounted && info?.hasUpdate && info?.downloadUrl) {
        setUpdateInfo(info)
        setUpdateModalOpen(true)
      }
    }).catch(() => {
      // 静默检查失败不打扰用户
    })
    return () => { mounted = false }
  }, [])

  const handleThemeToggle = () => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  const handleAnnouncementRead = () => {
    setAnnouncementOpen(false)
    setHasNewAnnouncement(false)
    window.electronAPI.announcement.markRead()
  }

  return (
    <>
      <div className="h-12 flex items-center justify-between px-4 bg-surface">
        <div className="flex gap-3 items-center">
          <button onClick={toggleSidebar} className="md:hidden p-1">
            {layout.sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
          <span className="text-sm text-inkSecondary">
            当前会话：
            <strong className="text-ink">{activeSession?.name || '无'}</strong>
          </span>
        </div>
        <div className="flex gap-2 items-center">
          <Tooltip title="模型配置">
            <Button size="small" icon={<ApiOutlined />} onClick={() => setModelConfigOpen(true)}>
              模型
            </Button>
          </Tooltip>
          <Tooltip title="渠道接入">
            <Button size="small" icon={<LinkOutlined />} onClick={() => setChannelConfigOpen(true)}>
              渠道
            </Button>
          </Tooltip>
          <Tooltip title="系统设置">
            <Button size="small" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              设置
            </Button>
          </Tooltip>
          <Tooltip title="使用帮助">
            <Button size="small" icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)} />
          </Tooltip>
          <Badge dot={hasNewAnnouncement} offset={[-4, 4]}>
            <Tooltip title="系统公告">
              <Button size="small" icon={<BellOutlined />} onClick={() => { setAnnouncementOpen(true); handleAnnouncementRead() }} />
            </Tooltip>
          </Badge>
          <Tooltip title={theme === 'light' ? '切换深色模式' : '切换浅色模式'}>
            <Button size="small" icon={theme === 'light' ? <MoonOutlined /> : <SunOutlined />} onClick={handleThemeToggle} />
          </Tooltip>
        </div>
      </div>

      {/* 模型配置抽屉 */}
      <Drawer title="模型接入配置" open={modelConfigOpen} onClose={() => setModelConfigOpen(false)} width={720}>
        <Tabs items={[
          { key: 'dialogue', label: '对话模型', children: <ModelConfigSection type="dialogue" providers={modelConfig.dialogue} onSave={(p) => setModelConfig('dialogue', p)} /> },
          { key: 'image', label: '图片模型', children: <ModelConfigSection type="image" providers={modelConfig.image} onSave={(p) => setModelConfig('image', p)} /> },
          { key: 'video', label: '视频模型', children: <ModelConfigSection type="video" providers={modelConfig.video} onSave={(p) => setModelConfig('video', p)} /> },
          { key: 'multimodal', label: '多模态模型', children: <ModelConfigSection type="multimodal" providers={modelConfig.multimodal} onSave={(p) => setModelConfig('multimodal', p)} /> },
        ]} />
      </Drawer>

      {/* 渠道接入抽屉 */}
      <Drawer title="渠道接入设置" open={channelConfigOpen} onClose={() => setChannelConfigOpen(false)} width={560}>
        <Tabs items={[
          { key: 'weixin', label: '个人微信', children: <ChannelConfigSection channel="weixin" /> },
          { key: 'wecom', label: '企业微信', children: <ChannelConfigSection channel="wecom" /> },
          { key: 'dingtalk', label: '钉钉', children: <ChannelConfigSection channel="dingtalk" /> },
          { key: 'feishu', label: '飞书', children: <ChannelConfigSection channel="feishu" /> },
        ]} />
      </Drawer>

      {/* 系统设置抽屉 */}
      <Drawer title="系统设置" open={settingsOpen} onClose={() => setSettingsOpen(false)} width={500}>
        <div className="space-y-4">
          <div>
            <h3 className="font-medium mb-2">日志级别</h3>
            <Select defaultValue="info" style={{ width: 200 }} onChange={(v) => window.electronAPI.log.setLevel(v)}>
              <Select.Option value="debug">DEBUG</Select.Option>
              <Select.Option value="info">INFO</Select.Option>
              <Select.Option value="warn">WARN</Select.Option>
              <Select.Option value="error">ERROR</Select.Option>
            </Select>
          </div>
          <Divider />
          <div>
            <h3 className="font-medium mb-2">Gitee 在线升级 {appVersion && <span className="text-xs text-gray-400">当前版本 v{appVersion}</span>}</h3>
            <div className="space-y-2 mb-2">
              <Input size="small" value={updateOwner} placeholder="Gitee 用户名/组织名（owner）" onChange={e => setUpdateOwner(e.target.value)} />
              <Input size="small" value={updateRepo} placeholder="仓库名（repo），例如 HRAI" onChange={e => setUpdateRepo(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="small" onClick={() => {
                window.electronAPI.config.set('update', { owner: updateOwner.trim(), repo: updateRepo.trim() })
                message.success('Gitee 仓库配置已保存')
              }}>保存仓库配置</Button>
              <Button size="small" type="primary" ghost onClick={handleCheckUpdate}>检查更新</Button>
            </div>
          </div>
          <Divider />
          <div>
            <h3 className="font-medium mb-2">权限模式（Codex 风格）</h3>
            <Radio.Group
              value={permissionMode}
              onChange={e => {
                const value = e.target.value as 'ask' | 'auto' | 'readonly'
                setPermissionMode(value)
                window.electronAPI.config.set('permissionMode', value).catch(() => {})
              }}
            >
              <Radio.Button value="ask">审批模式</Radio.Button>
              <Radio.Button value="auto">完全放开</Radio.Button>
              <Radio.Button value="readonly">只读保护</Radio.Button>
            </Radio.Group>
            <div className="text-xs text-gray-500 mt-2 space-y-1">
              <p>· 审批模式：删除、覆写、执行命令等高风险操作前弹窗确认（推荐）</p>
              <p>· 完全放开：所有操作自动允许，不再询问</p>
              <p>· 只读保护：拒绝所有写/删/执行类权限请求，仅允许读取</p>
            </div>
          </div>
          <Divider />
          <div>
            <h3 className="font-medium mb-2 text-red-500">退出程序</h3>
            <p className="text-xs text-inkMuted mb-3">
              关闭窗口只会将程序最小化到系统托盘并保持服务运行。退出将停止 Hermes 服务与全部渠道 Bot。
            </p>
            <Button
              danger
              block
              onClick={() => window.electronAPI.app.quit()}
            >
              退出并停止服务
            </Button>
          </div>
        </div>
      </Drawer>

      {/* Gitee 在线升级弹窗 */}
      <Modal
        title="在线升级"
        open={updateModalOpen}
        onCancel={() => setUpdateModalOpen(false)}
        footer={[
          <Button key="close" onClick={() => setUpdateModalOpen(false)}>关闭</Button>,
          updateInfo?.hasUpdate && !updateInfo?.downloadedPath ? (
            <Button key="download" type="primary" loading={updateBusy} onClick={handleDownloadUpdate}>
              {updateProgress ? `下载中 ${updateProgress.percent}%` : '下载更新'}
            </Button>
          ) : null,
          updateInfo?.downloadedPath ? (
            <Button key="install" type="primary" danger loading={updateBusy} onClick={handleInstallUpdate}>安装更新</Button>
          ) : null
        ].filter(Boolean)}
      >
        {updateInfo ? (
          <div className="space-y-3">
            <p>当前版本：<strong>{updateInfo.currentVersion}</strong></p>
            <p>最新版本：<strong>{updateInfo.hasUpdate ? updateInfo.latestVersion : '已是最新'}</strong></p>
            {updateInfo.hasUpdate && (
              <p>更新策略：<strong>{updateInfo.updateType === 'incremental' ? '增量更新（小改动）' : '全量更新（大改动）'}</strong></p>
            )}
            {updateInfo.hasUpdate && updateInfo.releaseNotes && (
              <div className="text-xs text-inkMuted whitespace-pre-wrap max-h-40 overflow-auto bg-canvas p-2 rounded">
                {updateInfo.releaseNotes}
              </div>
            )}
            {updateProgress && !updateInfo.downloadedPath && (
              <div className="text-xs text-blue-600">
                已下载 {Math.round((updateProgress.downloaded || 0) / 1024 / 1024)}MB
                {updateProgress.total ? ` / ${Math.round(updateProgress.total / 1024 / 1024)}MB` : ''}
              </div>
            )}
          </div>
        ) : <p>正在检查…</p>}
      </Modal>

      {/* Hermes 权限审批弹窗 */}
      <Modal
        title="Hermes 请求执行权限"
        open={!!permissionRequest}
        onOk={() => {
          if (permissionRequest) window.electronAPI.permission.respond(permissionRequest.requestId, true)
          setPermissionRequest(null)
        }}
        onCancel={() => {
          if (permissionRequest) window.electronAPI.permission.respond(permissionRequest.requestId, false)
          setPermissionRequest(null)
        }}
        okText="允许一次"
        cancelText="拒绝"
        okButtonProps={{ danger: true }}
      >
        <p className="text-sm text-gray-700 dark:text-gray-200 font-medium mb-2">
          {permissionRequest?.title || '高风险操作'}
        </p>
        <div className="text-xs text-gray-500 mb-2">{permissionRequest?.description}</div>
        {permissionRequest?.command && (
          <div className="rounded bg-surfaceSubtle dark:bg-canvas border border-line p-3 font-mono text-xs break-all whitespace-pre-wrap">
            {permissionRequest.command}
          </div>
        )}
      </Modal>

      {/* 公告弹窗 */}
      <Modal title="系统公告" open={announcementOpen} onOk={() => setAnnouncementOpen(false)} onCancel={() => setAnnouncementOpen(false)} footer={null}>
        <div className="whitespace-pre-wrap text-sm">{announcementContent || '暂无公告'}</div>
      </Modal>

      {/* 帮助抽屉 */}
      <Drawer title="使用帮助" open={helpOpen} onClose={() => setHelpOpen(false)} width={600}>
        <Tabs items={[
          { key: 'quickstart', label: '新手指南', children: (
            <div className="space-y-3 text-sm">
              <p>1. 点击右上角"模型"按钮，选择一个对话模型并填写 API Key（支持 DeepSeek、通义千问、智谱等），点击"测试"验证连接</p>
              <p>2. 勾选"设为默认"，保存后即可开始对话</p>
              <p>3. 点击左侧业务菜单中的功能，自动填充专业 Prompt 到输入框</p>
              <p>4. 生成的内容可以直接导出为 Word、Excel、PPT 等格式</p>
            </div>
          )},
          { key: 'models', label: '模型配置指南', children: <p className="text-sm">在"模型"抽屉中：① 从预设列表添加模型 → ② 填写 API Key → ③ 点击"测试连接"验证 → ④ 启用并设为默认 → ⑤ 保存。所有配置仅保存在本地。</p> },
          { key: 'channels', label: '渠道接入说明', children: <p className="text-sm">支持企业微信、钉钉、飞书、个人微信接入。在"渠道接入设置"中配置对应平台参数。</p> },
          { key: 'export', label: '导出技巧', children: <p className="text-sm">在对话中输入"导出为Word/Excel/PPT"即可触发文件导出。建议在指令中明确要求结构化输出以获得更好的排版效果。</p> },
          { key: 'security', label: '安全说明', children: <p className="text-sm">所有数据（API Key、聊天记录、企业文档）均保存在本地，不会上传至任何外部服务器。</p> },
          { key: 'shortcuts', label: '快捷键', children: (
            <div className="text-sm space-y-1">
              <p>Enter — 发送（单行模式）</p>
              <p>Shift + Enter — 换行（单行模式）</p>
              <p>Ctrl + Enter — 发送（多行模式）</p>
              <p>Ctrl + B — 切换侧边栏</p>
              <p>Ctrl + N — 新建会话</p>
            </div>
          )},
        ]} />
      </Drawer>
    </>
  )
}

// ==================== 模型配置子组件 ====================

const ModelConfigSection: React.FC<{ type: ModelType; providers: ModelProvider[]; onSave: (providers: ModelProvider[]) => void }> = ({ type, providers, onSave }) => {
  const { message } = AntApp.useApp()
  const [items, setItems] = useState<ModelProvider[]>([])
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; text: string }>>({})
  const [modelLists, setModelLists] = useState<Record<string, string[]>>({})
  const [loadingListId, setLoadingListId] = useState<string | null>(null)
  const [selectedModels, setSelectedModels] = useState<Record<string, string[]>>({})

  useEffect(() => {
    setItems(providers)
    setTestResults({})
  }, [providers])

  const isDialogue = type === 'dialogue'
  const defaultModel = items.find(p => p.enabled && p.isPrimary) || items.find(p => p.enabled)
  const presetsAvailable = MODEL_PRESETS.filter(p => p.type === type && !items.some(i => i.id === p.id))

  const update = (index: number, patch: Partial<ModelProvider>) => {
    const next = [...items]
    next[index] = { ...next[index], ...patch }
    // 设为默认时，清除其它模型的默认标记
    if (patch.isPrimary) {
      next.forEach((p, i) => { if (i !== index) p.isPrimary = false })
    }
    setItems(next)
    setTestResults({})
  }

  const addPreset = (presetId: string) => {
    const preset = MODEL_PRESETS.find(p => p.id === presetId)
    if (!preset) return
    setItems([...items, { ...preset, apiKey: '' }])
    setTestResults({})
  }

  const addCustom = () => {
    setItems([...items, {
      id: `custom-${Date.now()}`,
      name: '自定义模型',
      provider: '自定义',
      type,
      apiEndpoint: '',
      apiKey: '',
      modelName: '',
      params: isDialogue ? { temperature: 0.7, max_tokens: 65536 } : {},
      enabled: true,
      isPrimary: isDialogue && items.length === 0
    }])
    setTestResults({})
  }

  const remove = (index: number) => {
    setItems(items.filter((_, i) => i !== index))
    setTestResults({})
  }

  const handleFetchModels = async (provider: ModelProvider) => {
    if (!provider.apiEndpoint || !provider.apiKey) {
      message.warning('请先填写 API 端点和 API Key')
      return
    }
    setLoadingListId(provider.id)
    try {
      const result = await window.electronAPI.model.list(provider)
      if (result.success && result.models) {
        setModelLists(prev => ({ ...prev, [provider.id]: result.models! }))
        const current = provider.modelName && result.models!.includes(provider.modelName)
          ? [provider.modelName]
          : result.models!.slice(0, 1)
        setSelectedModels(prev => ({ ...prev, [provider.id]: current }))
        if (current[0] && current[0] !== provider.modelName) {
          const idx = items.findIndex(p => p.id === provider.id)
          if (idx >= 0) update(idx, { modelName: current[0] })
        }
        message.success(`获取到 ${result.models.length} 个模型`)
      } else {
        message.warning(result.message || '该接口不支持获取模型列表')
      }
    } catch (err: any) {
      message.error(err?.message || '获取模型列表失败')
    } finally {
      setLoadingListId(null)
    }
  }

  const handleSelectedModelsChange = (providerId: string, values: string[]) => {
    setSelectedModels(prev => ({ ...prev, [providerId]: values }))
    if (values.length > 0) {
      const idx = items.findIndex(p => p.id === providerId)
      if (idx >= 0) update(idx, { modelName: values[0] })
    }
  }

  const addSelectedModels = (provider: ModelProvider) => {
    const selected = selectedModels[provider.id] || []
    const existingNames = new Set(items.map(p => p.modelName))
    const additions = selected.filter(name => !existingNames.has(name))
    if (additions.length === 0) {
      message.info('所选模型已在列表中')
      return
    }
    const newItems = additions.map((modelName, idx) => ({
      ...provider,
      id: `api-model-${Date.now()}-${idx}`,
      name: `${provider.name} · ${modelName}`,
      modelName,
      enabled: false,
      isPrimary: false
    }))
    setItems([...items, ...newItems])
    setTestResults({})
    message.success(`已添加 ${additions.length} 个模型为可选模型`)
  }

  const handleTest = async (provider: ModelProvider) => {
    if (!provider.apiEndpoint || !provider.modelName || !provider.apiKey) {
      message.warning('请先填写 API 端点、模型名称和 API Key')
      return
    }
    setTestingId(provider.id)
    try {
      const result = await window.electronAPI.model.test(provider)
      setTestResults(prev => ({ ...prev, [provider.id]: { success: result.success, text: result.message } }))
      if (result.success) {
        message.success(`${provider.name}: ${result.message}`)
      } else {
        message.error(`${provider.name}: ${result.message}`)
      }
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [provider.id]: { success: false, text: err.message || '测试失败' } }))
    } finally {
      setTestingId(null)
    }
  }

  const handleSave = async () => {
    // 校验：对话类型至少需要一个启用的模型
    if (isDialogue && !items.some(p => p.enabled)) {
      message.warning('请至少启用一个对话模型')
      return
    }
    setSaving(true)
    try {
      await onSave(items)
      message.success(`${TYPE_LABELS[type]}配置已保存`)
    } catch (err: any) {
      message.error(`保存失败: ${err.message || '未知错误'}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 当前默认模型状态 */}
      <Alert
        type={defaultModel ? 'success' : 'warning'}
        showIcon
        icon={defaultModel ? <ThunderboltOutlined /> : undefined}
        message={
          isDialogue
            ? defaultModel
              ? `当前对话将使用「${defaultModel.name}」${defaultModel.apiKey ? '' : '（API Key 未填写，请补充后测试）'}`
              : '尚未启用任何对话模型，请添加并启用一个模型'
            : `已配置 ${items.filter(p => p.enabled).length}/${items.length} 个启用的${TYPE_LABELS[type]}`
        }
      />

      {items.length === 0 && (
        <Empty description="暂无模型配置，可从下方预设中添加" />
      )}

      {/* 模型列表 */}
      <div className="space-y-3">
        {items.map((provider, i) => {
          const testResult = testResults[provider.id]
          return (
            <Card
              key={provider.id}
              size="small"
              title={
                <div className="flex items-center gap-2">
                  {isDialogue && (
                    <Tooltip title="设为默认对话模型">
                      <Radio
                        checked={!!provider.isPrimary}
                        onChange={e => update(i, { isPrimary: e.target.checked, enabled: e.target.checked ? true : provider.enabled })}
                      >
                        <span className="text-xs">默认</span>
                      </Radio>
                    </Tooltip>
                  )}
                  <span className="font-medium">{provider.name}</span>
                  <Tag color={provider.provider === '自定义' ? 'default' : 'blue'} className="text-xs">{provider.provider}</Tag>
                  {provider.isPrimary && isDialogue && <StarFilled style={{ color: '#f59e0b' }} />}
                </div>
              }
              extra={
                <Space>
                  <Switch
                    checked={provider.enabled}
                    onChange={v => update(i, { enabled: v })}
                    checkedChildren="启用"
                    unCheckedChildren="禁用"
                    size="small"
                  />
                  <Popconfirm title="确认删除该模型？" onConfirm={() => remove(i)} okText="删除" cancelText="取消">
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-inkMuted mb-1 block">API 端点</label>
                  <Input
                    value={provider.apiEndpoint}
                    onChange={e => update(i, { apiEndpoint: e.target.value })}
                    size="small"
                    placeholder="https://api.example.com/v1 或 .../v1/chat/completions"
                  />
                </div>
                <div>
                  <label className="text-xs text-inkMuted mb-1 block">模型名称</label>
                  <div className="flex gap-2">
                    <Input
                      value={provider.modelName}
                      onChange={e => update(i, { modelName: e.target.value })}
                      size="small"
                      placeholder="模型 ID，如 deepseek-chat"
                      className="flex-1"
                    />
                    <Button
                      size="small"
                      icon={<ApiOutlined />}
                      loading={loadingListId === provider.id}
                      onClick={() => handleFetchModels(provider)}
                    >
                      获取模型
                    </Button>
                  </div>
                </div>
                {modelLists[provider.id] && modelLists[provider.id].length > 0 && (
                  <div className="md:col-span-2">
                    <label className="text-xs text-inkMuted mb-1 block">
                      API 可用模型（选择需要留存的模型，当前使用第一个）
                    </label>
                    <div className="flex gap-2 items-start">
                      <Select
                        mode="multiple"
                        size="small"
                        className="flex-1"
                        value={selectedModels[provider.id] || []}
                        onChange={(values: string[]) => handleSelectedModelsChange(provider.id, values)}
                        options={modelLists[provider.id].map(name => ({ value: name, label: name }))}
                        optionFilterProp="label"
                      />
                      <Button size="small" onClick={() => addSelectedModels(provider)}>
                        添加为可选
                      </Button>
                    </div>
                  </div>
                )}
                <div className="md:col-span-2">
                  <label className="text-xs text-inkMuted mb-1 block">API Key</label>
                  <div className="flex gap-2">
                    <Input.Password
                      value={provider.apiKey}
                      onChange={e => update(i, { apiKey: e.target.value })}
                      onBlur={() => {
                        if (provider.apiEndpoint && provider.apiKey && !modelLists[provider.id]) {
                          handleFetchModels(provider)
                        }
                      }}
                      size="small"
                      placeholder="输入 API Key"
                      className="flex-1"
                    />
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<ThunderboltOutlined />}
                      loading={testingId === provider.id}
                      onClick={() => handleTest(provider)}
                    >
                      测试连接
                    </Button>
                  </div>
                </div>
                {testResult && (
                  <div className="md:col-span-2 -mt-1">
                    <div className={`text-xs flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                      {testResult.success ? <CheckCircleFilled /> : <CloseCircleFilled />}
                      <span className="break-all">{testResult.text}</span>
                    </div>
                  </div>
                )}
                {isDialogue && (
                  <>
                    <div className="md:col-span-2">
                      <label className="text-xs text-inkMuted mb-1 block">
                        温度（Temperature）: <span className="font-medium">{provider.params?.temperature ?? 0.7}</span>
                      </label>
                      <Slider
                        min={0}
                        max={2}
                        step={0.1}
                        value={provider.params?.temperature ?? 0.7}
                        onChange={v => update(i, { params: { ...provider.params, temperature: v } })}
                        tooltip={{ open: false }}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-xs text-inkMuted mb-1 block">最大 Token 数</label>
                      <InputNumber
                        size="small"
                        min={256}
                        max={128000}
                        step={256}
                        value={provider.params?.max_tokens ?? 65536}
                        onChange={v => update(i, { params: { ...provider.params, max_tokens: v ?? 65536 } })}
                        style={{ width: 160 }}
                      />
                    </div>
                  </>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      {/* 添加模型 */}
      <div className="flex flex-wrap gap-2 items-center">
        {presetsAvailable.length > 0 && (
          <Select
            placeholder={`从预设中添加${TYPE_LABELS[type]}`}
            style={{ minWidth: 260 }}
            size="small"
            onChange={addPreset}
            options={presetsAvailable.map(p => ({ value: p.id, label: `${p.name}（${p.provider}）` }))}
          />
        )}
        <Button size="small" icon={<PlusOutlined />} onClick={addCustom}>添加自定义模型</Button>
      </div>

      <Divider style={{ margin: '12px 0' }} />

      <div className="flex justify-end">
        <Button type="primary" onClick={handleSave} loading={saving}>
          保存配置
        </Button>
      </div>
    </div>
  )
}

// 渠道配置子组件（真实接入配置：保存后由主进程 ChannelManager 启动对应连接器）
const CHANNEL_META: Record<string, {
  description: string
  note?: string
  fields: Array<{ key: string; label: string; placeholder?: string; type?: 'password' | 'number' }>
}> = {
  weixin: {
    description: '个人微信通过腾讯 iLink Bot API 接入，由 Hermes 内置网关长轮询收发消息。',
    note: '推荐「扫码登录」：用手机微信扫码并确认登录，Token / Account ID 会自动回填；也支持手动填写已申请的凭据。',
    fields: [
      { key: 'token', label: 'iLink Token', type: 'password' },
      { key: 'accountId', label: 'Account ID' },
      { key: 'baseUrl', label: 'API 地址（可选）', placeholder: '默认 https://ilinkai.weixin.qq.com' }
    ]
  },
  wecom: {
    description: '企业微信智能机器人（Bot 模式）接入，由 Hermes 网关通过 WebSocket 长连接收发消息，无需公网回调地址。',
    note: '推荐「扫码自动接入」：手机企业微信扫码后自动创建机器人并回填凭据；也可在企业微信管理后台创建智能机器人后手动填写 Bot ID / Secret。',
    fields: [
      { key: 'botId', label: 'Bot ID', placeholder: 'aibot_xxxxxxxx' },
      { key: 'secret', label: 'Secret', type: 'password' }
    ]
  },
  dingtalk: {
    description: '钉钉企业内部应用 Stream 模式长连接接入，无需公网回调地址。',
    note: '推荐「扫码自动接入」：用钉钉扫码自动创建机器人并回填 AppKey / AppSecret。也可在钉钉开放平台手动创建 Stream 模式机器人。',
    fields: [
      { key: 'appKey', label: 'AppKey' },
      { key: 'appSecret', label: 'AppSecret', type: 'password' }
    ]
  },
  feishu: {
    description: '飞书企业自建应用长连接模式（WebSocket）接入，无需公网回调地址。',
    note: '推荐「扫码自动接入」：用飞书扫码自动创建应用并回填 App ID / App Secret。也可在飞书开放平台手动创建。',
    fields: [
      { key: 'appId', label: 'App ID' },
      { key: 'appSecret', label: 'App Secret', type: 'password' }
    ]
  }
}

const ChannelConfigSection: React.FC<{ channel: string }> = ({ channel }) => {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm()
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [scan, setScan] = useState<{ state: 'idle' | 'loading' | 'qr' | 'success' | 'error'; qrUrl?: string; qrDataUrl?: string; session?: string; message?: string }>({ state: 'idle' })
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const meta = CHANNEL_META[channel]
  const scanSupported = channel === 'weixin' || channel === 'wecom' || channel === 'dingtalk' || channel === 'feishu'

  const clearScanTimer = () => {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current)
      scanTimerRef.current = null
    }
  }

  useEffect(() => () => clearScanTimer(), [])

  const refreshStatus = async () => {
    try {
      const list = await window.electronAPI.channel.status()
      setStatus(list.find((s: any) => s.id === channel) || null)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const configs = await window.electronAPI.channel.config()
        const cfg = configs[channel] || {}
        if (mounted) {
          form.setFieldsValue(cfg)
          setEnabled(!!cfg.enabled)
          setLoaded(true)
        }
      } catch { /* ignore */ }
      await refreshStatus()
    })()
    return () => { mounted = false }
  }, [channel])

  const handleSave = async (values: any, forceEnabled?: boolean) => {
    setSaving(true)
    try {
      const nextEnabled = forceEnabled === undefined ? enabled : forceEnabled
      const result = await window.electronAPI.channel.save(channel, { ...values, enabled: nextEnabled })
      if (result.success) {
        setEnabled(nextEnabled)
        message.success(result.message || '配置已保存')
      } else {
        message.error(result.message || '保存失败')
      }
      await refreshStatus()
    } finally {
      setSaving(false)
    }
  }

  const patchScanCredentials = (result: any) => {
    if (channel === 'weixin') return { token: result.token, accountId: result.accountId, baseUrl: result.baseUrl }
    if (channel === 'wecom') return { botId: result.botId, secret: result.secret }
    if (channel === 'dingtalk') return { appKey: result.appKey, appSecret: result.appSecret }
    if (channel === 'feishu') return { appId: result.appId, appSecret: result.appSecret }
    return {}
  }

  const pollScan = async (session: string, interval: number) => {
    try {
      const result = await window.electronAPI.channel.scanPoll(channel as any, session)
      if (!result) return schedulePoll(session, interval)

      if (result.status === 'success') {
        clearScanTimer()
        setScan({ state: 'success', message: '扫码成功，凭据已自动填入' })
        const patch = patchScanCredentials(result)
        const values = form.getFieldsValue()
        const merged = { ...values, ...patch }
        form.setFieldsValue(merged)
        setEnabled(true)
        await handleSave(merged, true)
        return
      }

      if (result.status === 'expired' || result.status === 'error') {
        clearScanTimer()
        setScan({ state: 'error', message: result.message || result.error || '二维码已失效' })
        return
      }
      schedulePoll(session, interval)
    } catch (err: any) {
      schedulePoll(session, interval)
    }
  }

  const schedulePoll = (session: string, interval: number) => {
    clearScanTimer()
    scanTimerRef.current = setTimeout(() => pollScan(session, interval), Math.max(2000, (interval || 3) * 1000))
  }

  const startScan = async () => {
    clearScanTimer()
    setScan({ state: 'loading' })
    try {
      const result = await window.electronAPI.channel.scanBegin(channel as any)
      if (result?.status === 'ok' && result.qrDataUrl && result.session) {
        setScan({ state: 'qr', qrUrl: result.qrUrl, qrDataUrl: result.qrDataUrl, session: result.session })
        schedulePoll(result.session, result.interval || 3)
      } else {
        setScan({ state: 'error', message: result?.error || '二维码获取失败' })
      }
    } catch (err: any) {
      setScan({ state: 'error', message: err?.message || '二维码获取失败' })
    }
  }

  const cancelScan = () => {
    clearScanTimer()
    setScan({ state: 'idle' })
  }

  const stateColor = status?.state === 'running' ? 'green' : status?.state === 'error' ? 'red' : status?.state === 'starting' ? 'blue' : 'default'

  return (
    <div className="space-y-4">
      <p className="text-sm text-inkMuted">{meta.description}</p>
      {meta.note && <Alert type="info" message={meta.note} showIcon className="text-xs" />}

      {scanSupported && (
        <div className="rounded-lg border border-dashed border-line p-4 text-center">
          <div className="text-sm font-medium mb-2">扫码自动接入</div>
          {scan.state === 'idle' && (
            <div>
              <p className="text-xs text-inkMuted mb-3">用手机 {channel === 'weixin' ? '微信' : channel === 'wecom' ? '企业微信' : channel === 'dingtalk' ? '钉钉' : '飞书'} 扫码，自动创建机器人并回填凭据</p>
              <Button onClick={startScan}>生成接入二维码</Button>
            </div>
          )}
          {scan.state === 'loading' && <div className="py-4 text-sm text-inkMuted">正在生成二维码…</div>}
          {scan.state === 'qr' && scan.qrDataUrl && (
            <div className="space-y-2">
              <img src={scan.qrDataUrl} alt="接入二维码" className="w-52 h-52 mx-auto rounded-lg border border-line" />
              <div className="text-xs text-inkMuted">请使用手机扫码并确认授权，成功后凭据会自动填入</div>
              <div className="text-xs text-inkMuted">等待扫码授权中…</div>
              <Button size="small" onClick={cancelScan}>取消</Button>
            </div>
          )}
          {scan.state === 'success' && <div className="py-2 text-sm text-green-600">✓ {scan.message || '扫码接入成功'}</div>}
          {scan.state === 'error' && (
            <div className="py-2 text-sm text-red-500">
              {scan.message || '扫码接入失败'}
              <div className="mt-2"><Button size="small" onClick={startScan}>重新生成二维码</Button></div>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between rounded-lg border border-line p-3">
        <div>
          <div className="text-sm font-medium">启用接入</div>
          <div className="text-xs text-inkMuted mt-1">保存后自动启动连接器；关闭后停止但不删除配置</div>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      {status && (
        <div className="flex items-center gap-2 text-sm">
          <span>连接状态：</span>
          <Tag color={stateColor}>{status.state}</Tag>
          <span className="text-xs text-inkMuted flex-1">{status.detail}</span>
        </div>
      )}

      {loaded && (
        <Form layout="vertical" form={form} onFinish={(values) => handleSave(values)}>
          {meta.fields.map(field => (
            <Form.Item
              key={field.key}
              label={field.label}
              name={field.key}
              rules={[{ required: false }]}
            >
              {field.type === 'password'
                ? <Input.Password placeholder={field.placeholder || `请输入 ${field.label}`} />
                : field.type === 'number'
                  ? <InputNumber style={{ width: '100%' }} min={1} max={65535} placeholder={field.placeholder || `请输入 ${field.label}`} />
                  : <Input placeholder={field.placeholder || `请输入 ${field.label}`} />}
            </Form.Item>
          ))}
          <Button type="primary" htmlType="submit" loading={saving} block>
            保存并应用
          </Button>
        </Form>
      )}
    </div>
  )
}

export default TopBar