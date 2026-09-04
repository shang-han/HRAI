import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Input, Modal, Popconfirm, Select, Tag, message } from 'antd'
import {
  ArrowLeftOutlined,
  SearchOutlined,
  FileExcelOutlined,
  EditOutlined,
  InboxOutlined,
  ExportOutlined,
  ImportOutlined,
  ReloadOutlined,
  PlusOutlined
} from '@ant-design/icons'

/**
 * 「我的格式」管理页（P2 结构复用 · 第 5 步）
 *
 * 与「公共预设指令库」是两套东西，别混：
 *   - 指令库 template:* 管的是「让模型做什么」的文字指令
 *   - 我的格式 format:*  管的是「表长什么样」的字段结构（列顺序/类型/口径）
 *
 * 三条硬约束在 UI 上也要说清楚：
 *   1. 删除=归档（不是物理删除，模板是用户确认过的资产）
 *   2. 导入冲突自动并存改名，绝不静默覆盖
 *   3. 跨意图不套用（召回侧保证，本页按意图分组展示，让用户看得见边界）
 */

type Lifecycle = 'instance' | 'candidate' | 'active' | 'archived'

interface FormatTemplateLite {
  id: string
  name: string
  intentId?: string
  intentLabel?: string
  workflow?: string
  lifecycle: Lifecycle
  version: number
  skeleton: {
    sheets: Array<{
      name: string
      index: number
      headerRow: number
      isPrimary: boolean
      rowCount: number
      columns: Array<{ key: string; index: number; inferredType?: string; enumValues?: string[]; numFmt?: string }>
      sampleRows?: string[][]
    }>
    norms: string[]
  }
  norms: string[]
  stats: { useCount: number; acceptCount: number; rejectCount: number; lastUsedAt: string }
  evidence: Array<{ filePath: string; fileName: string; pathMissing?: boolean }>
  updatedAt: string
}

interface Candidate {
  filePath: string
  fileName: string
  skeleton: FormatTemplateLite['skeleton']
}

const LIFECYCLE_META: Record<Lifecycle, { label: string; color: string; desc: string }> = {
  instance: { label: '单次实例', color: 'default', desc: '只用过一次，还不参与自动套用' },
  candidate: { label: '候选', color: 'blue', desc: '复用过多次，生成时作为参考' },
  active: { label: '已确认', color: 'green', desc: '你确认过，生成时严格要求对齐' },
  archived: { label: '已归档', color: 'default', desc: '已停用，不再参与套用' }
}

