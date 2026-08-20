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

const App: React.FC = () => {
  const [activated, setActivated] = useState<boolean | null>(null)
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const themeMode = useConfigStore(state => state.theme)
  const initSession = useSessionStore(state => state.initSession)
  const loadConfig = useConfigStore(state => state.loadConfig)
  const stopGenerating = useSessionStore(state => state.stopGenerating)

  useEffect(() => {
    // 加载配置（模型、主题、快捷键等）
    loadConfig()

    // 监听停止生成事件
    const handleStop = () => stopGenerating()
    window.addEventListener('stopGeneration', handleStop)

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
    }
  }, [])

  useEffect(() => {
    if (themeMode === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [themeMode])

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
  const withFrame = (content: React.ReactNode) => (
    <div className="h-screen flex flex-col overflow-hidden bg-canvas">
      <TitleBar />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{content}</div>
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
        <Sidebar />

        {/* 右侧主区域 */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* 顶部栏 */}
          <TopBar />

          {/* 聊天区域 */}
          <ChatArea />

          {/* 输入区域 */}
          <InputArea />
        </main>
      </div>
    </div>
  )
}

export default App
