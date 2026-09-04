import React, { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { HR_MENU } from '../data/hr-menu'
import {
  useConfigStore,
  SIDEBAR_MIN_W,
  SIDEBAR_MAX_W,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_COLLAPSED_W
} from '../store/configStore'
import { workDirLabel } from './SessionWorkDirModal'
import { Modal, Input, Button, Tooltip } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  SearchOutlined,
  MessageOutlined,
  BellOutlined,
  StarOutlined,
  LeftOutlined,
  RightOutlined,
  FolderOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  SettingOutlined,
  TeamOutlined,
  ApartmentOutlined,
  FileExcelOutlined
} from '@ant-design/icons'

// 丝滑斜分界（参考 WorkBuddy/s-divider.html 调参台）：
// 分界线由两段三次贝塞尔拼成，但所有控制点的 x 都锁定在中线 xm 上 → 曲线严格单调推进，
// 不过冲、无鼓包；交接点前后两个控制点与交接点共线，C1 连续，无拼接痕迹、无折角。
//
// 形状参数（调参台定下的值，要微调观感只改这五个）：
const TAB_DIV_SKEW = 30 // 首尾横向错位总量（px）
const TAB_DIV_FLAT = 0.55 // 中间平直段占比：越大中间越接近垂直
const TAB_DIV_POS = 0.5 // 分界位置（0.5 = 正中）
const TAB_DIV_MORPH_MS = 600 // tab 切换时色块滑过去的时长
const TAB_DIV_LOW_EXTEND = 1.55 // 竖直段下延系数：下段贴合区是上段的 1.55 倍 → 竖线更长、弯钩更靠下
//
// 尺寸必须是「实测值」而不是写死的常量：侧边栏默认宽 340（可拖 240~560），
// 若 viewBox 写死 460，preserveAspectRatio="none" 会把曲线横向压到 74%
// 而高度不变 —— 非等比压缩，观感会比调参台陡得多，且拖动时比例一直在变。
// 所以下面 viewBox 用 ResizeObserver 实测的宽高，1:1 渲染，不做任何缩放。
const r2 = (v: number) => Math.round(v * 100) / 100

const buildTabDiv = (W: number, H: number) => {
  const skew = TAB_DIV_SKEW
  const xm = W * TAB_DIV_POS
  const x0 = xm - skew / 2
  const x1 = xm + skew / 2
  const yMid = H / 2
  // 上下贴合区不再对称：下段按 LOW_EXTEND 拉长 → 中间竖直段整体向下延展
  const gapUp = H * (0.02 + 0.43 * TAB_DIV_FLAT)
  const gapDn = gapUp * TAB_DIV_LOW_EXTEND
  const c1y = (yMid - gapUp) * 0.45
  const c2y = yMid + gapDn + (H - yMid - gapDn) * 0.55
  const segUp = `C ${r2(xm)} ${r2(c1y)}, ${r2(xm)} ${r2(yMid - gapUp)}, ${r2(xm)} ${r2(yMid)}`
  const segDn = `C ${r2(xm)} ${r2(yMid + gapDn)}, ${r2(x1)} ${r2(c2y)}, ${r2(x1)} ${r2(H)}`
  // 右侧选中时整条曲线镜像（x → W-x）：中线 xm 不动，只有下段的终点/控制点换侧
  const segDnMir = `C ${r2(xm)} ${r2(yMid + gapDn)}, ${r2(W - x1)} ${r2(c2y)}, ${r2(W - x1)} ${r2(H)}`
  return {
    // 两条路径命令结构严格一致（M L C C L Z），CSS 的 d 属性才能插值出切换动画
    left: `M 0 0 L ${r2(x0)} 0 ${segUp} ${segDn} L 0 ${r2(H)} Z`,
    right: `M ${r2(W)} 0 L ${r2(W - x0)} 0 ${segUp} ${segDnMir} L ${r2(W)} ${r2(H)} Z`
  }
}

