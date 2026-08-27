import React, { useEffect, useState } from 'react'
import { Modal, Input, Select, Switch, Button, message } from 'antd'
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
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

/**
 * 定时提醒/任务管理页（替换右侧聊天区域整体显示，与公共预设指令库同模式）。
 * 侧边栏「定时提醒/任务」入口整行点击进入，头部返回按钮回到聊天。
 */
const ScheduleView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [open, setOpen] = useState(false)
  // 正在编辑的任务 id：非空时弹窗为编辑模式，提交走 update
  const [editingId, setEditingId] = useState<string | null>(null)
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
    setEditingId(null)
    setKind('reminder')
    setTitle('')
    setContent('')
    setDueAt(toLocalInputValue())
    setRepeat('none')
    setSessionId(defaultSessionId || sessions[0]?.id || '')
  }

  /** 编辑现有任务：回填表单后打开同一个弹窗 */
  const openEdit = (task: ScheduledTask) => {
    setEditingId(task.id)
    setKind(task.kind)
    setTitle(task.title)
    setContent(task.content)
    setDueAt(toLocalInputValue(task.dueAt))
    setRepeat(task.repeat)
    setSessionId(task.sessionId)
    setOpen(true)
  }

  const handleSubmit = async () => {
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
      const payload = {
        title: title.trim(),
        content: content.trim(),
        dueAt: new Date(dueAt).toISOString(),
        repeat,
        kind,
        sessionId
      }
      // 编辑模式走 update，新建走 create
      const result = editingId
        ? await window.electronAPI.schedule.update(editingId, payload)
        : await window.electronAPI.schedule.create(payload)
      if (result.success) {
        message.success(editingId ? '已保存修改' : (kind === 'task' ? '定时任务已创建' : '定时提醒已创建'))
        setOpen(false)
        resetForm()
        await refresh()
      } else {
        message.error(editingId ? '保存失败' : '创建失败')
      }
    } catch (err: any) {
      message.error(err?.message || '保存失败')
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

  /** 启用/停用开关：走 update 改 enabled，成功后刷新让条目在两个分区间移动 */
  const handleToggle = async (task: ScheduledTask, enabled: boolean) => {
    try {
      const result = await window.electronAPI.schedule.update(task.id, { enabled })
      if (result && !result.success) message.error('操作失败')
    } catch {
      message.error('操作失败')
    } finally {
      await refresh()
    }
  }

  const pending = tasks.filter(t => t.enabled)
  const done = tasks.filter(t => !t.enabled)
  const sessionName = (id: string) => sessions.find(s => s.id === id)?.name || '未知会话'

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 页面头：返回 + 标题 + 新建 */}
      <div className="h-12 flex items-center gap-3 px-4 bg-surface shrink-0">
        <button
          onClick={onBack}
          title="返回聊天"
          className="p-1.5 rounded-md text-inkSecondary hover:text-primary hover:bg-surfaceSubtle dark:hover:bg-canvas transition-colors"
        >
          <ArrowLeftOutlined />
        </button>
        <span className="text-sm font-medium text-ink">定时提醒/任务</span>
        <span className="text-xs text-inkMuted">{pending.length} 条进行中 · {done.length} 条已停用</span>
        <div className="flex-1" />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => { resetForm(); setOpen(true) }}>
          新建
        </Button>
      </div>

      {/* 列表区 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {tasks.length === 0 ? (
            <div className="py-20 text-center">
              <BellOutlined className="text-3xl text-inkMuted" />
              <div className="text-sm text-inkMuted mt-3">暂无定时提醒/任务</div>
              <Button type="primary" icon={<PlusOutlined />} className="mt-4" onClick={() => { resetForm(); setOpen(true) }}>
                新建定时提醒/任务
              </Button>
            </div>
          ) : (
            <>
              {/* 待执行 */}
              <div className="border border-line rounded-xl bg-surfaceSubtle overflow-hidden">
                <div className="px-3 py-2 text-xs text-inkMuted border-b border-line">待执行（{pending.length}）</div>
                <div className="p-2 space-y-1">
                  {pending.length === 0 && (
                    <div className="text-xs text-inkMuted py-2 text-center">暂无待执行任务</div>
                  )}
                  {pending.map(task => (
                    <div key={task.id} className="flex items-start gap-2 p-2 rounded-lg hover:bg-canvas group">
                      {task.kind === 'task' ? <RobotOutlined className="mt-1 text-accent" /> : <ClockCircleOutlined className="mt-1 text-primary" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">[{task.kind === 'task' ? '任务' : '提醒'}] {task.title}</div>
                        <div className="text-xs text-inkMuted truncate">{formatDue(task.dueAt)} · {repeatLabels[task.repeat] || task.repeat} · {sessionName(task.sessionId)}</div>
                        {task.content && <div className="text-xs text-inkMuted mt-0.5 line-clamp-2">{task.content}</div>}
                      </div>
                      {/* 开关与操作按钮包成一组居中排列：开关比按钮矮，直接顶对齐会不齐 */}
                      <div className="flex items-center gap-1 mt-0.5">
                        <Switch size="small" checked onChange={v => handleToggle(task, v)} />
                        <button
                          onClick={() => openEdit(task)}
                          className="p-1 rounded text-xs text-inkMuted opacity-0 group-hover:opacity-100 hover:text-primary"
                        >
                          <EditOutlined />
                        </button>
                        <button
                          onClick={() => handleDelete(task.id)}
                          className="p-1 rounded text-xs text-red-500 opacity-0 group-hover:opacity-100"
                        >
                          <DeleteOutlined />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 已停用 */}
              {done.length > 0 && (
                <div className="border border-line rounded-xl bg-surfaceSubtle overflow-hidden">
                  <div className="px-3 py-2 text-xs text-inkMuted border-b border-line">已停用（{done.length}）</div>
                  <div className="p-2 space-y-1">
                    {done.map(task => (
                      <div key={task.id} className="flex items-center gap-2 p-2 rounded-lg opacity-60">
                        {task.kind === 'task' ? <RobotOutlined className="text-inkMuted" /> : <ClockCircleOutlined className="text-inkMuted" />}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">[{task.kind === 'task' ? '任务' : '提醒'}] {task.title}</div>
                          <div className="text-xs text-inkMuted">{formatDue(task.dueAt)} · {sessionName(task.sessionId)}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Switch size="small" onChange={v => handleToggle(task, v)} />
                          <button
                            onClick={() => openEdit(task)}
                            className="p-1 rounded text-xs text-inkMuted hover:text-primary"
                          >
                            <EditOutlined />
                          </button>
                          <button
                            onClick={() => handleDelete(task.id)}
                            className="p-1 rounded text-xs text-inkMuted"
                          >
                            <DeleteOutlined />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        title={editingId ? '编辑定时提醒/任务' : '新建定时提醒/任务'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleSubmit}
        okText={editingId ? '保存' : '创建'}
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

export default ScheduleView
