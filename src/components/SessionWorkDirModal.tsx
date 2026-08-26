import React, { useEffect, useState } from 'react'
import { Modal, Input, Button, Radio, Alert, Tooltip } from 'antd'
import { FolderOpenOutlined, FolderOutlined, HomeOutlined } from '@ant-design/icons'

/**
 * 会话工作目录弹窗（新建会话 / 修改已有会话共用一套目录选择器）。
 *
 * 为什么要有这个东西：智能体的读写、命令执行、产物落盘全都发生在 ACP
 * session/new 的 cwd 里。cwd 写死成内置 workspace/ 时，它只能在自己的沙盒里
 * 干活；让每个会话自选目录，才谈得上"去用户的资料里替他把活干完"。
 *
 * 目录值的约定：空串 = 内置工作区（由主进程 HermesManager.getWorkspacePath()
 * 解析）。刻意不在前端把它展开成绝对路径存进会话，安装目录搬家后仍然正确。
 */

const NAME_MAX = 40

interface Props {
  open: boolean
  mode: 'create' | 'change'
  /** change 模式下的当前值（空串=内置工作区） */
  initialWorkDir?: string
  /** create 模式下的会话名预填值 */
  initialName?: string
  /** change 模式：会话已有消息数，>0 时提示智能体上下文会重置 */
  messageCount?: number
  onCancel: () => void
  /** create 模式回调 (name, workDir)；change 模式 name 恒为空串 */
  onSubmit: (name: string, workDir: string) => Promise<void> | void
}

/** 只取路径最后一段做显示名，末尾分隔符要先剥掉，否则 D:\HR\ 会算出空串 */
export function workDirLabel(dir: string): string {
  const trimmed = (dir || '').replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const seg = trimmed.split(/[\\/]/).pop() || ''
  return seg || trimmed
}

const SessionWorkDirModal: React.FC<Props> = ({
  open, mode, initialWorkDir = '', initialName = '', messageCount = 0, onCancel, onSubmit
}) => {
  const [name, setName] = useState(initialName)
  // '' 代表内置工作区；其余为绝对路径
  const [workDir, setWorkDir] = useState(initialWorkDir)
  const [defaultPath, setDefaultPath] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 每次打开都重新拉一次：最近使用列表会被别的会话改，且失效目录由主进程过滤
  useEffect(() => {
    if (!open) return
    setName(initialName)
    setWorkDir(initialWorkDir)
    setError('')
    setSubmitting(false)
    window.electronAPI.workdir.info()
      .then(info => {
        setDefaultPath(info?.defaultPath || '')
        setRecent(Array.isArray(info?.recent) ? info.recent : [])
        // 新建会话默认沿用上次用过的目录。last 由主进程校验过存在性，
        // 目录已被删掉时会回落成空串（内置工作区），不会预选一个死路径。
        if (mode === 'create' && !initialWorkDir) {
          setWorkDir(info?.last || '')
        }
      })
      .catch(() => { /* 拿不到候选也不影响"浏览其他目录" */ })
  }, [open, mode, initialName, initialWorkDir])

  const browse = async () => {
    const res = await window.electronAPI.workdir.pick(workDir || defaultPath)
    if (!res?.success) {
      // 用户取消不算错误，只有校验失败才有 error
      if (res?.error) setError(res.error)
      return
    }
    setError('')
    setWorkDir(res.path || '')
  }

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(name.trim(), workDir)
    } finally {
      setSubmitting(false)
    }
  }

  // 候选列表：内置工作区 + 最近使用 + （当前选中但不在上面两者里的）自选目录。
  // 去重要按小写比：Windows 路径大小写不敏感，否则同一目录会出现两行。
  const options: Array<{ value: string; label: string; hint: string; builtin?: boolean }> = [
    { value: '', label: '内置工作区', hint: defaultPath || '应用自带的 workspace/（含模板与台账）', builtin: true }
  ]
  const seen = new Set<string>([(defaultPath || '').toLowerCase()])
  for (const p of recent) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ value: p, label: workDirLabel(p), hint: p })
  }
  if (workDir && !seen.has(workDir.toLowerCase())) {
    options.push({ value: workDir, label: workDirLabel(workDir), hint: workDir })
  }

  return (
    <Modal
      title={mode === 'create' ? '新建会话' : '修改会话工作目录'}
      open={open}
      onCancel={onCancel}
      onOk={submit}
      okText={mode === 'create' ? '创建会话' : '确认修改'}
      cancelText="取消"
      confirmLoading={submitting}
      width={520}
      destroyOnClose
    >
      {mode === 'create' && (
        <div className="mb-4">
          <div className="text-sm text-inkSecondary mb-1.5">会话名称</div>
          <Input
            value={name}
            maxLength={NAME_MAX}
            placeholder="例如：2026 春招筹备"
            onChange={e => setName(e.target.value)}
            onPressEnter={submit}
          />
        </div>
      )}

      <div className="text-sm text-inkSecondary mb-1.5">
        工作目录
        <span className="text-xs text-inkMuted ml-2">AI 的文件读写与命令执行都发生在此目录内</span>
      </div>

      <Radio.Group
        value={workDir}
        onChange={e => { setWorkDir(e.target.value); setError('') }}
        className="w-full"
      >
        <div className="hermes-workdir-list flex flex-col gap-1.5">
          {options.map(opt => (
            <Radio key={opt.value || '__builtin__'} value={opt.value} className="hermes-workdir-opt">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm">
                  {opt.builtin ? <HomeOutlined /> : <FolderOutlined />}
                  <span className="truncate">{opt.label}</span>
                </div>
                <Tooltip title={opt.hint}>
                  <div className="hermes-workdir-path">{opt.hint}</div>
                </Tooltip>
              </div>
            </Radio>
          ))}
        </div>
      </Radio.Group>

      <Button className="mt-2" icon={<FolderOpenOutlined />} onClick={browse} block>
        浏览其他目录…
      </Button>

      {workDir && (
        <div className="text-xs text-inkMuted mt-3">
          该目录不会被预置任何文件；AI 生成的产物会放进其中的 <code>output/</code>（按需自动创建）。
        </div>
      )}

      {mode === 'change' && messageCount > 0 && (
        <Alert
          className="mt-3"
          type="warning"
          showIcon
          message="智能体上下文会重置"
          description="工作目录是智能体会话创建时确定的，修改后需要用新目录重开会话：AI 会忘记本次对话中已经建立的上下文（已读过的文件、中间结论等）。左侧聊天记录仍然保留。"
        />
      )}

      {error && <Alert className="mt-3" type="error" showIcon message={error} />}
    </Modal>
  )
}

export default SessionWorkDirModal
