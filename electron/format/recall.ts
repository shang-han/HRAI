/**
 * 格式模板召回与注入渲染（P2 第 3 步）
 *
 * 对应设计文档 outputs/P2-结构复用详细设计.md 的 §6。
 *
 * 职责：
 *   - 打分召回：在候选模板里挑「最该套用」的 1 个（绝不多个，见 §6.1）
 *   - 注入渲染：把挑中的模板渲染成结构化自然语言段，供 intent-router 拼进 prompt
 *
 * 三条硬约束（改动时不要破坏）：
 *   1. 本模块不 import electron，dataDir 无关 —— 与第 1/2 步同套路，node 直接跑测试
 *   2. 跨意图不套用：intentId 两边都定义且不同 → 直接判 0 分，绝不注入（§4.4 / §9 防坑）
 *   3. 冲突豁免句永远存在；score < 0.5 一律不注入；多 sheet 只渲染主 sheet（§6.2 / §6.3）
 */

import type { XlsxSkeleton, SheetSkeleton, ColumnSpec } from './xlsx-extractor'
import type { FormatTemplate } from './skeleton-store'
import { headersOf, similarity } from './skeleton-store'

// ============ 常量 ============

/** 得分 < 0.5 不注入（设计文档 §6.1「宁可不做，不可错做」） */
export const SCORE_THRESHOLD = 0.5
/** 请求表头与模板表头相似度 < 0.7 不得注入（§14.5 负例：相似度 <0.7 不得注入） */
export const FAMILY_HARD_GATE = 0.7

const W_INTENT = 0.45
const W_HEADER = 0.30
const W_RECENCY = 0.15
const W_CONF = 0.10
/** 拒绝罚分：拒绝次数/使用次数 作为减项（P2a：Case D 要求 confidence 下降 + 排序降低）。W_REJECT=0.20；得分范围 [-0.20, 1.00]，但会被外层钳到 [0,1]，重拒绝模板自然跌破 0.5 门槛不召回 */
const W_REJECT = 0.20

const DEFAULT_BUDGET = 1200
const DEFAULT_MAX_COLUMNS = 25
/** recency 衰减半衰期（天），exp(-days/60) */
const RECENCY_HALF = 60

// ============ 类型 ============

export interface RecallContext {
  intentId?: string
  workflow?: string
  /** 用户原话，用于统计命中了哪些表头字段（headerOverlap） */
  userQuery: string
  /** 可选：请求隐含的表头集合，用于「相似度 <0.7 不注入」硬门槛 */
  requestHeaders?: string[]
  /** 注入时钟，测试可固定 */
  now?: () => Date
}

export interface ScoreBreakdown {
  intentMatch: number
  headerOverlap: number
  recency: number
  confidence: number
  /** 拒绝罚分 = rejectCount / max(useCount, 1)，范围 [0, 1] */
  rejectPenalty: number
  score: number
}

export interface RecallResult {
  matched: boolean
  template?: FormatTemplate
  score: number
  breakdown?: ScoreBreakdown
}

export interface RenderOptions {
  /** 字数预算，默认 1200（设计文档 §6.3） */
  budget?: number
  /** 字段截断阈值，默认 25 列（§6.3） */
  maxColumns?: number
  now?: () => Date
}

// ============ 打分 ============

function bothIntentDefinedAndDiffer(a?: string, b?: string): boolean {
  const x = a ?? ''
  const y = b ?? ''
  return x !== '' && y !== '' && x !== y
}

/**
 * intentMatch：完全一致 = 1；至少一边缺意图时退化为 workflow 匹配 = 0.5；否则 0。
 * 真正的跨意图（两边都定义了 intentId 且不同）直接 0 —— 不靠 workflow 兜底，
 * 否则跨意图同 workflow 会拿到 0.5 而被误注入（§14.5 负例：跨意图召回分必须 <0.5）。
 */
function intentMatchOf(t: FormatTemplate, ctx: RecallContext): number {
  if (bothIntentDefinedAndDiffer(t.intentId, ctx.intentId)) return 0
  const ti = t.intentId ?? ''
  const qi = ctx.intentId ?? ''
  if (ti && qi) return ti === qi ? 1 : 0
  if (t.workflow && t.workflow === ctx.workflow) return 0.5
  return 0
}

