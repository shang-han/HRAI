import React, { useEffect, useState } from 'react'
import { useConfigStore } from './store/configStore'
import { useSessionStore } from './store/sessionStore'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputArea from './components/InputArea'
import TopBar from './components/TopBar'
import TitleBar from './components/TitleBar'
import ActivationPage from './components/ActivationPage'
import CompanyOnboardingPage from './components/CompanyOnboardingPage'
import OfflineBar from './components/OfflineBar'
import HermesStatusBar from './components/HermesStatusBar'
import WorkPriorityView from './components/WorkPriorityView'
import TemplateManagerView from './components/TemplateManagerView'
import ScheduleView from './components/ScheduleView'

const App: React.FC = () => {
  const [activated, setActivated] = useState<boolean | null>(null)
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  // 右侧主区域视图：chat=聊天 / work=近期重点工作页 / templates=预设指令库管理页 / schedules=定时提醒任务页
  const [mainView, setMainView] = useState<'chat' | 'work' | 'templates' | 'schedules'>('chat')
  // 指令库只读模式：输入框入口只能点选填入；编辑/新建只能从侧边栏入口进入
  const [templatesReadonly, setTemplatesReadonly] = useState(false)
  const themeMode = useConfigStore(state => state.theme)
  const initSession = useSessionStore(state => state.initSession)
  const loadConfig = useConfigStore(state => state.loadConfig)
  const stopGenerating = useSessionStore(state => state.stopGenerating)
  const activeSessionId = useSessionStore(state => state.activeSessionId)
  // 空态判定：决定输入框居中还是落底（只订阅长度，避免流式更新时整个 App 重渲染）
  const emptyChat = useSessionStore(state => state.messages.length === 0)

  useEffect(() => {
    // 加载配置（模型、主题、快捷键等）
    loadConfig()

    // 监听停止生成事件
    const handleStop = () => stopGenerating()
    window.addEventListener('stopGeneration', handleStop)

    // 定时提醒/任务触发后，若目标会话是当前会话则刷新消息
    const handleScheduleFired = (data: any) => {
      if (data?.sessionId && data.sessionId === useSessionStore.getState().activeSessionId) {
        useSessionStore.getState().refreshMessages(data.sessionId)
      }
    }
    const offSchedule = window.electronAPI.schedule.onFired(handleScheduleFired)

    // 检查激活状态
    checkActivation()

    // 网络状态监听
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // 初始化主题
    if (themeMode === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('stopGeneration', handleStop)
      offSchedule()
    }
  }, [])

  useEffect(() => {
    if (themeMode === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [themeMode])

  // 切换会话时回到聊天视图（重点工作页只针对当前会话）
  useEffect(() => {
    setMainView('chat')
  }, [activeSessionId])

  // 输入框"模板库"按钮：只读模式打开（仅点选填入，不可编辑/新建）
  useEffect(() => {
    const openTemplates = () => {
      setTemplatesReadonly(true)
      setMainView('templates')
    }
    window.addEventListener('openTemplates', openTemplates)
    return () => window.removeEventListener('openTemplates', openTemplates)
  }, [])

  const enterMainApp = async () => {
    setOnboarding(false)
    await initSession()
  }

  const checkCompanyOnboarding = async () => {
    try {
      const status = await window.electronAPI.company.status()
      if (status.completed) {
        await enterMainApp()
      } else {
        setOnboarding(true)
      }
    } catch {
      // 兼容旧版本/异常情况：不阻塞进入主界面
      await enterMainApp()
    }
  }

  const checkActivation = async () => {
    try {
      const status = await window.electronAPI.activation.status()
      setActivated(status.activated)
      if (status.activated) {
        await checkCompanyOnboarding()
      }
    } catch {
      setActivated(false)
    }
  }

  const handleActivated = () => {
    setActivated(true)
    checkCompanyOnboarding()
  }

  // 统一外壳：所有页面（激活/引导/加载/主界面）顶部都带自绘标题栏
  // 无边框窗口自绘一圈窗口边框（主题淡灰，与卡片边框同色，柔和）+ 圆角窗口
  // 根背景用 surface：聊天区灰色卡片左右留出间距后，两侧露出的是面板色
  const withFrame = (content: React.ReactNode) => (
    <div className="h-screen flex flex-col overflow-hidden bg-surface border border-line rounded-xl">
      <TitleBar />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-b-xl">{content}</div>
    </div>
  )

  // 未激活 → 显示激活页面
  if (activated === false) {
    return withFrame(<ActivationPage onActivated={handleActivated} />)
  }

  // 加载中
  if (activated === null) {
    return withFrame(
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">🔄</div>
          <div className="text-inkMuted">正在加载...</div>
        </div>
      </div>
    )
  }

  // 首次使用：企业信息问答式引导
  if (activated && onboarding === true) {
    return withFrame(<CompanyOnboardingPage onCompleted={enterMainApp} />)
  }

  // 主界面
  return withFrame(
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 离线提示条 */}
      {!online && <OfflineBar />}

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧侧边栏 */}
        <Sidebar
          onOpenWork={() => setMainView('work')}
          onOpenTemplates={() => {
            // 侧边栏入口：完整管理页（可编辑/新建）
            setTemplatesReadonly(false)
            setMainView('templates')
          }}
          onOpenSchedules={() => setMainView('schedules')}
        />

        {/* 右侧主区域 */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {mainView === 'work' ? (
            <WorkPriorityView onBack={() => setMainView('chat')} />
          ) : mainView === 'templates' ? (
            <TemplateManagerView readonly={templatesReadonly} onBack={() => setMainView('chat')} />
          ) : mainView === 'schedules' ? (
            <ScheduleView onBack={() => setMainView('chat')} />
          ) : (
            <>
              {/* Hermes 内核状态警告条（仅会话页面顶部，黄色，未运行时显示） */}
              <HermesStatusBar />

              {/* 顶部栏 */}
              <TopBar />

              {/* 聊天区：浅蓝渐变底，消息与镂空输入框都浮在上面。
                  空态时上下两个弹性占位把「问候语 + 输入框」整体垂直居中；
                  发出第一条消息后占位收成 hidden，ChatArea 吃掉 flex-1，
                  输入框自然落回底部。ChatArea / InputArea 始终留在同一个树位置，
                  不会卸载重挂——否则第一次发送后输入框会丢焦点。 */}
              <div className="hermes-chat-canvas flex-1 min-h-0 flex flex-col">
                <div className={emptyChat ? 'flex-1 min-h-0' : 'hidden'} />
                <ChatArea />
                <InputArea />
                {/* 底部占位略大于顶部：让整块内容坐在视觉中心稍上方，观感更稳 */}
                <div className={emptyChat ? 'flex-[1.25] min-h-0' : 'hidden'} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
