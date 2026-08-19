import React from 'react'
import { WifiOutlined } from '@ant-design/icons'

const OfflineBar: React.FC = () => {
  return (
    <div className="bg-warning text-white text-center py-1.5 text-sm flex items-center justify-center gap-2">
      <WifiOutlined />
      <span>网络已断开，部分功能不可用。正在尝试重新连接...</span>
    </div>
  )
}

export default OfflineBar
