import React, { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { App as AntApp, Button, Checkbox, Empty, Modal } from 'antd'
import { ExclamationCircleOutlined, FileAddOutlined, FileExcelOutlined, MessageOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 权限审批自动拒绝超时（秒）。必须与 electron/main.ts 的 PERMISSION_TIMEOUT_MS 保持一致：
 * 横幅倒计时就是按这个数走的，两边不一致会让横幅提前收起或倒计时归零后还挂着。
 */
const PERMISSION_TIMEOUT_SEC = 60

/** 消息时间戳：当天只显示时分；今天以前带上日期（跨年时连年份一起显示） */
const formatMessageTime = (ts: string) => {
  const d = new Date(ts)
  const now = new Date()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  const date = d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    : d.toLocaleDateString('zh-CN')
  return `${date} ${time}`
}

/** "思考过程"后的三个跳动省略点（主题色，表示进行中/可点击） */
const ThinkingDots: React.FC = () => (
  <span className="flex items-center gap-0.5">
    {[0, 150, 300].map(delay => (
      <span
        key={delay}
        className="w-1 h-1 bg-primary rounded-full animate-bounce"
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
  </span>
)

const ChatArea: React.FC = () => {
  const { messagesBySession, loadingBySession, activeSessionId } = useSessionStore()
  // 计算当前 active 会话的消息与加载态（per-session 桶）
  const messages = messagesBySession[activeSessionId ?? ''] || []
  const isLoading = !!loadingBySession[activeSessionId ?? '']
  const hasMessages = messages.length > 0
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const lastUserMsgIdRef = useRef<string | null>(null)
  // 已展开"思考过程"的消息 id 集合（默认全部折叠，点开后进入此集合）
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  // 采纳为资产：勾选对话产出目录里的文件
  const { message: msg } = AntApp.useApp()
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [adoptCandidates, setAdoptCandidates] = useState<Array<{ path: string; fileName: string; size: number; mtime: number }>>([])
  const [adoptChecked, setAdoptChecked] = useState<string[]>([])
  const [adoptBusy, setAdoptBusy] = useState(false)
  // P2 6B：勾选含 xlsx 时，是否同时把表结构存为「我的惯用格式」
  const [adoptAlsoFormat, setAdoptAlsoFormat] = useState(true)

  // P2 6A：本次装配实际套用的格式模板（主进程 prepare() 命中时推送）
  const [formatApplied, setFormatApplied] = useState<{ sessionId: string; info: FormatAppliedPayload['formatApplied'] } | null>(null)
  const [formatExpanded, setFormatExpanded] = useState(false)

  // 订阅主进程的套用推送；会话切换时清掉旧提示（不同会话不该互相串）
  useEffect(() => {
    const off = window.electronAPI.format.onApplied(payload => {
      setFormatApplied({ sessionId: payload.sessionId, info: payload.formatApplied })
      setFormatExpanded(false)
      // P1-2 隐式接受：挂起待接受模板 —— 用户没点拒绝并继续发消息即视为接受（§7 信号④）
      useSessionStore.getState().setPendingFormatAccept({ id: payload.formatApplied.id })
    })
    return off
  }, [])
  useEffect(() => {
    setFormatApplied(null)
    setFormatExpanded(false)
    // 挂起的隐式接受属于旧会话，切走即作废（不发 accept）
    useSessionStore.getState().clearPendingFormatAccept()
  }, [activeSessionId])

  // 权限审批兜底横幅：TopBar 的 Modal 可能被其他窗口遮挡、或在多显示器环境跑到屏幕外，
  // 用户看不到弹窗就不知道要审批，只会觉得"AI 卡住"。这里在聊天区再给一条可见提示 + 倒计时，
  // 倒计时归零即主进程自动拒绝的时刻（PERMISSION_TIMEOUT_SEC 秒）。
  const [pendingPermission, setPendingPermission] = useState<{ requestId: number; title: string } | null>(null)
  const [permissionCountdown, setPermissionCountdown] = useState(PERMISSION_TIMEOUT_SEC)

  // 订阅审批请求与结束信号。onResolved 由主进程在两种时机推送：
  // 用户点了允许/拒绝（permission:respond）、或 60 秒超时自动拒绝。
  useEffect(() => {
    const offRequest = window.electronAPI.permission.onRequest(data => {
      // 新请求到达：覆盖旧标记并把倒计时拨回满值
      setPendingPermission({ requestId: data.requestId, title: data.title || '' })
      setPermissionCountdown(PERMISSION_TIMEOUT_SEC)
    })
    const offResolved = window.electronAPI.permission.onResolved(data => {
      // requestId 不匹配就不动：旧的 resolved 迟到时不能把新请求的横幅误收起
      setPendingPermission(prev => (prev && prev.requestId === data.requestId ? null : prev))
    })
    return () => {
      offRequest()
      offResolved()
    }
  }, [])

  // 每秒递减。清理（return）覆盖三种情况：
  //   1) 组件卸载；2) 收到 resolved / 倒计时归零后 pendingPermission 变 null；
  //   3) 新请求到达 —— pendingPermission 换新对象，effect 重跑先清掉上一个 timer。
  useEffect(() => {
    if (!pendingPermission) return
    const timer = setInterval(() => {
      setPermissionCountdown(c => Math.max(0, c - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [pendingPermission])

  // 倒计时归零 = 主进程此刻已自动拒绝，横幅该收起（不等 resolved，万一主进程没推也不会挂死）
  useEffect(() => {
    if (pendingPermission && permissionCountdown <= 0) setPendingPermission(null)
  }, [permissionCountdown, pendingPermission])

  // 「本次不套用」：效果是记录拒绝信号（rejectCount++，连续 3 次自动降级），
  // 影响的是**下次**同类任务的召回排序；本次已发出的指令不含追溯性改动。
  const handleRejectFormat = async () => {
    if (!formatApplied) return
    try {
      await window.electronAPI.format.reject(formatApplied.info.id)
    } catch {
      /* 记不上就算了，不打断用户 */
    }
    // 拒绝了就不再是「待隐式接受」—— 否则下一条消息会把它记成 accept
    useSessionStore.getState().clearPendingFormatAccept()
    setFormatApplied(null)
    msg.info('已记录。下次同类任务将降低该格式的优先级（本次生成结果不变）')
  }

  const openAdopt = async () => {
    const { activeSessionId } = useSessionStore.getState()
    const list = await window.electronAPI.knowledge.candidates(activeSessionId || '').catch(() => [])
    setAdoptCandidates(list || [])
    setAdoptChecked((list || []).map(c => c.path))
    setAdoptAlsoFormat(true) // 每次打开默认勾上，让用户显式决定要不要
    setAdoptOpen(true)
  }

  const confirmAdopt = async () => {
    if (adoptChecked.length === 0) {
      msg.warning('请至少勾选一个文件')
      return
    }
    const { activeSessionId } = useSessionStore.getState()
    setAdoptBusy(true)
    try {
      // 1) 原有逻辑：所有勾选文件 → 企业文档资产（存内容文本，供语义检索）
      const results = await Promise.all(
        adoptChecked.map(p => window.electronAPI.knowledge.add(p, activeSessionId || ''))
      )
      const ok = results.filter(r => r && r.success)
      const failed = results.filter(r => r && !r.success)

      // 2) P2 6B：勾选的 xlsx 额外抽骨架存为「我的惯用格式」。
      //    注意是 UI 层并行编排两条独立通道 —— knowledge 与 format 模块零耦合（设计 §12 物理分离）。
      //    单个 xlsx 抽取失败不阻断整体采纳，收集错误单独提示。
      const xlsxFiles = adoptCandidates.filter(c => adoptChecked.includes(c.path) && /\.xlsx$/i.test(c.fileName))
      let savedFmt = 0
      let capacityWarn = ''
      const fmtErrors: string[] = []
      if (adoptAlsoFormat && xlsxFiles.length > 0) {
        for (const c of xlsxFiles) {
          try {
            const ext = await window.electronAPI.format.extract(c.path)
            if (!ext || !ext.ok || !ext.skeleton) {
              fmtErrors.push(`${c.fileName}：${ext?.reason || '无法识别表结构'}`)
              continue
            }
            const saved = await window.electronAPI.format.save({
              skeleton: ext.skeleton,
              name: c.fileName.replace(/\.xlsx$/i, ''),
              filePath: c.path,
              fileName: c.fileName,
              lifecycle: 'candidate' // 采纳后先进候选；下次被实际套用且未被拒绝才升「已确认」
            })
            if (saved?.template) {
              savedFmt++
              if (saved.capacityWarning) capacityWarn = saved.capacityWarning.message
            } else {
              fmtErrors.push(`${c.fileName}：保存失败`)
            }
          } catch (e: any) {
            fmtErrors.push(`${c.fileName}：${e?.message || e}`)
          }
        }
      }

      if (ok.length > 0) {
        msg.success(
          savedFmt > 0
            ? `已采纳 ${ok.length} 份为文档资产，${savedFmt} 份表结构存为「我的惯用格式」`
            : `已采纳 ${ok.length} 份文档为资产，AI 以后将参考它们生成内容`
        )
        setAdoptOpen(false)
      } else if (savedFmt > 0) {
        msg.success(`已把 ${savedFmt} 份表结构存为「我的惯用格式」`)
        setAdoptOpen(false)
      } else {
        msg.error(failed[0]?.error || '采纳失败')
      }
      if (fmtErrors.length > 0) msg.warning(`部分表结构未保存：${fmtErrors[0]}`)
      if (capacityWarn) msg.warning(capacityWarn)
    } finally {
      setAdoptBusy(false)
    }
  }

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const isNearBottom = () => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // 监听用户滚动位置：手动上滑阅读时停止自动跟随
  const handleScroll = () => {
    isNearBottomRef.current = isNearBottom()
  }

  // 容器高度变化（如输入框被拉伸/压缩）时：若原本贴底则保持贴底，
  // 否则浏览器保持 scrollTop 不变，底部内容会滑出可视区。
  // 依赖必须是 hasMessages 而不是 []：空态那棵树上没有 scrollRef，
  // 挂载时 current 是 null，只跑一次的话 observer 永远挂不上去。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scrollToBottom(false)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMessages])

  // 新消息/流式内容更新时：仅在用户位于底部附近时跟随滚动
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(messages.length > 0 && isLoading)
    }
  }, [messages, isLoading])

  // 用户刚发出消息时：强制定位到底部（用户正在输入框旁，注意力在底部）
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === 'user' && lastMsg.id !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = lastMsg.id
      isNearBottomRef.current = true
      requestAnimationFrame(() => scrollToBottom(false))
    }
  }, [messages])

  // 切换会话时直接定位到底部
  useEffect(() => {
    lastUserMsgIdRef.current = null
    isNearBottomRef.current = true
    requestAnimationFrame(() => scrollToBottom(false))
  }, [messages[0]?.id])

  // 会话内搜索跳转（TopBar 搜索点结果后派发）：用自己的滚动容器精确滚动，
  // 滚动后短暂高亮目标消息。偏移用 getBoundingClientRect 差值计算，
  // 不依赖 offsetParent 链，任何定位结构下都准确。
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent).detail as string
      const container = scrollRef.current
      const el = container?.querySelector(`#hermes-msg-${id}`) as HTMLElement | null
      if (!container || !el) return
      const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTo({
        top: top - container.clientHeight / 2 + el.clientHeight / 2,
        behavior: 'smooth'
      })
      el.classList.add('hermes-msg-flash')
      setTimeout(() => el.classList.remove('hermes-msg-flash'), 1800)
    }
    window.addEventListener('jump-to-message', h)
    return () => window.removeEventListener('jump-to-message', h)
  }, [hasMessages])

  if (messages.length === 0) {
    // 空态不抢 flex-1：由 App 里的上下弹性占位把「问候语 + 输入框」整体垂直居中。
    // 允许收缩 + 内部滚动，窗口很矮时问候语自己滚，不会把输入框顶出可视区。
    return (
      <div className="min-h-0 overflow-y-auto pt-4 pb-2">
        <div className="hermes-thread-col text-center">
          <h2 className="hermes-greeting text-[28px] leading-snug font-medium mb-2">
            您好，我是人事行政一体化智能专家
          </h2>
          <p className="text-inkMuted text-sm">
            您可以点击左侧业务菜单快速生成各类表单、制度方案，也可以直接输入您的需求。
          </p>
          <div className="mt-7 grid grid-cols-2 gap-3 text-left">
            {[
              '帮我写一份招聘需求提报单',
              '生成员工入职登记表',
              '制定考勤管理制度',
              '设计薪资结构方案'
            ].map((prompt, i) => (
              <div
                key={i}
                className="hermes-suggest-card px-3.5 py-3 text-sm text-inkSecondary"
                onClick={() => {
                  const event = new CustomEvent('fillInput', { detail: prompt })
                  window.dispatchEvent(event)
                }}
              >
                💡 {prompt}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto min-h-0"
    >
      {/* min-h-full + justify-end：内容不满屏时贴在底部（紧挨输入框），满屏后正常滚动 */}
      {/* 列宽/左右边界由 .hermes-thread-col 统一（与输入框、空态问候语同一个类） */}
      <div className="hermes-thread-col min-h-full flex flex-col justify-end py-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          id={`hermes-msg-${message.id}`}
          className={`flex message-enter relative items-start ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {message.role !== 'user' && (
            <div className="hermes-msg-avatar">H</div>
          )}
          <div
            className={`max-w-[70%] rounded-2xl px-4 py-3 ${
              message.role === 'user'
                ? 'hermes-glass-primary text-white'
                : 'hermes-glass text-ink'
            }`}
          >
            {/* 图片展示 */}
            {message.images && message.images.length > 0 && (
              <div className="flex gap-2 mb-2 flex-wrap">
                {message.images.map((img, i) => (
                  <img key={i} src={img} alt="" className="max-w-[200px] max-h-[200px] rounded-lg" />
                ))}
              </div>
            )}

            {/* 文本内容 */}
            {message.role === 'assistant' ? (
              <div>
                {/* 思考过程：标题行（主题色 + 跳动点）始终在灰底内容区内，
                    折叠时只收起内容、保留底色；展开/收缩带慢动画；
                    下方居中一条伸缩条（与输入框伸缩手柄同色） */}
                {message.thinking && (
                  <div className="mb-2 text-xs">
                    <div className="p-2 bg-surfaceSubtle dark:bg-canvas rounded-lg">
                      {/* 标题行：位置固定，点击展开/收缩（默认折叠） */}
                      <div
                        className="inline-flex items-center gap-1 cursor-pointer select-none text-primary hover:opacity-80"
                        onClick={() => toggleThinking(message.id)}
                        title={expandedThinking.has(message.id) ? '收起思考过程' : '展开思考过程'}
                      >
                        <MessageOutlined className="text-primary" />
                        思考过程
                        <ThinkingDots />
                      </div>
                      {/* 内容：grid 行高 0fr↔1fr 过渡，展开收缩带动画 */}
                      <div
                        className="grid transition-[grid-template-rows] duration-300 ease-out"
                        style={{ gridTemplateRows: expandedThinking.has(message.id) ? '1fr' : '0fr' }}
                      >
                        <div className="overflow-hidden min-h-0">
                          <div className="mt-1 whitespace-pre-wrap text-inkMuted">{message.thinking}</div>
                        </div>
                      </div>
                    </div>
                    <div
                      className="group flex justify-center pt-1 cursor-pointer select-none"
                      onClick={() => toggleThinking(message.id)}
                      title={expandedThinking.has(message.id) ? '收起思考过程' : '展开思考过程'}
                    >
                      <div className="w-10 h-1.5 rounded-full bg-line dark:bg-lineDark group-hover:bg-primary transition-colors" />
                    </div>
                  </div>
                )}
                <div className="markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {message.content}
                  </ReactMarkdown>
                  {isLoading && messages.indexOf(message) === messages.length - 1 && !message.content && (
                    <div className="flex items-center gap-1.5 py-2">
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '0ms' }} />
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '150ms' }} />
                      <span className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-bounce shadow-sm" style={{ animationDelay: '300ms' }} />
                      <span className="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">正在生成回复…</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap">{message.content}</p>
            )}

            {/* 消息底部栏：时间戳靠左，采纳为资产靠右（消息框右下角）。
                用户气泡上时间戳不能再用 primaryLight：主色玻璃上两者都是浅蓝紫，
                几乎糊在一起；改半透明白，跟白正文同色系但明确弱一档 */}
            <div className={`mt-1 flex items-center justify-between gap-2 text-xs ${message.role === 'user' ? 'text-white/70' : 'text-inkMuted'}`}>
              <span className="shrink-0">
                {formatMessageTime(message.timestamp)}
                {message.model && ` · ${message.model}`}
              </span>
              {/* 采纳为资产：把本次对话产出的文件确认为企业文档资产。
                  流式生成中的最后一条先不显示，回复完成后才出现。
                  报错/系统提示（⚠️ 开头）不是真实产出，不提供采纳入口 */}
              {message.role === 'assistant' && !message.content.startsWith('⚠️') && !(isLoading && messages.indexOf(message) === messages.length - 1) && (
                <button
                  onClick={openAdopt}
                  className="flex items-center gap-1 text-primary hover:underline transition-colors shrink-0"
                  title="勾选本会话产出目录中的文件，确认后 AI 以后生成同类内容时参考它们"
                >
                  <FileAddOutlined className="text-xs" />
                  采纳为资产
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* 加载中指示器 */}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex justify-start relative items-start message-enter">
          <div className="hermes-msg-avatar">H</div>
          <div className="hermes-glass rounded-2xl px-4 py-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      )}
      </div>

      {/* 权限审批兜底横幅：弹窗可能被遮挡，这里保证"有事待办"这件事本身看得见，
          并明确告知倒计时结束后会自动拒绝，用户不必瞎等 */}
      {pendingPermission && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 flex items-center gap-2 flex-wrap">
          <ExclamationCircleOutlined className="text-sm text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-xs text-ink">
            Hermes 请求执行权限（{pendingPermission.title || '工具调用'}），请在弹窗中确认；若看不到弹窗，检查是否被其他窗口遮挡
          </span>
          <div className="flex-1" />
          <span className="text-xs text-amber-700 dark:text-amber-400 shrink-0 tabular-nums">
            {permissionCountdown} 秒后自动拒绝
          </span>
        </div>
      )}

      {/* P2 第 6 步：套用提示条 —— 套用看得见、可拒绝。
          没套用（formatApplied 为空或不是本会话）时完全不显示（设计 §9：无提示不注入） */}
      {formatApplied && formatApplied.sessionId === activeSessionId && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg border border-primary/40 bg-primarySoft flex items-center gap-2 flex-wrap">
          <FileExcelOutlined className="text-sm text-primary shrink-0" />
          <span className="text-xs text-ink">
            本次套用了《{formatApplied.info.name}》
            {formatApplied.info.lifecycle === 'active' && (
              <span className="text-inkMuted">（你确认过的惯用格式）</span>
            )}
          </span>
          {formatApplied.info.columns.length > 0 && (
            <button
              onClick={() => setFormatExpanded(v => !v)}
              className="text-xs text-primary hover:underline shrink-0"
            >
              {formatExpanded ? '收起字段' : `展开字段（${formatApplied.info.columns.length} 列）`}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={handleRejectFormat}
            title="记录后下次同类任务降低该格式优先级；本次已发出的生成结果不变"
            className="text-xs px-2 py-0.5 rounded border border-line text-inkSecondary hover:text-red-500 hover:border-red-400 transition-colors shrink-0"
          >
            本次不套用
          </button>
          {formatExpanded && (
            <div className="w-full flex flex-wrap gap-1 pt-1.5 border-t border-line/60">
              {formatApplied.info.columns.slice(0, 30).map(c => (
                <span key={c} className="px-1.5 py-0.5 text-[10px] rounded border border-line bg-surface text-inkSecondary">
                  {c}
                </span>
              ))}
              {formatApplied.info.columns.length > 30 && (
                <span className="text-[10px] text-inkMuted self-center">…等 {formatApplied.info.columns.length} 列</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>

    <Modal
      title="采纳为资产"
      open={adoptOpen}
      onCancel={() => setAdoptOpen(false)}
      onOk={confirmAdopt}
      okText="确认采纳"
      cancelText="取消"
      confirmLoading={adoptBusy}
      width={560}
    >
      {adoptCandidates.length === 0 ? (
        <Empty description="本会话产出目录（output/）暂无文件。AI 生成过文档后再试。" />
      ) : (
        <div className="space-y-1">
          <div className="mb-2 space-y-1">
            <p className="text-xs text-inkMuted">勾选要作为企业文档资产的文件（AI 生成同类内容时参考其中的<b>文本、术语、口径</b>；勾选下面的「同时把勾选的 xlsx 表结构存为『我的惯用格式』」可一并存表结构）</p>
            <Checkbox
              checked={adoptChecked.length === adoptCandidates.length}
              indeterminate={adoptChecked.length > 0 && adoptChecked.length < adoptCandidates.length}
              onChange={e => setAdoptChecked(e.target.checked ? adoptCandidates.map(c => c.path) : [])}
            >
              全选
            </Checkbox>
          </div>
          {adoptCandidates.map(c => (
            <div key={c.path} className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-surfaceSubtle dark:hover:bg-canvas">
              <Checkbox
                checked={adoptChecked.includes(c.path)}
                onChange={e => setAdoptChecked(prev => e.target.checked ? [...prev, c.path] : prev.filter(p => p !== c.path))}
              />
              <span className="text-sm truncate flex-1">{c.fileName}</span>
              <span className="text-xs text-inkMuted shrink-0">
                {(c.size / 1024).toFixed(1)} KB · {new Date(c.mtime).toLocaleString('zh-CN')}
              </span>
            </div>
          ))}
          {/* P2 6B：勾选含 xlsx 时，可同时把表结构存为「我的惯用格式」。
              不含 xlsx 时这行不出现，避免对普通文档造成困惑 */}
          {adoptChecked.some(p => /\.xlsx$/i.test(p)) && (
            <div className="mt-3 pt-3 border-t border-line">
              <Checkbox checked={adoptAlsoFormat} onChange={e => setAdoptAlsoFormat(e.target.checked)}>
                同时把勾选的 xlsx 表结构存为「我的惯用格式」
              </Checkbox>
              <div className="text-[11px] text-inkMuted mt-1 pl-7">
                存的是列顺序 / 类型 / 口径（不是数据），下次同类任务生成表格时自动对齐。
                先进入「候选」，被实际套用且未被拒绝后才升级为「已确认」。
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
    </div>
  )
}

export default ChatArea
