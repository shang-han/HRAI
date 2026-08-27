import React, { useEffect, useState } from 'react'
import { Tooltip, Popconfirm, App as AntApp } from 'antd'
import type { SessionUsage } from '../global'

/**
 * 上下文占用率 + 提示词缓存指示器（顶栏胶囊）。
 *
 * 数据全部来自 Hermes 内核（ACP 原生 usage_update + session/prompt 返回的 usage），
 * 这里只做展示，不在前端重算 token —— 同一个数两套算法必然发散。
 *
 * 为什么这东西值得占顶栏一个位置：智能体会话是有寿命的。占用率涨到阈值时内核
 * 会把早期对话压成摘要（有损），细节从此只能靠它自己的摘要复述。用户看得见占用率，
 * 才能在"压缩即将发生"之前主动收尾或另开会话，而不是事后发现 AI"忘了前面说过的话"。
 *
 * 刻意不显示"自动压缩阈值是百分之多少"：内核那个阈值是
 * 配置比例 → 小窗口模型抬到 0.75 → 按 max_tokens 折算可用输入预算 → 绝对 token 上限裁剪
 * 一路算出来的（见 agent/context_compressor.py 的 _compute_threshold_tokens），
 * 在前端抄一遍必然抄错，而一个错的阈值比没有阈值更坏。
 */

const RING_R = 7
const RING_C = 2 * Math.PI * RING_R

/** token 数按 k 收敛显示：顶栏塞不下 187,432 这种原始数字 */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

interface Props {
  sessionId: string
}

const ContextMeter: React.FC<Props> = ({ sessionId }) => {
  const { message } = AntApp.useApp()
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [busy, setBusy] = useState(false)

  // 切会话先清空再拉：不清的话新会话在数据到达前会短暂显示上一个会话的占用率
  useEffect(() => {
    let alive = true
    setUsage(null)
    if (!sessionId) return
    window.electronAPI.usage.get(sessionId)
      .then(u => { if (alive) setUsage(u) })
      .catch(() => { /* 拿不到就先不显示，下一轮推送会补上 */ })
    return () => { alive = false }
  }, [sessionId])

  // 订阅推送。依赖里带 sessionId 不会丢消息：React 在同一次提交里同步执行
  // 卸载 + 挂载，中间不会让出事件循环，IPC 消息插不进来。
  useEffect(() => {
    return window.electronAPI.usage.onUpdate(payload => {
      if (payload?.sessionId !== sessionId) return
      setUsage(payload.usage)
    })
  }, [sessionId])

  const size = usage?.size || 0
  const used = usage?.used || 0
  // 拿不到上下文窗口长度就整个不显示：分母未知的百分比是编的
  if (!size) return null

  const pct = Math.min(100, Math.round((used / size) * 100))
  const level = pct >= 85 ? 'is-high' : pct >= 60 ? 'is-mid' : 'is-low'
  const turn = usage?.lastTurn || null
  // 命中率的分母用 input（= provider 的 prompt_tokens，已含被缓存命中的部分），
  // 所以这个比值天然落在 0~100%
  const turnRate = turn && turn.input > 0 ? Math.round((turn.cachedRead / turn.input) * 100) : 0
  const totalRate = usage && usage.totalInput > 0
    ? Math.round((usage.totalCachedRead / usage.totalInput) * 100)
    : 0

  const compress = async () => {
    setBusy(true)
    try {
      const res = await window.electronAPI.chat.command('/compress', sessionId)
      if (res?.success) {
        message.success('已压缩历史上下文，占用率稍后自动刷新')
      } else {
        message.warning(res?.error || '压缩未完成，可稍后再试')
      }
    } catch (err: any) {
      message.warning(err?.message || '压缩请求失败')
    } finally {
      setBusy(false)
    }
  }

  const tip = (
    <div className="text-xs leading-relaxed" style={{ maxWidth: 300 }}>
      <div className="font-medium mb-1">上下文占用 {pct}%</div>
      <div>{used.toLocaleString()} / {size.toLocaleString()} tokens（系统提示 + 对话历史 + 工具定义）</div>
      <div className="mt-1.5">
        接近上限前，智能体会自动把早期对话压成摘要，占用率随之回落 —— 这是正常机制，不是错误。
        代价是被压缩的细节只剩摘要，所以任务收尾后另开会话比一直续着更划算。
      </div>
      {turn && (
        <div className="mt-1.5">
          最近一轮：输入 {fmtTokens(turn.input)} · 输出 {fmtTokens(turn.output)}
          {turn.thought > 0 ? ` · 思考 ${fmtTokens(turn.thought)}` : ''}
        </div>
      )}
      <div className="mt-1.5">
        {usage?.cacheObserved ? (
          <>
            提示词缓存已生效：本轮命中 {fmtTokens(turn?.cachedRead || 0)} tokens（{turnRate}%），
            累计命中率 {totalRate}%（命中部分的输入费用约为原价四分之一）
          </>
        ) : turn ? (
          '提示词缓存：暂未命中。首轮只写入缓存不计命中；若一直为 0，说明当前模型线路不支持提示词缓存（原生 Anthropic、OpenRouter 上的 Claude/Kimi、Qwen 系列等才有）。'
        ) : (
          '提示词缓存：本会话还没有完成的对话回合，暂无数据。'
        )}
      </div>
      <div className="mt-1.5 opacity-70">点击可立即手动压缩</div>
    </div>
  )

  return (
    <Popconfirm
      title="现在压缩上下文？"
      description={
        <div className="text-xs" style={{ maxWidth: 260 }}>
          早期对话会被摘要替换以腾出空间，细节不可恢复（左侧聊天记录不受影响）。
        </div>
      }
      okText="压缩"
      cancelText="取消"
      okButtonProps={{ loading: busy }}
      onConfirm={compress}
    >
      <Tooltip title={tip}>
        <span className={`hermes-usage-chip ${level}`}>
          <svg className="hermes-usage-ring" width="18" height="18" viewBox="0 0 18 18">
            {/* 底环 + 进度环同心；进度环转 -90° 让起点落在 12 点方向 */}
            <circle cx="9" cy="9" r={RING_R} className="hermes-usage-ring-track" />
            <circle
              cx="9"
              cy="9"
              r={RING_R}
              className="hermes-usage-ring-bar"
              strokeDasharray={`${(RING_C * pct) / 100} ${RING_C}`}
              transform="rotate(-90 9 9)"
            />
          </svg>
          <span>{pct}%</span>
        </span>
      </Tooltip>
    </Popconfirm>
  )
}

export default ContextMeter
