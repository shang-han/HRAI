import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm } from 'antd'
import { requestFillInput } from '../utils/fillInput'
import {
  ArrowLeftOutlined,
  PlusOutlined,
  SearchOutlined,
  FileTextOutlined,
  EditOutlined,
  DeleteOutlined
} from '@ant-design/icons'

interface Template {
  id: string
  name: string
  category: string
  content: string
  isBuiltin?: boolean
}

/**
 * 公共预设指令库管理页（替换右侧聊天区域整体显示）。
 * 业务导航条目按名称一一对应模板：点导航条目时填入对应模板内容。
 * 本页只做模板的浏览 / 新建 / 编辑 / 删除。
 */
const TemplateManagerView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [templates, setTemplates] = useState<Template[]>([])
  const [searchText, setSearchText] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', category: '', content: '' })

  const load = async () => {
    try {
      setTemplates(await window.electronAPI.template.list())
    } catch (err) {
      console.error('加载模板失败:', err)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = templates.filter(t =>
    t.name.toLowerCase().includes(searchText.toLowerCase()) ||
    t.category.toLowerCase().includes(searchText.toLowerCase())
  )

  const openCreate = () => {
    setEditingId(null)
    setForm({ name: '', category: '', content: '' })
    setModalOpen(true)
  }

  const openEdit = (t: Template) => {
    setEditingId(t.id)
    setForm({ name: t.name, category: t.category, content: t.content })
    setModalOpen(true)
  }

  const handleDelete = async (id: string) => {
    try {
      await window.electronAPI.template.delete(id)
      await load()
    } catch (err) {
      console.error('删除模板失败:', err)
    }
  }

  const handleSave = async () => {
    const name = form.name.trim()
    const content = form.content.trim()
    if (!name || !content) return
    try {
      if (editingId) {
        await window.electronAPI.template.update(editingId, {
          name,
          category: form.category.trim(),
          content
        })
      } else {
        await window.electronAPI.template.create({
          name,
          category: form.category.trim(),
          content,
          isBuiltin: false
        })
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      console.error('保存模板失败:', err)
    }
  }

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
        <span className="text-sm font-medium text-ink">公共预设指令库</span>
        <span className="text-xs text-inkMuted">{templates.length} 个模板</span>
        <div className="flex-1" />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建模板
        </Button>
      </div>

      {/* 列表区 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-3">
          <div className="text-sm text-inkMuted">
            点击模板条目可把指令内容填入输入框；悬停条目可用 ✏️ 编辑、🗑 删除。业务导航条目按名称与模板一一对应，修改模板内容即可调整对应条目的快捷指令。
          </div>

          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索模板名称 / 分类..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />

          {filtered.length === 0 ? (
            <div className="text-center text-sm text-inkMuted py-8">
              {templates.length === 0 ? '暂无模板，点右上角"新建模板"创建' : '没有匹配的模板'}
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map(t => (
                <div
                  key={t.id}
                  onClick={() => {
                    // 点击条目：把指令内容填入消息输入框并返回聊天
                    requestFillInput(t.content)
                    onBack()
                  }}
                  className="group flex items-center gap-2 px-3 py-2 border border-line rounded-md bg-surfaceSubtle dark:bg-canvas cursor-pointer hover:border-primary transition-colors"
                >
                  <FileTextOutlined className="text-sm text-inkMuted shrink-0" />
                  <span className="flex-1 truncate text-sm">{t.name}</span>
                  <span className="text-[10px] text-inkMuted shrink-0 max-w-[100px] truncate">
                    {t.category.split('/').pop() || t.category}
                  </span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      title="编辑"
                      onClick={e => { e.stopPropagation(); openEdit(t) }}
                      className="p-1 rounded hover:bg-surfaceSubtle dark:hover:bg-canvas text-xs text-inkSecondary"
                    >
                      <EditOutlined />
                    </button>
                    {!t.isBuiltin && (
                      <Popconfirm
                        title="删除该模板？"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDelete(t.id)}
                      >
                        <button
                          title="删除"
                          onClick={e => e.stopPropagation()}
                          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-xs text-red-500"
                        >
                          <DeleteOutlined />
                        </button>
                      </Popconfirm>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 新建/编辑弹窗 */}
      <Modal
        title={editingId ? '编辑模板' : '新建模板'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !form.name.trim() || !form.content.trim() }}
        destroyOnClose
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs text-inkMuted mb-1">模板名称（需与业务导航条目名称对应）</div>
            <Input
              placeholder="例如：招聘需求提报单"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">分类</div>
            <Input
              placeholder="例如：人力资源/招聘管理"
              value={form.category}
              onChange={e => setForm(prev => ({ ...prev, category: e.target.value }))}
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">指令内容（点击对应业务导航条目时填入输入框）</div>
            <Input.TextArea
              rows={5}
              placeholder="请输入完整的指令内容..."
              value={form.content}
              onChange={e => setForm(prev => ({ ...prev, content: e.target.value }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default TemplateManagerView
