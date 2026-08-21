import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { Button, Input, Modal, Popconfirm } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'

/**
 * 近期重点工作页面：替换右侧聊天区域整体显示。
 * - 标题（可自动生成）/ 背景 / 目标人群 / 使用场景
 * - 保存（旧版本自动归档）/ 删除当前（含历史）/ 历史恢复
 */
const WorkPriorityView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { sessions, activeSessionId, refreshSessions } = useSessionStore()
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const [wpForm, setWpForm] = useState({ background: '', targetAudience: '', scenario: '' })
  const [wpTitle, setWpTitle] = useState('')

  // 会话切换 / 重点工作变更时同步表单
  useEffect(() => {
    const wp = activeSession?.workPriority
    setWpForm({
      background: wp?.background || '',
      targetAudience: wp?.targetAudience || '',
      scenario: wp?.scenario || ''
    })
    setWpTitle(wp?.title || '')
  }, [activeSessionId, activeSession?.workPriority?.createdAt])

  // 规则生成标题：取背景前 15 字
  const genTitle = () => {
    const t = wpForm.background.replace(/\s+/g, ' ').trim()
    setWpTitle(t ? (t.length > 15 ? t.slice(0, 15) + '…' : t) : '未命名重点工作')
  }

  const save = async () => {
    if (!activeSessionId) return
    if (!wpForm.background.trim() && !wpForm.targetAudience.trim() && !wpForm.scenario.trim()) {
      Modal.warning({ title: '内容为空', content: '请先填写背景、目标人群或使用场景' })
      return
    }
    try {
      await window.electronAPI.session.setWorkPriority(activeSessionId, {
        title: wpTitle || '未命名重点工作',
        ...wpForm
      })
      await refreshSessions()
    } catch (err) {
      console.error('保存重点工作失败:', err)
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
        if (!activeSessionId) return
        try {
          await window.electronAPI.session.clearWorkPriority(activeSessionId)
          await refreshSessions()
        } catch (err) {
          console.error('删除重点工作失败:', err)
        }
      }
    })
  }

  const restore = async (index: number) => {
    if (!activeSessionId) return
    try {
      await window.electronAPI.session.restoreWorkPriority(activeSessionId, index)
      await refreshSessions()
    } catch (err) {
      console.error('恢复重点工作失败:', err)
    }
  }

  const deleteHistory = async (index: number) => {
    if (!activeSessionId) return
    try {
      await window.electronAPI.session.deleteWorkPriorityHistory(activeSessionId, index)
      await refreshSessions()
    } catch (err) {
      console.error('删除历史版本失败:', err)
    }
  }

  const history = activeSession?.workPriority?.history || []

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 页面头 */}
      <div className="h-12 flex items-center gap-3 px-4 bg-surface shrink-0">
        <button
          onClick={onBack}
          title="返回聊天"
          className="p-1.5 rounded-md text-inkSecondary hover:text-primary hover:bg-surfaceSubtle dark:hover:bg-canvas transition-colors"
        >
          <ArrowLeftOutlined />
        </button>
        <span className="text-sm font-medium text-ink">近期重点工作</span>
        <span className="text-xs text-inkMuted truncate">{activeSession?.name}</span>
      </div>

      {/* 表单区 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-4">
          <div className="text-sm text-inkMuted">
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
            {activeSession?.workPriority ? (
              <Button size="small" danger onClick={clear}>删除当前</Button>
            ) : (
              <span />
            )}
            <Button type="primary" onClick={save}>保存</Button>
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
      </div>
    </div>
  )
}

export default WorkPriorityView
