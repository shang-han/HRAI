import React, { useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { HR_MENU } from '../data/hr-menu'
import {
  useConfigStore,
  SIDEBAR_MIN_W,
  SIDEBAR_MAX_W,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_COLLAPSED_W
} from '../store/configStore'
import SchedulePanel from './SchedulePanel'
import SessionWorkDirModal, { workDirLabel } from './SessionWorkDirModal'
import { Modal, Input, Button, Tooltip } from 'antd'
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
  FolderOutlined,
  CaretDownOutlined,
  CaretRightOutlined
} from '@ant-design/icons'

const Sidebar: React.FC<{ onOpenWork: () => void; onOpenTemplates: () => void }> = ({ onOpenWork, onOpenTemplates }) => {
  const { sessions, activeSessionId, createSession, deleteSession, switchSession, renameSession } = useSessionStore()
  const { layout, toggleSidebar, setSidebarWidth } = useConfigStore()
  const [searchText, setSearchText] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
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

  const asideRef = useRef<HTMLElement>(null)
  const [resizing, setResizing] = useState(false)

  // 拖动调整侧边栏宽度。
  //
  // 1) 拖动过程中直接写 DOM style，不经过 React state：侧边栏里业务导航树是
  //    上百个常驻节点（收起的层级只是 grid-rows-[0fr] 藏起来，DOM 仍在），
  //    每次 move 都触发重渲染会明显掉帧。松手时才提交到 store 并落盘。
  //    这里"绕过 React"是安全的：pointerup 一定会把最终值写进 store，
  //    之后 store 值与 DOM 值一致，React 后续渲染不会把宽度拽回去。
  // 2) 用 Pointer Events + setPointerCapture，而不是在 window 上挂
  //    mousemove/mouseup：这个手柄天生就是往窗口边缘拖的，鼠标在窗口外松开时
  //    mouseup 根本不会派发到页面，拖动状态会一直卡着——等指针再回到窗口，
  //    没按键也跟着走。指针捕获能保证 up/cancel 一定回到手柄自己身上。
  const startResizeWidth = (e: React.PointerEvent<HTMLDivElement>) => {
    // 刻意不调 e.preventDefault()：在 pointerdown 上 preventDefault 会不会连带
    // 吞掉后续的 dblclick，各版本 Chromium 行为不一致，而双击是"恢复默认宽度"
    // 的入口。文本选择改由 .hermes-sidebar-resizer 的 user-select: none
    // 与拖动期间 body 上的全局禁选负责，不需要 preventDefault。
    const el = asideRef.current
    if (!el) return
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startWidth = el.getBoundingClientRect().width
    let next = startWidth

    handle.setPointerCapture(pointerId)
    setResizing(true)
    document.body.classList.add('hermes-col-resizing')

    const onMove = (ev: PointerEvent) => {
      // 上限除了固定的 SIDEBAR_MAX_W，还要受当前窗口宽度约束：
      // 给右侧聊天区至少留 420px，否则窄窗口下能把聊天区挤到没法用。
      // 外层再套一次 max(MIN, ...)：窗口极窄时 innerWidth-420 可能小于下限，
      // 那样 upper < MIN，clamp 会算出比下限还小的值。
      const upper = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, window.innerWidth - 420))
      next = Math.min(upper, Math.max(SIDEBAR_MIN_W, startWidth + ev.clientX - startX))
      el.style.width = `${next}px`
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      // pointerup 时浏览器已隐式释放捕获，直接 release 会抛 NotFoundError
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      document.body.classList.remove('hermes-col-resizing')
      setResizing(false)
      // 只有真的拖动过才落盘。单纯点一下手柄、或双击（双击会先派发两次
      // pointerdown/up）都不该产生写操作，否则一次双击要写三遍配置文件。
      if (next !== startWidth) setSidebarWidth(next, true)
    }
    // 捕获期间 move/up 都派发到捕获元素本身，所以监听挂在手柄上而非 window
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  // 双击手柄恢复默认宽度（和输入框那个高度手柄一致的交互）
  const resetWidth = () => {
    const el = asideRef.current
    if (el) el.style.width = `${SIDEBAR_DEFAULT_W}px`
    setSidebarWidth(SIDEBAR_DEFAULT_W, true)
  }

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

  // 新建会话统一走弹窗（名称 + 工作目录），两个 "+" 入口都指向这里。
  // 名称留空时交给主进程按 `会话 N` 生成，不在前端重复那套编号逻辑。
  const handleCreateSession = async (name: string, workDir: string) => {
    await createSession(name || undefined, workDir)
    setNewSessionOpen(false)
  }

  // 业务导航数据：与公共预设指令库同源（src/data/hr-menu.ts），
  // 改动菜单结构只需维护那份数据文件
  const businessNav = HR_MENU

  // 新建会话弹窗在收起态也要能弹出来（收起态的 "+" 是唯一入口），
  // 所以两个分支各自渲染一次，而不是只挂在展开态那棵树上
  const newSessionModal = (
    <SessionWorkDirModal
      open={newSessionOpen}
      mode="create"
      initialName={`会话 ${sessions.length + 1}`}
      onCancel={() => setNewSessionOpen(false)}
      onSubmit={handleCreateSession}
    />
  )

  if (collapsed) {
    return (
      <>
        <aside
          ref={asideRef}
          style={{ width: SIDEBAR_COLLAPSED_W }}
          className="hermes-sidebar bg-surface border-r border-line flex-shrink-0 flex flex-col items-center py-3 gap-3 transition-all duration-300"
        >
          <button onClick={toggleSidebar} title="展开侧边栏" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
            <RightOutlined />
          </button>
          <button onClick={() => setNewSessionOpen(true)} title="新建会话" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
            <PlusOutlined />
          </button>
        </aside>
        {newSessionModal}
      </>
    )
  }

  return (
    <aside
      ref={asideRef}
      style={{ width: layout.sidebarWidth }}
      className={`hermes-sidebar relative bg-surface border-r border-line flex-shrink-0 flex flex-col transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl ${resizing ? 'is-resizing' : ''}`}
    >
      {/* 宽度拖拽手柄：贴右边界，悬停/拖动亮出主色竖线，双击恢复默认宽度 */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整侧边栏宽度（双击恢复默认）"
        className={`hermes-sidebar-resizer ${resizing ? 'is-resizing' : ''}`}
        onPointerDown={startResizeWidth}
        onDoubleClick={resetWidth}
      />
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
                onClick={e => { e.stopPropagation(); setNewSessionOpen(true) }}
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
                    {/* 只有自选了工作目录的会话才显示第二行：用内置工作区的会话
                        （绝大多数）保持单行，自选目录才作为差异被标出来 */}
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm">{session.name}</div>
                      {session.workDir && (
                        <Tooltip title={`工作目录：${session.workDir}`}>
                          <div className="flex items-center gap-1 text-xs text-inkMuted truncate">
                            <FolderOutlined className="shrink-0" />
                            <span className="truncate">{workDirLabel(session.workDir)}</span>
                          </div>
                        </Tooltip>
                      )}
                    </div>
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

      {newSessionModal}
    </aside>
  )
}

export default Sidebar