const Sidebar: React.FC<{ onOpenTemplates: () => void; onOpenSchedules: () => void; onOpenFormats: () => void }> = ({ onOpenTemplates, onOpenSchedules, onOpenFormats }) => {
  const { sessions, activeSessionId, startDraftSession, deleteSession, switchSession, renameSession } = useSessionStore()
  const { layout, toggleSidebar, setSidebarWidth } = useConfigStore()
  const [searchText, setSearchText] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState({
    sessions: true,
    presets: false,
    templates: false
  })
  // 业务导航：中心是切换 tab（只展示当前中心），模块仍可展开收起
  const [activeNavTab, setActiveNavTab] = useState<string>(HR_MENU[0]?.key || '')
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({})
  // 三级指令项：记住最近点击的项（点击后保持选中态，跨 tab 互不干扰）；悬停同样显示选中色
  const [activeLeafKey, setActiveLeafKey] = useState<string | null>(null)
  const collapsed = layout.sidebarCollapsed
  const activeSession = sessions.find(s => s.id === activeSessionId)

  const asideRef = useRef<HTMLElement>(null)
  const [resizing, setResizing] = useState(false)

  // 分界色块的实测尺寸：viewBox 用它做 1:1 渲染，避免固定 viewBox 被非等比拉伸。
  // 拖动侧边栏时宽度连续变化，这里跟着更新，曲线始终按真实像素绘制。
  const tabsRef = useRef<HTMLDivElement>(null)
  const [tabsSize, setTabsSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      // 首帧宽度可能为 0（侧边栏收起/未布局），为 0 时不生成路径，
      // 免得 buildTabDiv(0, 0) 算出一条退化曲线
      if (r.width > 0 && r.height > 0) setTabsSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

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

  // 业务导航数据：与公共预设指令库同源（src/data/hr-menu.ts），
  // 改动菜单结构只需维护那份数据文件
  const businessNav = HR_MENU
  // 中心切换按钮图标：数据里的名称自带 emoji（📘/📙），展示时换为贴合业务场景的图标
  const CENTER_ICONS: Record<string, React.ReactNode> = {
    人力资源中心: <TeamOutlined />,
    行政综合中心: <ApartmentOutlined />
  }

  // 底部固定「设置」入口：点击直接打开统一设置面板（TopBar 监听 open-settings 事件），
  // 页面切换在面板左侧导航里进行
  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('open-settings'))
  }

  // 新建会话：不弹窗、不落库，直接进入右侧空聊天页（草稿会话），
  // 第一条消息发出后会话列表才出现新条目
  const startDraft = () => {
    startDraftSession()
  }

  if (collapsed) {
    return (
      <aside
        ref={asideRef}
        style={{ width: SIDEBAR_COLLAPSED_W }}
        className="hermes-sidebar bg-surface border-r border-line flex-shrink-0 flex flex-col items-center py-3 gap-3 transition-all duration-300"
      >
        <button onClick={toggleSidebar} title="展开侧边栏" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
          <RightOutlined />
        </button>
        <button onClick={startDraft} title="新建会话" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
          <PlusOutlined />
        </button>
        <button onClick={openSettings} title="设置" className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
          <SettingOutlined />
        </button>
      </aside>
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
        <div className="border border-line rounded-xl overflow-hidden">
          <div onClick={() => toggleSection('sessions')} className="p-3 bg-primarySoft flex justify-between items-center cursor-pointer">
            <span><MessageOutlined /> 会话列表</span>
            <div className="flex items-center gap-2">
              <button
                title="新建会话"
                onClick={e => { e.stopPropagation(); startDraft() }}
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

        {/* 业务导航：与其他菜单目录一致，标题行为主题色浅底；
            下方一级菜单切换中心，点击哪个 tab 展示哪个中心底下的内容，无整体收起。
            内容区不加灰色底：展开后的模块/指令项直接落在侧边栏背景上（边框保留） */}
        <div className="border border-line rounded-xl overflow-hidden">
          {/* 标题行 tab（参考 WorkBuddy/s-divider.html）：丝滑斜分界 —— 不加描边线，
              分界本身由两个填充区域相切形成：选中中心主题浅紫、另一侧白底；
              单条贝塞尔斜 S（无凸起、无拼接痕），切换时区域镜像移动到另一侧 */}
          <div ref={tabsRef} className="flex bg-surface relative">
            {businessNav.map(category => {
              const active = activeNavTab === category.key
              return (
                <button
                  key={category.key}
                  onClick={() => setActiveNavTab(category.key)}
                  className={`relative z-10 flex-1 flex items-center justify-center gap-1 text-sm py-3 px-1 transition-colors duration-200 ${
                    active
                      ? 'text-primary font-semibold'
                      : 'text-inkMuted hover:text-inkSecondary'
                  }`}
                >
                  {CENTER_ICONS[category.key]}
                  <span className="truncate">{category.name.split(/\s+/).slice(1).join(' ') || category.name}</span>
                </button>
              )
            })}
            {tabsSize.w > 0 && tabsSize.h > 0 && (() => {
              const div = buildTabDiv(tabsSize.w, tabsSize.h)
              const p = activeNavTab === businessNav[0]?.key ? div.left : div.right
              return (
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  viewBox={`0 0 ${r2(tabsSize.w)} ${r2(tabsSize.h)}`}
                  preserveAspectRatio="none"
                >
                  {/* 切换动画：左右两条路径命令结构一致（M L C C L Z），CSS d 属性可插值，
                      切换时紫块区域直接 morph 滑向另一侧（慢速 ease-in-out）。
                      拖动侧边栏时必须关掉过渡：宽度连续变化会让 d 不停被插值，
                      曲线会拖在容器后面"追不上"，产生橡皮筋般的滞后感。 */}
                  <path
                    d={p}
                    fill="var(--color-primary-soft)"
                    style={{
                      d: `path("${p}")`,
                      transition: resizing ? 'none' : `d ${TAB_DIV_MORPH_MS}ms ease-in-out`
                    }}
                  />
                </svg>
              )
            })()}
          </div>
          <div className="p-2">
            {businessNav.filter(c => c.key === activeNavTab).map(category => (
              <div key={category.key}>
                {category.modules.map((module, mi) => {
                    const modOpen = expandedModules[module.name] ?? false
                    // 模块名自带编号（如 "1.1 招聘管理"）：拆分出徽章数字与显示名
                    const [modNum, ...modNameParts] = module.name.split(/\s+/)
                    const modName = modNameParts.join(' ') || module.name
                    return (
                      <div key={mi}>
                        {/* 二级：模块（编号徽章 + 名称 + 条目数，点击整行展开/收起） */}
                        <div
                          className="flex items-center gap-2 py-2 -ml-2 pr-1.5 rounded-md cursor-pointer hover:bg-canvas"
                          onClick={() => setExpandedModules(prev => ({ ...prev, [module.name]: !modOpen }))}
                          title={modOpen ? '收起' : '展开'}
                        >
                          {/* 定位条：展开时显示，紧贴卡片左边框 */}
                          <span className={`self-stretch w-1 rounded-full bg-primary transition-opacity duration-200 ${modOpen ? 'opacity-100' : 'opacity-0'}`} />
                          <span className={`shrink-0 min-w-[2rem] text-center text-[11px] font-semibold leading-4 py-0.5 px-1 rounded-md transition-colors ${
                            modOpen ? 'text-white bg-primary' : 'text-primary bg-primarySoft'
                          }`}>
                            {modNum}
                          </span>
                          <span className="flex-1 truncate text-sm font-semibold text-ink">{modName}</span>
                          <span className="shrink-0 text-[10px] font-medium leading-4 py-0.5 px-1.5 text-primary bg-primarySoft rounded-full">
                            {module.leaves.length}
                          </span>
                        </div>
                        {/* 三级：业务指令项 */}
                        <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${modOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                          <div className="overflow-hidden min-h-0">
                            {/* 三级：导引竖线 + 圆点 + 名称，鼠标覆盖即显示选中色 */}
                            <div className="relative ml-3.5 pl-2">
                              {/* 导引竖线：主色渐到背景色（浅色主题下即白色） */}
                              <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-[linear-gradient(180deg,var(--color-primary),var(--color-surface))]" />
                              {module.leaves.map((item, ii) => {
                                const leafKey = `${category.key}/${module.name}/${item.name}`
                                const leafActive = activeLeafKey === leafKey
                                return (
                                  <div
                                    key={ii}
                                    className={`group flex items-center gap-2 text-sm py-1.5 px-2 rounded-md cursor-pointer transition-colors ${
                                      leafActive ? 'bg-primarySoft' : 'hover:bg-primarySoft'
                                    }`}
                                    onClick={async () => {
                                      setActiveLeafKey(leafKey)
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
                                    <span className={`shrink-0 h-1.5 w-1.5 rounded-full transition-all ${leafActive ? 'h-2 w-2 bg-primary' : 'bg-line group-hover:h-2 group-hover:w-2 group-hover:bg-primary'}`} />
                                    <span className={`truncate transition-colors ${leafActive ? 'text-primary font-medium' : 'text-inkSecondary group-hover:text-primary'}`}>
                                      {item.name}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
          </div>
        </div>

        {/* 定时提醒/任务：点击整行直接右侧打开（无展开收起），与公共预设指令库同模式 */}
        <div
          className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle cursor-pointer hover:bg-primarySoft transition-colors"
          onClick={onOpenSchedules}
          title="在右侧打开定时提醒/任务管理页"
        >
          <div className="p-3 bg-primarySoft flex justify-between items-center">
            <span><BellOutlined /> 定时提醒/任务</span>
          </div>
        </div>

        {/* 我的格式：点击整行直接右侧打开（无展开收起） */}
        <div
          className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle cursor-pointer hover:bg-primarySoft transition-colors"
          onClick={onOpenFormats}
          title="在右侧打开「我的格式」管理页（P2 结构复用：xlsx 的列顺序/类型/公式/口径）"
        >
          <div className="p-3 bg-primarySoft flex justify-between items-center">
            <span><FileExcelOutlined /> 我的格式</span>
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

      {/* 底部固定「设置」入口：点击直接打开统一设置面板 */}
      <div className="shrink-0 p-2">
        <button
          onClick={openSettings}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-inkSecondary hover:bg-primarySoft hover:text-primary transition-colors"
        >
          <SettingOutlined />
          <span>设置</span>
        </button>
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
