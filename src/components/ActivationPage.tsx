import React, { useState } from 'react'
import { Input, Button, Alert, Result } from 'antd'
import { SafetyOutlined } from '@ant-design/icons'

interface Props {
  onActivated: () => void
}

const ActivationPage: React.FC<Props> = ({ onActivated }) => {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleActivate = async () => {
    if (!code.trim()) {
      setError('请输入激活码')
      return
    }

    setLoading(true)
    setError('')

    try {
      const result = await window.electronAPI.activation.activate(code)
      if (result.success) {
        onActivated()
      } else {
        setError(result.message)
      }
    } catch (err: any) {
      setError(`激活失败: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-canvas to-indigo-50 dark:to-surface">
      <div className="w-full max-w-md p-8 bg-surface rounded-2xl shadow-xl">
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🛡️</div>
          <h1 className="text-2xl font-bold text-ink mb-2">
            Hermes 人事行政智能专家
          </h1>
          <p className="text-inkMuted text-sm">请输入激活码以启用系统</p>
        </div>

        <div className="space-y-4">
          <Input
            size="large"
            placeholder="请输入激活码 (XXXX-XXXX-XXXX)"
            value={code}
            onChange={e => { setCode(e.target.value); setError('') }}
            onPressEnter={handleActivate}
            prefix={<SafetyOutlined />}
            allowClear
          />

          {error && (
            <Alert message={error} type="error" showIcon />
          )}

          <Button
            type="primary"
            size="large"
            block
            loading={loading}
            onClick={handleActivate}
          >
            激活
          </Button>
        </div>

        <div className="mt-6 text-center text-xs text-inkMuted">
          <p>系统数据全部保存在本地，不会上传至外部服务器</p>
          <p className="mt-1">如需获取激活码，请联系系统管理员</p>
        </div>
      </div>
    </div>
  )
}

export default ActivationPage
