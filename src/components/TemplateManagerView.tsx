import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Select } from 'antd'
import { requestFillInput } from '../utils/fillInput'
import { HR_MENU, MENU_CATEGORIES } from '../data/hr-menu'
import {
  ArrowLeftOutlined,
  PlusOutlined,
  SearchOutlined,
  FileTextOutlined,
  EditOutlined,
  DeleteOutlined,
  AppstoreOutlined,
  CaretRightOutlined,
  FolderOutlined,
  TeamOutlined,
  ApartmentOutlined
} from '@ant-design/icons'

interface Template {
  id: string
  name: string
  category: string
  content: string
  isBuiltin?: boolean
}

// 中心图标：与主菜单业务导航一致（数据里的名称自带 emoji，展示时替换为贴合场景的图标）
const CENTER_ICONS: Record<string, React.ReactNode> = {
  人力资源中心: <TeamOutlined />,
  行政综合中心: <ApartmentOutlined />
}

// 分类下拉：按中心分组，另加"未分类"
const CATEGORY_OPTIONS = [
  ...HR_MENU.map(c => ({
    label: c.name,
    options: c.modules.map(m => ({ label: m.name, value: `${c.key}/${m.name}` }))
  })),
  { label: '其他', options: [{ label: '未分类', value: '未分类' }] }
]

/**
 * 公共预设指令库管理页（替换右侧聊天区域整体显示）。
 * 左侧：中心→模块两级树（含"全部模板/未分类"）；右侧：所选模块的指令列表。
 * 指令与业务导航同源：在此修改模板内容，点击导航条目时同步生效。
 * readonly 模式（输入框入口）：只可点击填入输入框，隐藏新建/编辑/删除。
 */
