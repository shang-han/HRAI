import React, { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useConfigStore } from '../store/configStore'
import { HR_MENU } from '../data/hr-menu'
import SchedulePanel from './SchedulePanel'
import { Modal, Input, Button } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  SearchOutlined,
  MessageOutlined,
  BookOutlined,
  ApartmentOutlined,
  StarOutlined,
  LeftOutlined,
  RightOutlined,
  CaretDownOutlined,
  CaretRightOutlined
} from '@ant-design/icons'

const Sidebar: React.FC<{ onOpenWork: () => void; onOpenTemplates: () => void }> = ({ onOpenWork, onOpenTemplates }) => {
  const { sessions, activeSessionId, createSession, deleteSession, switchSession, renameSession } = useSessionStore()
  const { layout, toggleSidebar } = useConfigStore()
  const [searchText, setSearchText] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState({
    sessions: true,
    workPriority: true,
    businessNav: false,
    presets: false,
    templates: false
  })
  // 业务导航树：一级（中心）与二级（模块）的展开状态，默认只展开第一个中心
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({})
  const collapsed = layout.sidebarCollapsed
  const activeSession = sessions.find(s => s.id === activeSessionId)

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key as keyof typeof prev] }))
  }

  const handleDeleteSession = async (id: string) => {
    await deleteSession(id)
    setDeleteConfirm(null)
  }

  const handleRename = async (id: string) => {
    if (renameValue.trim()) {
      await renameSession(id, renameValue.trim())
    }
    setRenaming(null)
    setRenameValue('')
  }

  // 业务导航数据：与公共预设指令库同源（src/data/hr-menu.ts），
  // 改动菜单结构只需维护那份数据文件
  const businessNav = HR_MENU

  if (collapsed) {
    return (
      <aside className="w-12 bg-surface border-r border-line flex flex-col items-center py-3 gap-3 transition-all duration-300">
        <button onClick={toggleSidebar} title="展开侧边栏" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
          <RightOutlined />
        </button>
        <button onClick={() => createSession()} title="新建会话" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
          <PlusOutlined />
        </button>
      </aside>
    )
  }

  return (
    <aside className="w-[340px] bg-surface border-r border-line flex-shrink-0 flex flex-col transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl">
      {/* 头部 */}
      <div className="p-4 flex justify-between items-center">
        <div>
          <h1 className="font-bold text-xl text-primary">Hermes HR智脑</h1>
        </div>
        <button onClick={toggleSidebar} title="收起侧边栏" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas hidden md:block">
          <LeftOutlined />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-2">
        {/* 会话列表 */}
        <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
          <div onClick={() => toggleSection('sessions')} className="p-3 bg-primarySoft flex justify-between items-center cursor-pointer">
            <span><MessageOutlined /> 会话列表</span>
            <div className="flex items-center gap-2">
              <button
                title="新建会话"
                onClick={e => { e.stopPropagation(); createSession() }}
                className="p-1 rounded hover:bg-canvas text-sm leading-none"
              >
                <PlusOutlined />
              </button>
              <span className="text-xs">
                <CaretRightOutlined className={`transition-transform duration-300 ${expandedSections.sessions ? 'rotate-90' : 'rotate-0'}`} />
              </span>
            </div>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expandedSections.sessions ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden min-h-0">
            <div className="p-2 space-y-1">
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索会话..."
                size="middle"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="mb-2"
              />
              {sessions
                .filter(s => s.name.toLowerCase().includes(searchText.toLowerCase()))
                .length > 0 && (
                <div className="space-y-1 max-h-[200px] overflow-y-auto pr-0.5">
                {sessions
                .filter(s => s.name.toLowerCase().includes(searchText.toLowerCase()))
                .map(session => (
                  <div
                    key={session.id}
                    className={`flex items-center gap-1 p-1.5 rounded-lg cursor-pointer group ${
                      activeSessionId === session.id
                        ? 'bg-primarySoft text-primary'
                        : 'hover:bg-canvas'
                    }`}
                    onClick={() => switchSession(session.id)}
                  >
                    <span className="flex-1 truncate text-sm">{session.name}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); setRenaming(session.id); setRenameValue(session.name) }}
                        className="p-1 rounded hover:bg-canvas text-xs"
                      >
                        <EditOutlined />
                      </button>
                      {session.isDefault ? (
                        <span
                          title="默认会话不可删除"
                          className="p-1 text-xs text-inkMuted"
                        >
                          <LockOutlined />
                        </span>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteConfirm(session.id) }}
                          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-xs text-red-500"
                        >
                          <DeleteOutlined />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                </div>
              )}
            </div>
            </div>
          </div>
        </div>

        <SchedulePanel />

        {/* 近期重点工作 */}
        <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
          <div onClick={() => toggleSection('workPriority')} className="p-3 bg-primarySoft flex justify-between cursor-pointer">
            <span><BookOutlined /> 近期重点工作</span>
            <span className="text-xs"><CaretRightOutlined className={`transition-transform duration-300 ${expandedSections.workPriority ? 'rotate-90' : 'rotate-0'}`} /></span>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expandedSections.workPriority ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden min-h-0">
            <div
              className="p-2 cursor-pointer hover:bg-canvas transition-colors"
              onClick={onOpenWork}
              title="点击进入重点工作编辑页"
            >
              {activeSession?.workPriority ? (
                <div>
                  <div className="text-sm font-medium truncate">{activeSession.workPriority.title || '未命名重点工作'}</div>
                  <div className="text-xs text-inkMuted truncate mt-0.5">
                    {activeSession.workPriority.background || '（无背景描述）'}
                  </div>
                </div>
              ) : (
                <div className="text-center py-3">
                  <div className="text-xs text-inkMuted">未设置重点工作，AI 输出将使用通用背景</div>
                  <div className="text-xs text-primary mt-1">点击设置 →</div>
                </div>
              )}
            </div>
            </div>
          </div>
        </div>

        {/* 业务导航 */}
        <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
          <div onClick={() => toggleSection('businessNav')} className="p-3 bg-primarySoft flex justify-between cursor-pointer">
            <span><ApartmentOutlined /> 人事-行政业务导航</span>
            <span className="text-xs"><CaretRightOutlined className={`transition-transform duration-300 ${expandedSections.businessNav ? 'rotate-90' : 'rotate-0'}`} /></span>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expandedSections.businessNav ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden min-h-0">
            <div className="p-2">
              {businessNav.map((category, ci) => {
                const catOpen = expandedCategories[category.name] ?? (ci === 0)
                return (
                  <div key={ci}>
                    {/* 一级：中心 */}
                    <div
                      className="flex items-center justify-between gap-1 font-semibold text-accent mt-2 mb-1 pl-2 pr-1 py-1 text-sm rounded-md cursor-pointer hover:bg-primarySoft"
                      onClick={() => setExpandedCategories(prev => ({ ...prev, [category.name]: !catOpen }))}
                    >
                      <span className="truncate">{category.name}</span>
                      <CaretRightOutlined className={`shrink-0 text-xs transition-transform duration-300 ${catOpen ? 'rotate-90' : 'rotate-0'}`} />
                    </div>
                    {/* 二级：模块 */}
                    <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${catOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden min-h-0">
                        {category.modules.map((module, mi) => {
                          const modOpen = expandedModules[module.name] ?? false
                          return (
                            <div key={mi}>
                              <div
                                className="flex items-center justify-between gap-1 text-sm font-medium text-inkSecondary py-1 pl-4 pr-1 rounded-md cursor-pointer hover:bg-primarySoft"
                                onClick={() => setExpandedModules(prev => ({ ...prev, [module.name]: !modOpen }))}
                              >
                                <span className="truncate">{module.name}</span>
                                <CaretRightOutlined className={`shrink-0 text-xs transition-transform duration-300 ${modOpen ? 'rotate-90' : 'rotate-0'}`} />
                              </div>
                              {/* 三级：业务指令项 */}
                              <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${modOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                                <div className="overflow-hidden min-h-0">
                                  {module.leaves.map((item, ii) => (
                                    <div
                                      key={ii}
                                      className="text-sm py-1 pl-8 pr-2 rounded-md hover:bg-primarySoft cursor-pointer transition-all text-inkMuted hover:text-primary"
                                      onClick={async () => {
                                        // 优先取指令库中同分类同名模板内容（在指令库编辑后导航同步生效），
                                        // 否则用内置提示词
                                        let text = item.prompt
                                        try {
                                          const tpls: any[] = await window.electronAPI.template.list()
                                          const tpl = tpls.find((t: any) =>
                                            t.name === item.name && t.category === `${category.key}/${module.name}`
                                          )
                                          if (tpl?.content) text = tpl.content
                                        } catch { /* 模板加载失败时用内置提示词 */ }
                                        const event = new CustomEvent('fillPrompt', {
                                          detail: { text, intent: { hint: item.name } }
                                        })
                                        window.dispatchEvent(event)
                                      }}
                                    >
                                      {item.name}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            </div>
          </div>
        </div>

        {/* 公共预设指令库：点击整行直接右侧打开（无展开收起） */}
        <div
          className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle cursor-pointer hover:bg-primarySoft transition-colors"
          onClick={onOpenTemplates}
          title="在右侧打开预设指令库管理页"
        >
          <div className="p-3 bg-primarySoft flex justify-between items-center">
            <span><StarOutlined /> 公共预设指令库</span>
          </div>
        </div>
      </div>

      {/* 删除确认弹窗 */}
      <Modal
        title="确认删除会话"
        open={!!deleteConfirm}
        onOk={() => deleteConfirm && handleDeleteSession(deleteConfirm)}
        onCancel={() => setDeleteConfirm(null)}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <p>确认删除该会话？聊天记录将会永久清除，无法恢复。</p>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal
        title="重命名会话"
        open={!!renaming}
        onOk={() => renaming && handleRename(renaming)}
        onCancel={() => { setRenaming(null); setRenameValue('') }}
        okText="确认"
        cancelText="取消"
      >
        <Input value={renameValue} onChange={e => setRenameValue(e.target.value)} />
      </Modal>
    </aside>
  )
}

export default Sidebar
