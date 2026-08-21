import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'
import { useConfigStore } from './store/configStore'

// 读取 theme.css 中的主色变量，保证 antd 与应用配色同源
function getCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function Root() {
  const themeMode = useConfigStore(state => state.theme)

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: themeMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: getCssVar('--color-primary', '#4F46E5'),
          borderRadius: 8,
          // 与 index.css body 字体一致（antd 会用它生成 .ant-app 的 font-family）
          fontFamily: "'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
        }
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