/** headerOverlap：原话里出现的表头字段数 / 总字段数 */
function headerOverlapOf(t: FormatTemplate, userQuery: string): number {
  const headers = headersOf(t.skeleton)
  if (headers.length === 0 || !userQuery) return 0
  const q = userQuery.toLowerCase()
  let hit = 0
  for (const h of headers) {
    if (q.includes(String(h).toLowerCase())) hit++
  }
  return hit / headers.length
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return (now.getTime() - t) / (24 * 60 * 60 * 1000)
}

/** recency：exp(-days/60)，钳制到 [0,1]（future lastUsedAt 时也不会 >1） */
function recencyOf(t: FormatTemplate, now: Date): number {
  const iso = t.stats.lastUsedAt || t.updatedAt
  const d = daysSince(iso, now)
  if (!Number.isFinite(d)) return 0
  return Math.min(1, Math.max(0, Math.exp(-d / RECENCY_HALF)))
}

/** confidence：acceptCount / max(useCount, 1) */
function confidenceOf(t: FormatTemplate): number {
  return t.stats.acceptCount / Math.max(t.stats.useCount, 1)
}

/**
 * 单模板打分（设计文档 §4.4）：
 *   score = 0.45×intentMatch + 0.30×headerOverlap + 0.15×recency + 0.10×confidence
 *          - 0.20×rejectPenalty
 * rejectPenalty = rejectCount / max(useCount, 1)：拒绝占比。样本小拒绝多时罚分大
 * （3 拒 / 3 用 = 1.0 → 总分 -0.20，跌破 0.5 门槛自然不再召回）；
 * 大量使用里少数拒绝（100 用 5 拒 = 0.05）几乎不影响排序。
 * 跨意图（两边都定义了 intentId 且不同）强制 score=0，绝不让它混过 0.5 门槛。
 */
export function scoreTemplate(t: FormatTemplate, ctx: RecallContext): ScoreBreakdown {
  const now = ctx.now ? ctx.now() : new Date()
  const intentMatch = intentMatchOf(t, ctx)
  const headerOverlap = headerOverlapOf(t, ctx.userQuery)
  const recency = recencyOf(t, now)
  const confidence = confidenceOf(t)
  const rejectPenalty = Math.min(t.stats.rejectCount / Math.max(t.stats.useCount, 1), 1)
  let score =
    W_INTENT * intentMatch + W_HEADER * headerOverlap + W_RECENCY * recency + W_CONF * confidence
      - W_REJECT * rejectPenalty
  if (bothIntentDefinedAndDiffer(t.intentId, ctx.intentId)) score = 0
  score = Math.min(1, Math.max(0, score))
  return { intentMatch, headerOverlap, recency, confidence, rejectPenalty, score }
}

// ============ 召回 ============

/**
 * 在候选模板里挑「最该套用」的 1 个。
 * 只取最高分的 1 个（格式套用给多个会让 AI 不知道听谁的，§6.1）；
 * 得分 < 0.5 一律不注入；archived 永不注入；提供了请求表头时相似度 <0.7 也跳过。
 */
export function pickFormatTemplate(candidates: FormatTemplate[], ctx: RecallContext): RecallResult {
  const now = ctx.now ? ctx.now() : new Date()
  let best: FormatTemplate | undefined
  let bestScore = -1
  let bestBreakdown: ScoreBreakdown | undefined
  for (const t of candidates) {
    if (t.lifecycle === 'archived') continue
    // 硬门槛：提供请求表头时，相似度 < 0.7 不得注入（§14.5 负例）
    if (ctx.requestHeaders && ctx.requestHeaders.length > 0) {
      const sim = similarity(ctx.requestHeaders, headersOf(t.skeleton))
      if (sim < FAMILY_HARD_GATE) continue
    }
    const b = scoreTemplate(t, { ...ctx, now: () => now })
    // 始终记录最高分者，即使它没过 0.5 门槛 —— 这样未命中时返回的 score
    // 是候选的真实得分（而非哨兵 0），负例断言「得分 < 0.5 不注入」才站得住脚
    if (best === undefined || b.score > bestScore) {
      best = t
      bestScore = b.score
      bestBreakdown = b
    }
  }
  if (best === undefined || !bestBreakdown) return { matched: false, score: 0 }
  return { matched: bestScore >= SCORE_THRESHOLD, template: best, score: bestScore, breakdown: bestBreakdown }
}