/** 主表字段（chips 展示用），主表没有就退回第一张表 */
function primaryColumns(t: FormatTemplateLite): Array<{ key: string; inferredType?: string; numFmt?: string; enumValues?: string[] }> {
  const sheets = t.skeleton?.sheets || []
  return (sheets.find(s => s.isPrimary) || sheets[0])?.columns || []
}

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const FormatManagerView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [list, setList] = useState<FormatTemplateLite[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [lifecycleFilter, setLifecycleFilter] = useState<'all' | Lifecycle | 'live'>('live')
  // 展开预览的模板 id（结构预览是只读的，不做行内编辑）
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 改名弹窗
  const [renameOpen, setRenameOpen] = useState(false)
  const [renaming, setRenaming] = useState<FormatTemplateLite | null>(null)
  const [renameName, setRenameName] = useState('')

  // 「从产出里存为格式」弹窗
  const [addOpen, setAddOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [candLoading, setCandLoading] = useState(false)
  const [picked, setPicked] = useState<Candidate | null>(null)
  const [newName, setNewName] = useState('')

  const api = () => window.electronAPI.format

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList((await api().list(true)) || [])
    } catch (err: any) {
      message.error(`加载格式模板失败：${err?.message || err}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return list.filter(t => {
      if (lifecycleFilter === 'live') {
        if (t.lifecycle === 'archived') return false
      } else if (lifecycleFilter !== 'all' && t.lifecycle !== lifecycleFilter) {
        return false
      }
      if (!q) return true
      const fields = primaryColumns(t).map(c => c.key).join(' ')
      return (
        t.name.toLowerCase().includes(q) ||
        (t.intentLabel || '').toLowerCase().includes(q) ||
        (t.norms || []).join(' ').toLowerCase().includes(q) ||
        fields.toLowerCase().includes(q)
      )
    })
  }, [list, searchText, lifecycleFilter])

  const openRename = (t: FormatTemplateLite) => {
    setRenaming(t)
    setRenameName(t.name)
    setRenameOpen(true)
  }

  const handleRename = async () => {
    const name = renameName.trim()
    if (!renaming || !name) return
    try {
      await api().update(renaming.id, { name })
      message.success('已改名')
      setRenameOpen(false)
      await load()
    } catch (err: any) {
      message.error(`改名失败：${err?.message || err}`)
    }
  }

  // 删除在后端就是归档：模板是用户确认过的资产，不物理删
  const handleArchive = async (t: FormatTemplateLite) => {
    try {
      await api().delete(t.id)
      message.success(`已归档「${t.name}」（可在筛选里找回）`)
      await load()
    } catch (err: any) {
      message.error(`归档失败：${err?.message || err}`)
    }
  }

  const handleExport = async () => {
    try {
      const res = await api().exportAll()
      if (res?.success === false) return // 用户取消，不提示
      message.success(`已导出 ${res?.count ?? 0} 个格式模板`)
    } catch (err: any) {
      message.error(`导出失败：${err?.message || err}`)
    }
  }

  const handleImport = async () => {
    try {
      const res = await api().importAll()
      if ('success' in res) return // 用户取消，不提示
      const renamed = res.renamed?.length ?? 0
      message.success(
        res.imported
          ? `已导入 ${res.imported} 个${renamed ? `，其中 ${renamed} 个重名已并存改名` : ''}`
          : '没有导入任何模板'
      )
      if (res.errors?.length) message.warning(`部分条目跳过：${res.errors[0]}`)
      await load()
    } catch (err: any) {
      message.error(`导入失败：${err?.message || err}`)
    }
  }

  const openAdd = async () => {
    setAddOpen(true)
    setPicked(null)
    setNewName('')
    setCandLoading(true)
    try {
      setCandidates((await api().candidates()) || [])
    } catch (err: any) {
      message.error(`扫描产出目录失败：${err?.message || err}`)
      setCandidates([])
    } finally {
      setCandLoading(false)
    }
  }

  const handleSaveFromCandidate = async () => {
    if (!picked) return
    const name = newName.trim()
    if (!name) {
      message.warning('请先给这个格式起个名字')
      return
    }
    try {
      const res = await api().save({
        skeleton: picked.skeleton,
        name,
        filePath: picked.filePath,
        fileName: picked.fileName,
        lifecycle: 'active' // 手动保存是唯一能直接到「已确认」的路径
      })
      message.success(res?.capacityWarning ? `已保存（${res.capacityWarning.message}）` : '已保存为我的格式')
      setAddOpen(false)
      await load()
    } catch (err: any) {
      message.error(`保存失败：${err?.message || err}`)
    }
  }

  const renderSkeleton = (t: FormatTemplateLite) => {
    const sheets = t.skeleton?.sheets || []
    return (
      <div className="space-y-2 pt-2">
        {sheets.map(s => (
          <div key={`${s.name}-${s.index ?? 0}`} className="border border-line rounded-md p-2 bg-surface">
            <div className="flex items-center gap-2 mb-1.5">
              <FileExcelOutlined className="text-xs text-inkMuted" />
              <span className="text-xs font-medium text-ink">
                {s.name}
                {s.isPrimary && <span className="ml-1 text-[10px] text-primary">（主表）</span>}
              </span>
              <span className="text-[10px] text-inkMuted">表头第 {s.headerRow} 行 · {s.rowCount} 行数据</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {s.columns.map(c => (
                <span
                  key={c.key}
                  title={[c.inferredType, c.numFmt, c.enumValues?.length ? `枚举: ${c.enumValues.join('/')}` : ''].filter(Boolean).join(' · ')}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-line bg-surfaceSubtle text-inkSecondary"
                >
                  {c.key}
                </span>
              ))}
              {s.columns.length === 0 && <span className="text-[10px] text-inkMuted">未识别到表头</span>}
            </div>
          </div>
        ))}
        {(t.norms || []).length > 0 && (
          <div className="text-[11px] text-inkSecondary leading-relaxed">
            <span className="text-inkMuted">口径：</span>
            {(t.norms || []).join('；')}
          </div>
        )}
        <div className="text-[10px] text-inkMuted">
          来源：{t.evidence?.[0]?.fileName || '—'}
          {t.evidence?.[0]?.pathMissing && '（源文件已删除，仍可套用）'}
        </div>
      </div>
    )
  }

  return (
    <div className="hermes-chat-canvas flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 页面头 */}
      <div className="h-12 flex items-center gap-2 px-4 bg-surface shrink-0">
        <button
          onClick={onBack}
          title="返回聊天"
          className="p-1.5 rounded-md text-inkSecondary hover:text-primary hover:bg-surfaceSubtle transition-colors"
        >
          <ArrowLeftOutlined />
        </button>
        <span className="text-sm font-medium text-ink">我的格式</span>
        <span className="text-xs text-inkMuted">xlsx 表结构 · 列序/类型/公式/口径</span>
        <span className="text-xs text-inkMuted">{visible.length} / {list.length} 个</span>
        <div className="flex-1" />
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
        <Button size="small" icon={<ImportOutlined />} onClick={handleImport}>导入</Button>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExport}>导出</Button>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openAdd}>存为我的格式</Button>
      </div>

      {/* 筛选条 */}
      <div className="shrink-0 px-4 py-2 flex items-center gap-2 border-b border-line">
        <Input
          className="max-w-xs"
          prefix={<SearchOutlined />}
          placeholder="搜索名称 / 意图 / 字段 / 口径..."
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
        />
        <Select
          className="w-40"
          value={lifecycleFilter}
          onChange={setLifecycleFilter}
          options={[
            { label: '在用（排除已归档）', value: 'live' },
            { label: '全部', value: 'all' },
            { label: '已确认', value: 'active' },
            { label: '候选', value: 'candidate' },
            { label: '单次实例', value: 'instance' },
            { label: '已归档', value: 'archived' }
          ]}
        />
        <span className="text-[11px] text-inkMuted">
          删除=归档，不会真的删掉；导入时重名会自动并存改名，不覆盖你现有的格式
        </span>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading && list.length === 0 ? (
          <div className="text-center text-sm text-inkMuted py-8">加载中...</div>
        ) : visible.length === 0 ? (
          <Empty
            description={
              list.length === 0
                ? '还没有格式模板。点右上角「存为我的格式」，从产出目录里挑一个你惯用的表'
                : '没有匹配的格式模板'
            }
          />
        ) : (
          <div className="space-y-1.5">
            {visible.map(t => {
              const meta = LIFECYCLE_META[t.lifecycle] || LIFECYCLE_META.instance
              const cols = primaryColumns(t)
              const open = expandedId === t.id
              return (
                <div key={t.id} className="border border-line rounded-md bg-surfaceSubtle">
                  <div
                    className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:border-primary transition-colors"
                    onClick={() => setExpandedId(open ? null : t.id)}
                  >
                    <FileExcelOutlined className="text-sm text-inkMuted shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink truncate max-w-[260px]">{t.name}</span>
                        <Tag color={meta.color} className="!m-0 !text-[10px] !leading-4" title={meta.desc}>
                          {meta.label}
                        </Tag>
                        {t.intentLabel && (
                          <span className="text-[10px] text-inkMuted px-1.5 py-0.5 rounded border border-line">
                            {t.intentLabel}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {cols.slice(0, 12).map(c => (
                          <span key={c.key} className="px-1.5 py-0.5 text-[10px] rounded border border-line bg-surface text-inkSecondary">
                            {c.key}
                          </span>
                        ))}
                        {cols.length > 12 && (
                          <span className="text-[10px] text-inkMuted self-center">…等 {cols.length} 列</span>
                        )}
                        {cols.length === 0 && <span className="text-[10px] text-inkMuted">未识别到表头</span>}
                      </div>
                      <div className="text-[10px] text-inkMuted mt-1">
                        套用 {t.stats?.useCount ?? 0} 次 · 采纳 {t.stats?.acceptCount ?? 0} 次 · 不用 {t.stats?.rejectCount ?? 0} 次 ·
                        最近 {fmtDate(t.stats?.lastUsedAt)} · v{t.version}
                      </div>
                    </div>

                    {/* 阻断冒泡：按钮区点击不得触发行展开 */}
                    <div className="flex gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        title="改名"
                        onClick={e => { e.stopPropagation(); openRename(t) }}
                        className="p-1 rounded hover:bg-surface text-xs text-inkSecondary"
                      >
                        <EditOutlined />
                      </button>
                      {t.lifecycle !== 'archived' && (
                        <Popconfirm
                          title="归档该格式？"
                          description="归档后不再参与自动套用，但不会删除，可随时在筛选里找回。"
                          okText="归档"
                          cancelText="取消"
                          onConfirm={() => handleArchive(t)}
                        >
                          <button
                            title="归档（不是真删）"
                            onClick={e => e.stopPropagation()}
                            className="p-1 rounded hover:bg-red-100 text-xs text-red-500"
                          >
                            <InboxOutlined />
                          </button>
                        </Popconfirm>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div className="px-3 pb-2 border-t border-line">
                      {renderSkeleton(t)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 改名 */}
      <Modal
        title="改名"
        open={renameOpen}
        onOk={handleRename}
        onCancel={() => setRenameOpen(false)}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !renameName.trim() || renameName.trim() === renaming?.name }}
        destroyOnClose
      >
        <Input
          placeholder="例如：考勤汇总表（我惯用的）"
          value={renameName}
          onChange={e => setRenameName(e.target.value)}
        />
      </Modal>

      {/* 从产出目录存为格式 */}
      <Modal
        title="存为我的格式"
        open={addOpen}
        onOk={handleSaveFromCandidate}
        onCancel={() => setAddOpen(false)}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !picked || !newName.trim() }}
        width={620}
        destroyOnClose
      >
        <div className="space-y-3">
          <div className="text-[11px] text-inkMuted">
            从工作区产出目录（workspace/output）里挑一个你惯用的表，只记结构（列顺序 / 类型 / 口径），不复制数据。
            保存后即为「已确认」，同类任务生成时会严格要求对齐。
          </div>
          {candLoading ? (
            <div className="text-center text-sm text-inkMuted py-6">扫描中...</div>
          ) : candidates.length === 0 ? (
            <Empty description="产出目录里还没有 xlsx 文件" />
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-1">
              {candidates.map(c => {
                const sheets = c.skeleton?.sheets || []
                const cols = (sheets.find(s => s.isPrimary) || sheets[0])?.columns || []
                const active = picked?.filePath === c.filePath
                return (
                  <div
                    key={c.filePath}
                    onClick={() => {
                      setPicked(c)
                      if (!newName.trim()) setNewName(c.fileName.replace(/\.xlsx$/i, ''))
                    }}
                    className={`px-2 py-1.5 border rounded-md cursor-pointer transition-colors ${active ? 'border-primary bg-primarySoft' : 'border-line bg-surfaceSubtle hover:border-primary'}`}
                  >
                    <div className="flex items-center gap-2">
                      <FileExcelOutlined className="text-xs text-inkMuted" />
                      <span className="text-xs text-ink flex-1 truncate">{c.fileName}</span>
                      <span className="text-[10px] text-inkMuted">{cols.length} 列</span>
                    </div>
                    <div className="text-[10px] text-inkMuted truncate mt-0.5">
                      {cols.slice(0, 10).map(x => x.key).join(' | ') || '未识别到表头'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div>
            <div className="text-xs text-inkMuted mb-1">格式名称</div>
            <Input
              placeholder="给它起个你能认出来的名字"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default FormatManagerView
