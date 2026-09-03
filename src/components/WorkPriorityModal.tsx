import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { Button, Input, Modal, Popconfirm, App as AntApp } from 'antd'

/**
 * 近期重点工作编辑弹窗：从会话列表行右上角的小旗图标打开，
 * 编辑的是指定会话（sessionId）的重点工作，与当前激活会话无关。
 * sessionId 为 null 时弹窗关闭。
 */
const WorkPriorityModal: React.FC<{ sessionId: string | null; onClose: () => void }> = ({ sessionId, onClose }) => {
  const { sessions, refreshSessions } = useSessionStore()
  const { message } = AntApp.useApp()
  const [wpForm, setWpForm] = useState({ background: '', targetAudience: '', scenario: '' })
  const [wpTitle, setWpTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const session = sessions.find(s => s.id === sessionId) || null

  // 打开/切换目标会话时回填表单
  useEffect(() => {
    if (!sessionId) return
    const wp = session?.workPriority
    setWpForm({
      background: wp?.background || '',
      targetAudience: wp?.targetAudience || '',
      scenario: wp?.scenario || ''
    })
    setWpTitle(wp?.title || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 规则生成标题：取背景前 15 字
  const genTitle = () => {
    const t = wpForm.background.replace(/\s+/g, ' ').trim()
    setWpTitle(t ? (t.length > 15 ? t.slice(0, 15) + '…' : t) : '未命名重点工作')
  }

  const save = async () => {
    if (!sessionId) return
    if (!wpForm.background.trim() && !wpForm.targetAudience.trim() && !wpForm.scenario.trim()) {
      message.warning('请先填写背景、目标人群或使用场景')
      return
    }
    setSaving(true)
    try {
      const wp = await window.electronAPI.session.setWorkPriority(sessionId, {
        title: wpTitle || '未命名重点工作',
        ...wpForm
      })
      if (!wp) {
        message.error('保存失败：会话不存在')
        return
      }
      message.success('重点工作已保存')
      await refreshSessions()
      onClose()
    } catch (err) {
      console.error('保存重点工作失败:', err)
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const clear = () => {
    Modal.confirm({
      title: '删除当前重点工作？',
      content: '删除后该会话的 AI 输出不再带此背景（历史版本一并清除）',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        if (!sessionId) return
        try {
          await window.electronAPI.session.clearWorkPriority(sessionId)
          await refreshSessions()
          message.success('重点工作已删除')
          onClose()
        } catch (err) {
          console.error('删除重点工作失败:', err)
          message.error('删除失败，请重试')
        }
      }
    })
  }

  const restore = async (index: number) => {
    if (!sessionId) return
    try {
      await window.electronAPI.session.restoreWorkPriority(sessionId, index)
      await refreshSessions()
      message.success('已恢复该历史版本')
    } catch (err) {
      console.error('恢复重点工作失败:', err)
      message.error('恢复失败，请重试')
    }
  }

  const deleteHistory = async (index: number) => {
    if (!sessionId) return
    try {
      await window.electronAPI.session.deleteWorkPriorityHistory(sessionId, index)
      await refreshSessions()
      message.success('历史版本已删除')
    } catch (err) {
      console.error('删除历史版本失败:', err)
      message.error('删除失败，请重试')
    }
  }

  const history = session?.workPriority?.history || []

  return (
    <Modal
      title={session ? `近期重点工作 · ${session.name}` : '近期重点工作'}
      open={!!sessionId}
      onCancel={onClose}
      footer={null}
      width={560}
    >
      <div className="space-y-4">
        <div className="text-xs text-inkMuted">
          保存后，该会话发送消息时 AI 会自动带上以下背景，输出贴合你的项目。
        </div>

        <div>
          <div className="text-xs text-inkMuted mb-1">标题</div>
          <Input
            value={wpTitle}
            onChange={e => setWpTitle(e.target.value)}
            placeholder="未命名重点工作"
          />
          <div className="flex justify-end mt-1">
            <Button size="small" type="link" onClick={genTitle}>自动生成标题</Button>
          </div>
        </div>

        <div>
          <div className="text-xs text-inkMuted mb-1">当前项目背景</div>
          <Input.TextArea
            rows={4}
            value={wpForm.background}
            onChange={e => setWpForm(prev => ({ ...prev, background: e.target.value }))}
            placeholder="例如：公司在推进 XX 项目…"
          />
        </div>

        <div>
          <div className="text-xs text-inkMuted mb-1">目标人群</div>
          <Input
            value={wpForm.targetAudience}
            onChange={e => setWpForm(prev => ({ ...prev, targetAudience: e.target.value }))}
            placeholder="例如：中小企业客户"
          />
        </div>

        <div>
          <div className="text-xs text-inkMuted mb-1">使用场景</div>
          <Input
            value={wpForm.scenario}
            onChange={e => setWpForm(prev => ({ ...prev, scenario: e.target.value }))}
            placeholder="例如：招聘 / 制度 / 报表"
          />
        </div>

        <div className="flex justify-between items-center pt-1">
          {session?.workPriority ? (
            <Button size="small" danger onClick={clear}>删除当前</Button>
          ) : (
            <span />
          )}
          <Button type="primary" loading={saving} onClick={save}>保存</Button>
        </div>

        {history.length > 0 && (
          <div className="pt-2">
            <div className="text-xs text-inkMuted mb-1">历史版本（{history.length}）</div>
            <div className="space-y-1">
              {history.map((h: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-sm text-inkSecondary px-3 py-2 border border-line rounded-md bg-surfaceSubtle dark:bg-canvas">
                  <span className="truncate flex-1" title={h.background}>{h.title || '未命名'}</span>
                  <span className="text-xs text-inkMuted shrink-0">{(h.createdAt || '').slice(0, 10)}</span>
                  <button className="text-primary text-xs shrink-0" onClick={() => restore(i)}>恢复</button>
                  <Popconfirm
                    title="删除该历史版本？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => deleteHistory(i)}
                  >
                    <button className="text-red-500 text-xs shrink-0">删除</button>
                  </Popconfirm>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default WorkPriorityModal