const TemplateManagerView: React.FC<{ onBack: () => void; readonly?: boolean }> = ({ onBack, readonly = false }) => {
  const [templates, setTemplates] = useState<Template[]>([])
  const [searchText, setSearchText] = useState('')
  // 选中的范围：all=全部，uncat=未分类，其余为"中心key/模块名"
  const [selectedKey, setSelectedKey] = useState('all')
  const [expandedCenters, setExpandedCenters] = useState<Record<string, boolean>>(
    () => Object.fromEntries(HR_MENU.map((c, i) => [c.key, i === 0]))
  )
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', category: '未分类', content: '' })

  const load = async () => {
    try {
      setTemplates(await window.electronAPI.template.list())
    } catch (err) {
      console.error('加载模板失败:', err)
    }
  }

  useEffect(() => { load() }, [])

  // 当前显示范围的模板：搜索非空时全局匹配，否则按选中模块过滤
  const visible = templates.filter(t => {
    if (searchText.trim()) {
      const q = searchText.toLowerCase()
      return t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
    }
    if (selectedKey === 'all') return true
    if (selectedKey === 'uncat') return !MENU_CATEGORIES.includes(t.category)
    return t.category === selectedKey
  })

  const categoryPath = (cKey: string, mName: string) => `${cKey}/${mName}`
  const moduleCount = (cKey: string, mName: string) =>
    templates.filter(t => t.category === categoryPath(cKey, mName)).length
  const uncatCount = templates.filter(t => !MENU_CATEGORIES.includes(t.category)).length

  const openCreate = () => {
    setEditingId(null)
    setForm({ name: '', category: selectedKey === 'all' || selectedKey === 'uncat' ? '未分类' : selectedKey, content: '' })
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
          category: form.category,
          content
        })
      } else {
        await window.electronAPI.template.create({
          name,
          category: form.category,
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
    <div className="hermes-chat-canvas flex-1 min-h-0 flex flex-col overflow-hidden">
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
        {!readonly && (
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建模板
          </Button>
        )}
      </div>

      {/* 主体：左侧分类树 + 右侧列表 */}
      <div className="flex-1 min-h-0 flex">
        {/* 左侧树 */}
        <aside className="w-80 shrink-0 border-r border-line overflow-y-auto p-2 space-y-0.5">
          <div
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm ${selectedKey === 'all' ? 'bg-primarySoft text-primary font-medium' : 'text-inkSecondary hover:bg-surfaceSubtle dark:hover:bg-canvas'}`}
            onClick={() => setSelectedKey('all')}
          >
            <AppstoreOutlined className="text-xs" />
            <span className="flex-1 truncate">全部模板</span>
            <span className="text-[10px] text-inkMuted">{templates.length}</span>
          </div>

          {HR_MENU.map(c => {
            const open = expandedCenters[c.key] ?? false
            return (
              <div key={c.key}>
                <div
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-sm font-medium text-ink hover:bg-surfaceSubtle dark:hover:bg-canvas"
                  onClick={() => setExpandedCenters(prev => ({ ...prev, [c.key]: !open }))}
                >
                  <CaretRightOutlined className={`text-[10px] transition-transform duration-300 ${open ? 'rotate-90' : 'rotate-0'}`} />
                  {CENTER_ICONS[c.key]}
                  <span className="flex-1 truncate">{c.name.split(/\s+/).slice(1).join(' ') || c.name}</span>
                </div>
                <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                  <div className="overflow-hidden min-h-0">
                    {c.modules.map(m => {
                      const key = categoryPath(c.key, m.name)
                      const active = selectedKey === key
                      return (
                        <div
                          key={key}
                          className={`flex items-center gap-2 pl-6 pr-2 py-1.5 rounded-md cursor-pointer text-sm ${active ? 'bg-primarySoft text-primary font-medium' : 'text-inkMuted hover:bg-surfaceSubtle dark:hover:bg-canvas hover:text-inkSecondary'}`}
                          onClick={() => setSelectedKey(key)}
                        >
                          <FolderOutlined className="text-xs shrink-0" />
                          <span className="flex-1 truncate">{m.name}</span>
                          <span className="text-[10px] text-inkMuted">{moduleCount(c.key, m.name)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}

          <div
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm ${selectedKey === 'uncat' ? 'bg-primarySoft text-primary font-medium' : 'text-inkSecondary hover:bg-surfaceSubtle dark:hover:bg-canvas'}`}
            onClick={() => setSelectedKey('uncat')}
          >
            <FolderOutlined className="text-xs" />
            <span className="flex-1 truncate">未分类</span>
            <span className="text-[10px] text-inkMuted">{uncatCount}</span>
          </div>
        </aside>

        {/* 右侧列表 */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="px-5 pt-4 pb-2 shrink-0">
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索模板名称 / 分类..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              allowClear
            />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-6">
            <div className="text-xs text-inkMuted mb-3">
              {readonly
                ? '点击条目可把指令内容填入输入框。如需新建或编辑模板，请从左侧栏「公共预设指令库」进入。'
                : (
                  <>
                    点击条目可直接编辑；悬停可用 <EditOutlined className="text-xs" /> 编辑、<DeleteOutlined className="text-xs" /> 删除。此处修改的模板内容会同步到左侧业务导航的同名条目。
                  </>
                )}
            </div>
            {visible.length === 0 ? (
              <div className="text-center text-sm text-inkMuted py-8">
                {templates.length === 0 ? '暂无模板，点右上角"新建模板"创建' : '没有匹配的模板'}
              </div>
            ) : (
              <div className="space-y-1">
                {visible.map(t => (
                  <div
                    key={t.id}
                    onClick={() => {
                      // 只读（输入框入口）：点击把指令填入输入框并返回聊天；
                      // 完整管理模式（主菜单入口）：点击直接进入编辑弹框，不跳回聊天
                      if (readonly) {
                        requestFillInput(t.content)
                        onBack()
                      } else {
                        openEdit(t)
                      }
                    }}
                    className="group flex items-center gap-2 px-3 py-2 border border-line rounded-md bg-surfaceSubtle dark:bg-canvas cursor-pointer hover:border-primary transition-colors"
                  >
                    <FileTextOutlined className="text-sm text-inkMuted shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-sm">{t.name}</span>
                    <span className="text-[10px] text-inkMuted shrink-0 max-w-[140px] truncate">
                      {t.category.split('/').pop() || t.category}
                    </span>
                    {!readonly && (
                      // 阻断冒泡：按钮区（含 Popconfirm 确认弹层）的点击
                      // 不得触发行 onClick（填入指令 + 返回聊天）
                      <div
                        className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
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
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
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
            <div className="text-xs text-inkMuted mb-1">模板名称（与业务导航条目名称一致时，修改内容会同步生效）</div>
            <Input
              placeholder="例如：岗位需求审批"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">所属模块</div>
            <Select
              className="w-full"
              placeholder="选择归属模块"
              value={form.category}
              onChange={v => setForm(prev => ({ ...prev, category: v }))}
              options={CATEGORY_OPTIONS}
              showSearch
              optionFilterProp="label"
            />
          </div>
          <div>
            <div className="text-xs text-inkMuted mb-1">指令内容（点击模板或对应导航条目时填入输入框）</div>
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
