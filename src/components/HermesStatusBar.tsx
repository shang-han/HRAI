import React, { useEffect, useState } from 'react'
import { WarningOutlined } from '@ant-design/icons'

/**
 * Hermes 内核状态提示条：内核未运行时在页面顶部显示黄色警告行。
 * 每 10 秒轮询一次状态，就绪后自动消失。
 */
const HermesStatusBar: React.FC = () => {
  const [running, setRunning] = useState<boolean | null>(null)

  useEffect(() => {
    let mounted = true
    const check = async () => {
      try {
        const res = await window.electronAPI.hermes.status()
        if (mounted) setRunning(!!res?.isRunning)
      } catch {
        if (mounted) setRunning(false)
      }
    }
    check()
    const timer = setInterval(check, 10000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [])

  // 状态未知或已就绪时不显示
  if (running !== false) return null

  return (
    <div className="flex items-center justify-center gap-2 py-1.5 px-4 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 select-none">
      <WarningOutlined />
      <span>Hermes 智能体未运行，AI 功能暂不可用（正在初始化或启动失败，请稍后重试）</span>
    </div>
  )
}

export default HermesStatusBar
