import React, { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useConfigStore } from '../store/configStore'
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
  CaretDownOutlined,
  CaretRightOutlined
} from '@ant-design/icons'

const Sidebar: React.FC = () => {
  const { sessions, activeSessionId, createSession, deleteSession, switchSession, renameSession } = useSessionStore()
  const { layout, toggleSidebar } = useConfigStore()
  const [searchText, setSearchText] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState({
    sessions: true,
    workPriority: true,
    businessNav: true,
    presets: true,
    templates: true
  })
  // 业务导航树：一级（中心）与二级（模块）的展开状态，默认只展开第一个中心
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({})

  const collapsed = layout.sidebarCollapsed

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

  // 业务导航数据
  const businessNav = [
    {
      name: '📘 人力资源中心',
      children: [
        {
          name: '1.1 招聘管理',
          items: ['招聘需求提报单', '岗位JD撰写 & 招聘启事', '岗位说明书更新编制', '招聘渠道管理台账', '简历筛选评分表', '人才库储备登记表', '面试安排通知单', '面试官对接沟通清单', '初试面试评估表', '复试面试评估表', '录用审批单', 'Offer录用通知书', '薪资谈判沟通方案', '招聘月度数据统计报表']
        },
        {
          name: '1.2 入职管理',
          items: ['入职资料审核清单', '新员工入职登记表', '劳动合同签订指引', '工位账号权限开通申请单', '新员工入职须知', '入职欢迎文案', '入职礼包清单', '7天入职跟进记录表', '30天入职跟进记录表', '60天入职跟进记录表']
        },
        {
          name: '1.3 员工档案管理',
          items: ['员工电子档案模板', '人员信息维护变更登记表', '岗位异动档案记录单', '证照证书学历存档登记表', '员工花名册表格', '档案合规自查方案', '员工隐私安全管理制度']
        },
        {
          name: '1.4 考勤排班管理',
          items: ['排班表制定模板', '轮班管理制度', '打卡记录核对台账', '事假请假审批单', '病假请假审批单', '年假请假审批单', '婚假请假审批单', '产假请假审批单', '加班申请审批单', '加班统计台账', '加班调休申请单', '迟到早退旷工统计表', '月度考勤汇总报表', '考勤异常处理通知单', '考勤管理制度']
        },
        {
          name: '1.5 薪酬薪资管理',
          items: ['薪资结构设计方案', '月度薪资核算表', '社保公积金基数核算表', '员工薪资条模板', '薪资发放通知公告', '年终奖核算方案', '员工调薪审批单']
        }
      ]
    },
    {
      name: '📙 行政综合中心',
      children: [
        {
          name: '2.1 行政制度管理',
          items: ['办公用品管理制度', '办公环境卫生管理规定']
        },
        {
          name: '2.2 资产后勤管理',
          items: ['固定资产台账模板']
        }
      ]
    }
  ]

  if (collapsed) {
    return (
      <aside className="w-12 bg-surface border-r border-line flex flex-col items-center py-3 gap-3 transition-all duration-300">
        <Tooltip title="展开侧边栏">
          <button onClick={toggleSidebar} className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
            <RightOutlined />
          </button>
        </Tooltip>
        <Tooltip title="新建会话">
          <button onClick={() => createSession()} className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
            <PlusOutlined />
          </button>
        </Tooltip>
      </aside>
    )
  }

  return (
    <aside className="w-[340px] bg-surface border-r border-line flex-shrink-0 flex flex-col transition-all duration-300 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl">
      {/* 头部 */}
      <div className="p-4 border-b border-line flex justify-between items-center">
        <div>
          <h1 className="font-bold text-xl text-primary">Hermes HR智脑</h1>
          <div className="text-xs text-inkMuted">人事行政一体化智能专家</div>
        </div>
        <button onClick={toggleSidebar} className="p-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas hidden md:block">
          <LeftOutlined />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-3 space-y-3">
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
                size="small"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="mb-2"
              />
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
            </div>
          </div>
        </div>

        {/* 近期重点工作 */}
        <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
          <div onClick={() => toggleSection('workPriority')} className="p-3 bg-primarySoft flex justify-between cursor-pointer">
            <span><BookOutlined /> 近期重点工作</span>
            <span className="text-xs"><CaretRightOutlined className={`transition-transform duration-300 ${expandedSections.workPriority ? 'rotate-90' : 'rotate-0'}`} /></span>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expandedSections.workPriority ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden min-h-0">
            <div className="p-2">
              <Input.TextArea
                placeholder="填写当前项目背景、目标人群、使用场景，辅助AI精准输出"
                rows={3}
                className="text-sm"
              />
              <div className="flex justify-end mt-2 gap-2">
                <Button size="small" type="link">自动生成标题</Button>
                <Button size="small" type="text">历史折叠</Button>
              </div>
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
                        {category.children.map((module, mi) => {
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
                              {/* 三级：功能项 */}
                              <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${modOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                                <div className="overflow-hidden min-h-0">
                                  {module.items.map((item, ii) => (
                                    <div
                                      key={ii}
                                      className="text-sm py-1 pl-8 pr-2 rounded-md hover:bg-primarySoft cursor-pointer transition-all text-inkMuted hover:text-primary"
                                      onClick={() => {
                                        // 填充对应的 Prompt 到输入框（视觉不变），同时携带业务意图标签给主进程路由
                                        const event = new CustomEvent('fillPrompt', {
                                          detail: { text: `请生成：${item}`, intent: { hint: item } }
                                        })
                                        window.dispatchEvent(event)
                                      }}
                                    >
                                      {item}
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

        {/* 公共预设指令库 */}
        <div className="border border-line rounded-xl overflow-hidden bg-surfaceSubtle">
          <div onClick={() => toggleSection('presets')} className="p-3 bg-primarySoft flex justify-between cursor-pointer">
            <span><StarOutlined /> 公共预设指令库</span>
            <span className="text-xs"><CaretRightOutlined className={`transition-transform duration-300 ${expandedSections.presets ? 'rotate-90' : 'rotate-0'}`} /></span>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expandedSections.presets ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden min-h-0">
            <div className="p-2 text-sm text-inkMuted text-center py-4">
              点击业务导航中的功能即可加载预设指令
            </div>
            </div>
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
