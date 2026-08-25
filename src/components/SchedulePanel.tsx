import React, { useEffect, useState } from 'react'
import { Modal, Input, Select, message } from 'antd'
import {
  ClockCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  CaretRightOutlined,
  BellOutlined,
  RobotOutlined
} from '@ant-design/icons'

interface ScheduledTask {
  id: string
  title: string
  content: string
  dueAt: string
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'
  kind: 'reminder' | 'task'
  sessionId: string
  enabled: boolean
  lastFiredAt?: string | null
  createdAt: string
}

interface SessionOption {
  id: string
  name: string
}

const repeatLabels: Record<string, string> = {
  none: '仅一次',
  daily: '每天',
  weekly: '每周',
  monthly: '每月'
}

function formatDue(dueAt: string): string {
  const d = new Date(dueAt)
  if (Number.isNaN(d.getTime())) return dueAt
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function toLocalInputValue(iso?: string): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const SchedulePanel: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [expanded, setExpanded] = useState(true)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'reminder' | 'task'>('reminder')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [dueAt, setDueAt] = useState(toLocalInputValue())
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none')
  const [sessionId, setSessionId] = useState('')
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    try {
      const [list, sessionList] = await Promise.all([
        window.electronAPI.schedule.list(),
        window.electronAPI.session.list()
      ])
      setTasks(list)
      setSessions(sessionList.map(s => ({ id: s.id, name: s.name })))
      if (!sessionId && sessionList.length > 0) {
        setSessionId(sessionList[0].id)
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refresh()
    const off = window.electronAPI.schedule.onFired(() => refresh())
    return off
  }, [])

  const resetForm = (defaultSessionId?: string) => {
    setKind('reminder')
    setTitle('')
    setContent('')
    setDueAt(toLocalInputValue())
    setRepeat('none')
    setSessionId(defaultSessionId || sessions[0]?.id || '')
  }

  const handleCreate = async () => {
    if (!title.trim()) {
      message.warning('请填写标题')
      return
    }
    if (!dueAt) {
      message.warning('请选择触发时间')
      return
    }
    if (!sessionId) {
      message.warning('请选择目标会话')
      return
    }
    setSaving(true)
    try {
      const result = await window.electronAPI.schedule.create({
        title: title.trim(),
        content: content.trim(),
        dueAt: new Date(dueAt).toISOString(),
        repeat,
        kind,
        sessionId
      })
      if (result.success) {
        message.success(kind === 'task' ? '定时任务已创建' : '定时提醒已创建')
        setOpen(false)
        resetForm()
        await refresh()
      } else {
        message.error(result.error || '创建失败')
      }
    } catch (err: any) {
      message.error(err?.message || '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await window.electronAPI.schedule.delete(id)
      await refresh()
    } catch {
      // ignore
    }
  }

  const pending = tasks.filter(t => t.enabled)
  const done = tasks.filter(t => !t.enabled)
  const sessionName = (id: string) => sessions.find(s => s.id === id)?.name || '未知会话'

  return (
    <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
      <div onClick={() => setExpanded(!expanded)} className="p-3 bg-primarySoft flex justify-between items-center cursor-pointer">
        <span><BellOutlined /> 定时提醒/任务 {pending.length > 0 && <span className="text-xs text-accent ml-1">{pending.length}</span>}</span>
        <div className="flex items-center gap-2">
          <button
            title="新建定时提醒/任务"
            onClick={e => {
              e.stopPropagation()
              resetForm()
              setOpen(true)
            }}
            className="p-1 rounded hover:bg-canvas text-sm leading-none"
          >
            <PlusOutlined />
          </button>
          <span className="text-xs"><CaretRightOutlined className={`transition-transform duration-300 ${expanded ? 'rotate-90' : 'rotate-0'}`} /></span>
        </div>
      </div>
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden min-h-0">
          <div className="p-2 space-y-1">
            {pending.length === 0 && done.length === 0 && (
              <div className="text-xs text-inkMuted py-2 text-center">暂无定时任务/提醒</div>
            )}
            {pending.map(task => (
              <div key={task.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-canvas group">
                {task.kind === 'task' ? <RobotOutlined className="mt-1 text-accent" /> : <ClockCircleOutlined className="mt-1 text-primary" />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">[{task.kind === 'task' ? '任务' : '提醒'}] {task.title}</div>
                  <div className="text-xs text-inkMuted truncate">{formatDue(task.dueAt)} · {repeatLabels[task.repeat] || task.repeat} · {sessionName(task.sessionId)}</div>
                  {task.content && <div className="text-xs text-inkMuted mt-0.5 line-clamp-2">{task.content}</div>}
                </div>
                <button
                  onClick={() => handleDelete(task.id)}
                  className="p-1 rounded text-xs text-red-500 opacity-0 group-hover:opacity-100"
                >
                  <DeleteOutlined />
                </button>
              </div>
            ))}
            {done.length > 0 && (
              <div className="pt-1 border-t border-line">
                <div className="text-xs text-inkMuted px-1 py-1">已结束</div>
                {done.map(task => (
                  <div key={task.id} className="flex items-center gap-2 p-2 rounded-lg opacity-60">
                    {task.kind === 'task' ? <RobotOutlined className="text-inkMuted" /> : <ClockCircleOutlined className="text-inkMuted" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">[{task.kind === 'task' ? '任务' : '提醒'}] {task.title}</div>
                      <div className="text-xs text-inkMuted">{formatDue(task.dueAt)} · {sessionName(task.sessionId)}</div>
                    </div>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="p-1 rounded text-xs text-inkMuted"
                    >
                      <DeleteOutlined />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        title="新建定时提醒/任务"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleCreate}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        width={460}
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs text-inkMuted mb-1">类型</div>
            <Select
              className="w-full"
              value={kind}
              onChange={v => setKind(v)}
              options={[
                { value: 'reminder', label: '定时提醒（在会话内推送提醒）' },
                { value: 'task', label: '定时任务（发送给智能体执行并返回结果）' }
              ]}
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">目标会话</div>
            <Select
              className="w-full"
              value={sessionId}
              onChange={v => setSessionId(v)}
              options={sessions.map(s => ({ value: s.id, label: s.name }))}
              placeholder="请选择会话"
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">标题</div>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={kind === 'task' ? '例如：每天生成考勤汇总' : '例如：提交月度考勤报表'}
              maxLength={100}
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">{kind === 'task' ? '任务指令/提示词' : '提醒内容'}</div>
            <Input.TextArea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={kind === 'task' ? '输入希望智能体执行的任务内容' : '可选，输入提醒详情'}
              rows={3}
              maxLength={500}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-inkMuted mb-1">触发时间</div>
              <input
                type="datetime-local"
                className="w-full border border-line rounded-lg px-3 py-1.5 text-sm bg-canvas text-ink focus:outline-none focus:border-primary"
                value={dueAt}
                onChange={e => setDueAt(e.target.value)}
              />
            </div>
            <div>
              <div className="text-xs text-inkMuted mb-1">重复</div>
              <Select
                className="w-full"
                value={repeat}
                onChange={v => setRepeat(v)}
                options={[
                  { value: 'none', label: '仅一次' },
                  { value: 'daily', label: '每天' },
                  { value: 'weekly', label: '每周' },
                  { value: 'monthly', label: '每月' }
                ]}
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default SchedulePanel