/** 便捷封装：pick + render，命中返回注入段、未命中返回 null */
export function recallFormatSection(
  candidates: FormatTemplate[],
  ctx: RecallContext,
  opts?: RenderOptions
): string | null {
  const r = pickFormatTemplate(candidates, ctx)
  if (!r.matched || !r.template) return null
  return renderFormatSection(r.template, opts)
}

// ============ 注入渲染 ============

function fmtDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function typeLabel(c: ColumnSpec): string {
  if (c.inferredType === 'enum' && c.enumValues && c.enumValues.length > 0) {
    return `enum:${c.enumValues.join('/')}`
  }
  return c.inferredType
}

/** 不同生命周期措辞强度不同，这是防止「强制套用」的核心手段（§5） */
function lifecycleWording(t: FormatTemplate): string {
  if (t.lifecycle === 'active') return '用户惯用此格式，请严格对齐'
  if (t.lifecycle === 'candidate') return '用户此前用过类似格式，供参考'
  return '用户或曾用过类似格式，供参考'
}

function stripLeadingEqual(f?: string): string {
  if (!f) return ''
  return f.replace(/^=/, '')
}

/**
 * 把挑中的模板渲染成结构化自然语言段（不是 JSON dump，LLM 读自然语言表格更稳，§6.2）。
 * 预算 1200 字；字段超过 25 列截断并注明；多 sheet 只渲染主 sheet 完整骨架。
 * 最后一句冲突豁免句强制存在，任何状态下都不能省（§6.2 末段）。
 */
export function renderFormatSection(t: FormatTemplate, opts?: RenderOptions): string {
  const budget = opts?.budget ?? DEFAULT_BUDGET
  const maxCols = opts?.maxColumns ?? DEFAULT_MAX_COLUMNS
  const skeleton = t.skeleton
  const sheets: SheetSkeleton[] = (skeleton && skeleton.sheets) || []
  const primary = sheets.find(s => s.isPrimary) || sheets[0]
  if (!primary) return ''

  const dateLabel = fmtDate(t.effectiveFrom || t.createdAt)
  const wording = lifecycleWording(t)
  const lines: string[] = []
  lines.push('【建议套用的格式（如适用请对齐）】')
  lines.push(`以下来自 ${dateLabel} 的《${t.name}》，${wording}。`)

  // 工作表（表头行 / 冻结 / 筛选）
  let sheetDesc = `- 工作表：${primary.name}（表头行=${primary.headerRow}`
  if (primary.freeze) sheetDesc += `，冻结 ${primary.freeze}`
  if (primary.autoFilter) sheetDesc += `，筛选 ${primary.autoFilter}`
  sheetDesc += `）`
  lines.push(sheetDesc)

  // 字段顺序（截断 25 列）
  const allCols = primary.columns || []
  const cols = allCols.slice(0, maxCols)
  lines.push('- 字段顺序（务必保持一致）：')
  cols.forEach((c, i) => {
    lines.push(`  ${i + 1} ${c.key}(${typeLabel(c)})`)
  })
  if (allCols.length > maxCols) {
    lines.push(`  （其余 ${allCols.length - maxCols} 列已省略）`)
  }

  // 列公式（{r} 为当前数据行行号）
  const formulaCols = allCols.filter(c => c.formula)
  if (formulaCols.length > 0) {
    lines.push('- 列公式：')
    for (const c of formulaCols) {
      lines.push(`  ${c.key} = ${stripLeadingEqual(c.formula)}`)
    }
    lines.push('  （{r} 为当前数据行行号，需逐行填充）')
  }

  // 已知口径
  if (t.norms && t.norms.length > 0) {
    lines.push(`- 已知口径：${t.norms.join('；')}`)
  }

  // 多 sheet 提示（只渲染主 sheet 完整骨架，其余仅记名字与表头）
  if (sheets.length > 1) {
    const others = sheets.filter(s => s !== primary).map(s => s.name)
    lines.push(`- 其余工作表：${others.join('、')}（仅保留表头，不渲染完整骨架）`)
  }

  // 冲突豁免句（强制，永远存在）
  lines.push(
    '- 若本次需求与上述格式冲突（如用户明确要求增删字段），以用户本次要求为准，并在回复中说明与惯用格式的差异。'
  )

  let out = lines.join('\n')
  // 预算保护：超长则砍掉口径段，保留结构骨架（口径后续可由 norms 在别处补充）
  if (out.length > budget) {
    const kept = lines.filter(l => !l.startsWith('- 已知口径'))
    out = kept.join('\n') + '\n- （已知口径过长已从略）'
  }
  return out
}
