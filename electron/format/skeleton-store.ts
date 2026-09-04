import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { XlsxSkeleton } from './xlsx-extractor'

/**
 * 格式模板库（P2 结构复用 · 第 2 步）
 *
 * 职责：骨架归档为实例 → 相似度聚合 → 生命周期流转 → 落盘。
 * 对应设计文档 outputs/P2-结构复用详细设计.md 的 §4.2 / §4.4 / §5 / §8.1。
 *
 * 三条硬约束（改动时不要破坏）：
 *   1. 本模块不 import electron，dataDir 由外部注入 —— 否则 node 侧无法直接跑测试
 *   2. 跨 intentId 绝不归为同族，即使表头 100% 相同（相似度直接返回 0）
 *   3. 一切「删除/覆盖」动作都不静默：数量上限只提示、导入冲突只列清单
 *
 * 与 storage-manager.ts 保持一致的落盘约定：{dataDir}/format_templates.json，
 * 与 template.json / company_profile.json 同级。
 */

// ============ 常量 ============

const STORE_VERSION = 1
const DEFAULT_FILE_NAME = 'format_templates.json'
const CORRUPT_BACKUP_PREFIX = 'format_templates.corrupt-'

/** 模板数量上限。到顶只提示，绝不自动归档（设计文档 §8.2 决策 2） */
const DEFAULT_MAX_TEMPLATES = 100
/** 归为同一格式族的最低相似度（设计文档 §4.4） */
const DEFAULT_FAMILY_THRESHOLD = 0.7
/** instance 升 candidate 所需的最少复用次数（设计文档 §7：累计 2 次触发） */
const DEFAULT_PROMOTE_USE_THRESHOLD = 2
/** 多少天未用进入衰减（设计文档 §5） */
const DEFAULT_DECAY_DAYS = 90
/** 数量上限提示时列出的「最久未用」条数 */
const DEFAULT_STALE_SAMPLE_SIZE = 10
/** active 连续被拒绝多少次自动降级为 candidate（设计文档 §11 Case D） */
const DEFAULT_AUTO_DEMOTE_REJECT_COUNT = 3
/** 并存导入时的默认名字后缀 */
const DEFAULT_RENAME_SUFFIX = '（导入副本）'

/** 相似度权重：集合重合 0.6 + 顺序一致 0.4（设计文档 §4.4，顺序权重是刻意的） */
const W_JACCARD = 0.6
const W_ORDER = 0.4

const LIFECYCLES: Lifecycle[] = ['instance', 'candidate', 'active', 'archived']

/** 注入 prompt 的强度排序，也用于同分时谁排在前面 */
const LIFECYCLE_RANK: Record<Lifecycle, number> = {
  instance: 0,
  candidate: 1,
  active: 2,
  archived: 3
}

const DAY_MS = 24 * 60 * 60 * 1000

// ============ 类型 ============

export type Lifecycle = 'instance' | 'candidate' | 'active' | 'archived'
export type FormatKind = 'xlsx'

export interface FormatTemplateStats {
  /** 被召回次数（也作为「复用次数」计入升格判定，设计文档 §7） */
  useCount: number
  /** 被采纳次数（生成后未推翻） */
  acceptCount: number
  /** 被「本次不套用」次数 */
  rejectCount: number
  lastUsedAt: string
  lastAcceptedAt?: string
}

export interface FormatTemplateEvidence {
  /** workspace/output/<taskId>/xxx.xlsx */
  filePath: string
  fileName: string
  extractedAt: string
  /** 源文件已删除仍可套用（只存 schema 不存副本，所以删了也能用） */
  pathMissing?: boolean
}

/** 格式模板。字段严格对齐设计文档 §4.2，仅额外补 workflow 供第 3 步召回打分 */
export interface FormatTemplate {
  id: string
  /** 用户可改：「考勤汇总表（我惯用的）」 */
  name: string
  /** 绑定意图，跨意图不套用 */
  intentId?: string
  intentLabel?: string
  /** 意图所属 workflow（如 spreadsheet-report），第 3 步「同 workflow 得 0.5」用 */
  workflow?: string
  kind: FormatKind
  lifecycle: Lifecycle
  version: number
  /** 版本链，指向被取代的模板 id */
  supersedes?: string
  effectiveFrom: string

  skeleton: XlsxSkeleton
  norms: string[]

  stats: FormatTemplateStats
  evidence: FormatTemplateEvidence[]

  createdAt: string
  updatedAt: string
}

/** 相似度比较的最小单元。intentId 是聚合键的一部分 */
export interface FamilyKey {
  headers: string[]
  intentId?: string
  kind?: FormatKind
}

/** similarity / findFamily 接受三种形态，内部统一归一成 FamilyKey */
export type SimilarityTarget = FamilyKey | string[] | XlsxSkeleton

/** candidate 升 active 的判定条件。可配置，全库只有 canPromoteToActive 一处使用 */
export interface ActiveCriteria {
  minAcceptCount: number
  maxRejectCount: number
}

export interface SkeletonStoreOptions {
  /** 存储目录（绝对路径）。主进程传 path.join(app.getPath('userData'), 'data') */
  dataDir: string
  /** 文件名，默认 format_templates.json */
  fileName?: string
  maxTemplates?: number
  familyThreshold?: number
  promoteUseThreshold?: number
  activeCriteria?: Partial<ActiveCriteria>
  decayDays?: number
  /** 哪些生命周期参与衰减。默认不含 instance —— 衰减 instance 会打断复用累计，见 applyDecay 注释 */
  decayLifecycles?: Lifecycle[]
  staleSampleSize?: number
  autoDemoteRejectCount?: number
  /** 同族但结构有演进时，是否生成新版本并取代旧版 */
  supersedeOnEvolution?: boolean
  /** 注入时钟，测试可固定 */
  now?: () => Date
  /** 每次变更立即落盘，默认 true */
  autoPersist?: boolean
  /** 是否打印降级日志，默认 true */
  verbose?: boolean
}

export interface AddInstanceInput {
  skeleton: XlsxSkeleton
  intentId?: string
  intentLabel?: string
  workflow?: string
  name?: string
  filePath?: string
  fileName?: string
  /** 额外的口径语句，合并进 template.norms */
  norms?: string[]
}

export type AddInstanceAction = 'created' | 'merged' | 'duplicate' | 'evolved' | 'rejected' | 'blocked'

export interface AddInstanceResult {
  action: AddInstanceAction
  reason?: string
  /** 落点模板：created/merged/duplicate 时是族头，evolved 时是新版本，rejected 时为 null */
  template: FormatTemplate | null
  /** 与族头的相似度；新建时为 0 */
  similarity: number
  /** 命中/新建的族头 id */
  familyId?: string
  /** 本次是否触发生命周期升格 */
  promotedTo?: Lifecycle
  /** 达到数量上限时的提示（不自动归档，只提示 + 列 stale） */
  capacityWarning?: CapacityWarning
}

export interface SaveAsTemplateInput {
  skeleton: XlsxSkeleton
  name: string
  intentId?: string
  intentLabel?: string
  workflow?: string
  filePath?: string
  fileName?: string
  norms?: string[]
  /** 默认 active —— 手动保存是唯一能直接到 active 的路径 */
  lifecycle?: Lifecycle
  /** 是否取代同族现有模板（默认 false，绝不静默覆盖） */
  supersede?: boolean
  /** 同名同意图且结构完全一致时，是否就地刷新而不新增（默认 true） */
  mergeSameName?: boolean
}

export interface SaveAsTemplateResult {
  template: FormatTemplate
  /** 被取代而归档的模板 id */
  superseded: string[]
  capacityWarning?: CapacityWarning
}

export interface CapacityWarning {
  current: number
  max: number
  message: string
  /** lastUsedAt 最久的若干条，供 UI 批量勾选 */
  stale: FormatTemplate[]
}

export interface LifecycleChange {
  /** 变更后的模板；id 不存在时为 null */
  template: FormatTemplate | null
  from: Lifecycle
  to: Lifecycle
  /** 未满足升格条件而被拒绝时的原因 */
  reason?: string
  changed: boolean
}

export interface DecayResult {
  scanned: number
  decayed: Array<{ id: string; name: string; lifecycle: Lifecycle; lastUsedAt: string; idleDays: number }>
}

export interface FindFamilyOptions {
  threshold?: number
  includeArchived?: boolean
  lifecycles?: Lifecycle[]
  limit?: number
}

export interface ListOptions {
  intentId?: string
  workflow?: string
  lifecycle?: Lifecycle | Lifecycle[]
  includeArchived?: boolean
}

export interface GetByIntentOptions {
  /** 只返回这些生命周期的模板。默认 ['active','candidate'] —— instance 与 archived 不参与注入 */
  lifecycles?: Lifecycle[]
  includeArchived?: boolean
}

export interface FormatTemplatePatch {
  name?: string
  intentId?: string
  intentLabel?: string
  workflow?: string
  norms?: string[]
  lifecycle?: Lifecycle
  skeleton?: XlsxSkeleton
}

export interface FormatTemplateBundle {
  kind: 'hrai-format-templates'
  version: number
  exportedAt: string
  templates: FormatTemplate[]
}

export type ImportResolution = 'overwrite' | 'keep' | 'rename'

export interface ImportConflict {
  /** 判重键：intentId + name */
  key: string
  incoming: FormatTemplate
  existing: FormatTemplate
  similarity: number
  /** 给 UI 预选的建议值 */
  suggestion: ImportResolution
}

export interface ImportOptions {
  /** 按 incoming.id 逐条裁决 */
  resolutions?: Record<string, ImportResolution>
  /** 全局默认处置。不传 = 不裁决，冲突原样返回等调用方决定 */
  defaultResolution?: ImportResolution
  renameSuffix?: string
}

export interface ImportResult {
  imported: number
  skipped: number
  renamed: Array<{ id: string; name: string }>
  overwritten: string[]
  conflicts: ImportConflict[]
  /** 未裁决的冲突 key 列表。非空表示本次导入未完成，需再次调用并带裁决 */
  unresolved: string[]
  errors: string[]
}

// ============ 纯函数工具 ============

function newId(): string {
  return `ft_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

function toInt(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function isSkeleton(x: unknown): x is XlsxSkeleton {
  return !!x && typeof x === 'object' && Array.isArray((x as XlsxSkeleton).sheets)
}

/**
 * 取主 sheet 的表头序列。非主 sheet 只有字段名，不参与聚合 ——
 * 否则「说明」页的字段名会稀释主骨架的相似度。
 */
export function headersOf(skeleton: XlsxSkeleton): string[] {
  if (!isSkeleton(skeleton)) return []
  const sheets = skeleton.sheets || []
  const primary = sheets.find(s => s.isPrimary) || sheets[0]
  if (!primary) return []
  return (primary.columns || []).map(c => String(c.key || '').trim()).filter(Boolean)
}

/** 去掉文件名里易变的时间成分：3月考勤汇总表 → 考勤汇总表 */
export function cleanName(raw: string): string {
  return String(raw || '')
    .replace(/\.[^.]+$/, '')
    // 连续 8 位日期（如 20260305）必须在 20\d{2} 之前处理，否则 20\d{2} 会把
    // 20260305 拆成 2026 + 0305，剩下的 0305 再也匹配不到 8 位规则 → 残留「0305」
    .replace(/\d{8}/g, '')
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, '')
    .replace(/20\d{2}\s*年?/g, '')
    .replace(/\d{1,2}\s*月/g, '')
    .replace(/\d{1,2}\s*日/g, '')
    .replace(/[_\-—]+/g, '')
    .trim()
}

/** 把三种入参统一成 FamilyKey */
export function toFamilyKey(target: SimilarityTarget): FamilyKey {
  if (Array.isArray(target)) {
    return { headers: target.map(h => String(h || '').trim()).filter(Boolean) }
  }
  if (isSkeleton(target)) {
    return { headers: headersOf(target), kind: 'xlsx' }
  }
  const key = target as FamilyKey
  return {
    headers: (key.headers || []).map(h => String(h || '').trim()).filter(Boolean),
    intentId: key.intentId,
    kind: key.kind
  }
}

/** 集合重合度 */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a)
  const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

/** 最长公共子序列长度（滚动数组，列数量级下够用） */
export function lcsLength(a: string[], b: string[]): number {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 0
  let prev = new Array<number>(m + 1).fill(0)
  let cur = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[m]
}

/**
 * 顺序一致度 = LCS / max(len)。
 * 用 LCS 而不是集合相似度，是因为 HR 表格的字段顺序本身就是口径
 * （审批链谁先谁后、台账哪列在前），打乱了就不叫套用。
 */
export function lcsOrderScore(a: string[], b: string[]): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0
  return lcsLength(a, b) / maxLen
}

/**
 * 结构相似度：0.6 × jaccard + 0.4 × lcsOrderScore。
 *
 * 任何一项前置条件不满足直接返回 0 —— 尤其是 intentId 不同。
 * 跨意图即使表头 100% 相同也必须判 0，宁可漏套不可错套。
 */
export function similarity(a: SimilarityTarget, b: SimilarityTarget): number {
  const ka = toFamilyKey(a)
  const kb = toFamilyKey(b)
  // 意图必须完全一致；有一侧缺失另一侧有值，同样视为不同族
  if ((ka.intentId ?? '') !== (kb.intentId ?? '')) return 0
  if ((ka.kind ?? 'xlsx') !== (kb.kind ?? 'xlsx')) return 0
  const A = ka.headers
  const B = kb.headers
  if (A.length === 0 || B.length === 0) return 0
  return W_JACCARD * jaccard(A, B) + W_ORDER * lcsOrderScore(A, B)
}

function normalizeLifecycle(v: unknown): Lifecycle {
  return LIFECYCLES.includes(v as Lifecycle) ? (v as Lifecycle) : 'instance'
}

function normalizeEvidence(raw: unknown): FormatTemplateEvidence | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const filePath = typeof e.filePath === 'string' ? e.filePath : ''
  if (!filePath) return null
  return {
    filePath,
    fileName: typeof e.fileName === 'string' ? e.fileName : path.basename(filePath),
    extractedAt: typeof e.extractedAt === 'string' ? e.extractedAt : new Date().toISOString(),
    pathMissing: e.pathMissing === true ? true : undefined
  }
}

/** 兜底补齐字段，保证任何一个坏条目都不会把整个库带崩 */
function normalizeTemplate(raw: unknown): FormatTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, any>
  if (!r.skeleton || !Array.isArray(r.skeleton.sheets)) return null
  const now = new Date().toISOString()
  const stats = r.stats && typeof r.stats === 'object' ? r.stats : {}
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    name: typeof r.name === 'string' && r.name ? r.name : '未命名格式',
    intentId: typeof r.intentId === 'string' && r.intentId ? r.intentId : undefined,
    intentLabel: typeof r.intentLabel === 'string' ? r.intentLabel : undefined,
    workflow: typeof r.workflow === 'string' ? r.workflow : undefined,
    kind: 'xlsx',
    lifecycle: normalizeLifecycle(r.lifecycle),
    version: toInt(r.version) || 1,
    supersedes: typeof r.supersedes === 'string' ? r.supersedes : undefined,
    effectiveFrom: typeof r.effectiveFrom === 'string' ? r.effectiveFrom : r.createdAt || now,
    skeleton: r.skeleton as XlsxSkeleton,
    norms: Array.isArray(r.norms) ? r.norms.map(String) : [],
    stats: {
      useCount: toInt(stats.useCount),
      acceptCount: toInt(stats.acceptCount),
      rejectCount: toInt(stats.rejectCount),
      lastUsedAt: typeof stats.lastUsedAt === 'string' ? stats.lastUsedAt : r.updatedAt || r.createdAt || now,
      lastAcceptedAt: typeof stats.lastAcceptedAt === 'string' ? stats.lastAcceptedAt : undefined
    },
    evidence: Array.isArray(r.evidence)
      ? r.evidence.map(normalizeEvidence).filter((x): x is FormatTemplateEvidence => !!x)
      : [],
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return (b - a) / DAY_MS
}

/** 判重键：intentId + name（设计文档 §8.1 导入策略） */
function dedupeKey(intentId: string | undefined, name: string): string {
  return `${intentId ?? ''}::${name}`
}

// ============ 存储主体 ============

interface ResolvedOptions {
  maxTemplates: number
  familyThreshold: number
  promoteUseThreshold: number
  activeCriteria: ActiveCriteria
  decayDays: number
  decayLifecycles: Lifecycle[]
  staleSampleSize: number
  autoDemoteRejectCount: number
  supersedeOnEvolution: boolean
  now: () => Date
  autoPersist: boolean
  verbose: boolean
}

export class SkeletonStore {
  private readonly dataDir: string
  private readonly filePath: string
  private readonly cfg: ResolvedOptions

  private templates: FormatTemplate[] = []
  private loaded = false
  private lastMtimeMs = -1
  /** 串行化所有「读-改-写」，避免 IPC 异步并发时丢更新 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: SkeletonStoreOptions) {
    if (!opts || typeof opts.dataDir !== 'string' || !opts.dataDir) {
      throw new Error('[skeleton-store] dataDir 必须由外部注入，本模块不得 import electron')
    }
    this.dataDir = opts.dataDir
    this.filePath = path.join(this.dataDir, opts.fileName || DEFAULT_FILE_NAME)
    const ac = opts.activeCriteria || {}
    this.cfg = {
      maxTemplates: opts.maxTemplates ?? DEFAULT_MAX_TEMPLATES,
      familyThreshold: opts.familyThreshold ?? DEFAULT_FAMILY_THRESHOLD,
      promoteUseThreshold: opts.promoteUseThreshold ?? DEFAULT_PROMOTE_USE_THRESHOLD,
      activeCriteria: {
        minAcceptCount: ac.minAcceptCount ?? 1,
        maxRejectCount: ac.maxRejectCount ?? 0
      },
      decayDays: opts.decayDays ?? DEFAULT_DECAY_DAYS,
      // 默认不含 instance：见 applyDecay 的说明
      decayLifecycles:
        opts.decayLifecycles && opts.decayLifecycles.length > 0
          ? [...opts.decayLifecycles]
          : ['candidate', 'active'],
      staleSampleSize: opts.staleSampleSize ?? DEFAULT_STALE_SAMPLE_SIZE,
      autoDemoteRejectCount: opts.autoDemoteRejectCount ?? DEFAULT_AUTO_DEMOTE_REJECT_COUNT,
      supersedeOnEvolution: opts.supersedeOnEvolution !== false,
      now: opts.now || (() => new Date()),
      autoPersist: opts.autoPersist !== false,
      verbose: opts.verbose !== false
    }
  }

  // ---------- 基础设施 ----------

  private nowIso(): string {
    return this.cfg.now().toISOString()
  }

  private log(...args: unknown[]): void {
    if (this.cfg.verbose) console.log('[skeleton-store]', ...args)
  }

  private warn(...args: unknown[]): void {
    console.warn('[skeleton-store]', ...args)
  }

  /** 加载（可重复调用）。JSON 损坏时保留副本并降级为空库，不让整个应用崩 */
  async init(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    this.templates = this.readFromDisk()
    this.lastMtimeMs = this.safeMtime()
    this.loaded = true
  }

  /** 丢弃内存态重新读盘。调试/测试用 */
  async reload(): Promise<void> {
    this.loaded = false
    await this.init()
  }

  /** 把内存态写回磁盘（原子写） */
  flush(): void {
    this.persist()
  }

  /** 原子写：先写临时文件再 rename，避免写一半崩溃留下半个 JSON */
  private persist(): void {
    try {
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.tmp`
      const payload = JSON.stringify({ version: STORE_VERSION, templates: this.templates }, null, 2)
      fs.writeFileSync(tmp, payload, 'utf-8')
      fs.renameSync(tmp, this.filePath)
      this.lastMtimeMs = this.safeMtime()
    } catch (err) {
      this.warn('写盘失败：', err)
    }
  }

  private safeMtime(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs
    } catch {
      return -1
    }
  }

  private readFromDisk(): FormatTemplate[] {
    if (!fs.existsSync(this.filePath)) return []
    let raw = ''
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      this.warn('读取失败，降级为空库：', err)
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed?.templates
      if (!Array.isArray(list)) throw new Error('顶层结构既不是数组也不含 templates 数组')
      const out: FormatTemplate[] = []
      for (const item of list) {
        const t = normalizeTemplate(item)
        if (t) out.push(t)
      }
      return out
    } catch (err) {
      this.warn('JSON 损坏，降级为空库并保留损坏副本：', err)
      this.backupCorrupt(raw)
      return []
    }
  }

  /** 损坏文件另存一份，原文件不动 —— 用户可能还想手工捞回来 */
  private backupCorrupt(raw: string): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = path.join(this.dataDir, `${CORRUPT_BACKUP_PREFIX}${stamp}.json`)
      fs.writeFileSync(backup, typeof raw === 'string' ? raw : String(raw), 'utf-8')
      this.warn('损坏副本已写入：', backup)
    } catch (err) {
      this.warn('备份损坏文件失败：', err)
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.templates = this.readFromDisk()
      this.lastMtimeMs = this.safeMtime()
      this.loaded = true
    }
  }

  /**
   * 磁盘被别的进程改过就先重新加载。
   * 本进程每次变更都是同步落盘，所以内存态与磁盘一致时这里不会误丢更新。
   */
  private refreshIfChanged(): void {
    const mtime = this.safeMtime()
    if (mtime !== this.lastMtimeMs) {
      this.templates = this.readFromDisk()
      this.lastMtimeMs = mtime
    }
  }

  private withLock<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 所有写操作都走这里：串行 + 变更前重读 + 变更后落盘 */
  private mutate<T>(fn: () => T): Promise<T> {
    return this.withLock(() => {
      this.ensureLoaded()
      this.refreshIfChanged()
      const out = fn()
      if (this.cfg.autoPersist) this.persist()
      return out
    })
  }

  /** 纯读也串行，保证读到的是最新落盘结果 */
  private read<T>(fn: () => T): Promise<T> {
    return this.withLock(() => {
      this.ensureLoaded()
      this.refreshIfChanged()
      return fn()
    })
  }

  private find(id: string): FormatTemplate | undefined {
    return this.templates.find(t => t.id === id)
  }

  // ---------- 查询 ----------

  /** 全量（含 archived） */
  async listAll(): Promise<FormatTemplate[]> {
    return this.read(() => this.templates.map(t => clone(t)))
  }

  /** 默认排除 archived —— 归档即弃用，UI 与召回都不该看到 */
  async list(opts?: ListOptions): Promise<FormatTemplate[]> {
    return this.read(() => this.listSync(opts))
  }

  private listSync(opts?: ListOptions): FormatTemplate[] {
    const o = opts || {}
    const lifecycles = o.lifecycle
      ? Array.isArray(o.lifecycle)
        ? o.lifecycle
        : [o.lifecycle]
      : null
    return this.templates
      .filter(t => (o.includeArchived ? true : t.lifecycle !== 'archived'))
      .filter(t => (lifecycles ? lifecycles.includes(t.lifecycle) : true))
      .filter(t => (o.intentId ? t.intentId === o.intentId : true))
      .filter(t => (o.workflow ? t.workflow === o.workflow : true))
      .map(t => clone(t))
  }

  async get(id: string): Promise<FormatTemplate | null> {
    return this.read(() => {
      const t = this.find(id)
      return t ? clone(t) : null
    })
  }

  /**
   * 第 3 步召回入口：按意图取可注入的模板。
   * 默认只返回 active / candidate —— instance 没到注入门槛，archived 不注入（设计文档 §5）。
   * 严格按 intentId 精确匹配，不做跨意图兜底。
   */
  async getByIntent(intentId: string, opts?: GetByIntentOptions): Promise<FormatTemplate[]> {
    return this.read(() => {
      const lifecycles = opts?.lifecycles || ['active', 'candidate']
      return this.templates
        .filter(t => t.intentId === intentId)
        .filter(t => (opts?.includeArchived ? true : t.lifecycle !== 'archived'))
        .filter(t => lifecycles.includes(t.lifecycle))
        .sort((a, b) => {
          const rank = LIFECYCLE_RANK[b.lifecycle] - LIFECYCLE_RANK[a.lifecycle]
          if (rank !== 0) return rank
          return Date.parse(b.stats.lastUsedAt || b.updatedAt) - Date.parse(a.stats.lastUsedAt || a.updatedAt)
        })
        .map(t => clone(t))
    })
  }

  /**
   * 同步版 getByIntent（第 4 步 intent-router 挂载用）。
   * 读取不走异步锁：即使与本进程的写操作在同一 tick 略有错位，对 prompt 注入也无影响。
   * 仅做读，绝不触发任何写。
   */
  getByIntentSync(intentId: string, opts?: GetByIntentOptions): FormatTemplate[] {
    this.ensureLoaded()
    this.refreshIfChanged()
    const lifecycles = opts?.lifecycles || ['active', 'candidate']
    return this.templates
      .filter(t => t.intentId === intentId)
      .filter(t => (opts?.includeArchived ? true : t.lifecycle !== 'archived'))
      .filter(t => lifecycles.includes(t.lifecycle))
      .sort((a, b) => {
        const rank = LIFECYCLE_RANK[b.lifecycle] - LIFECYCLE_RANK[a.lifecycle]
        if (rank !== 0) return rank
        return Date.parse(b.stats.lastUsedAt || b.updatedAt) - Date.parse(a.stats.lastUsedAt || a.updatedAt)
      })
      .map(t => clone(t))
  }

  /**
   * 按产出文件路径反查意图：任务结束采集时 evidence 已带上 intentId，手动采纳时继承之。
   *
   * 只读方法（P0-1 修复专用）：遍历全库（含 archived）找 evidence 命中该路径的第一条，
   * 返回其 intentId/intentLabel/workflow；找不到返回 null。
   * 与 getByIntentSync 同风格：同步遍历、不走异步锁、绝不写盘。
   */
  findIntentByEvidence(filePath: string): { intentId?: string; intentLabel?: string; workflow?: string } | null {
    if (!filePath) return null
    this.ensureLoaded()
    this.refreshIfChanged()
    for (const t of this.templates) {
      if (t.evidence.some(e => e.filePath === filePath)) {
        return { intentId: t.intentId, intentLabel: t.intentLabel, workflow: t.workflow }
      }
    }
    return null
  }

  /** 同 workflow 的跨意图模板，第 3 步「同 workflow 得 0.5」那一档用 */
  async getByWorkflow(workflow: string, excludeIntentId?: string): Promise<FormatTemplate[]> {
    return this.read(() =>
      this.templates
        .filter(t => t.workflow === workflow)
        .filter(t => (excludeIntentId ? t.intentId !== excludeIntentId : true))
        .filter(t => t.lifecycle !== 'archived')
        .sort((a, b) => LIFECYCLE_RANK[b.lifecycle] - LIFECYCLE_RANK[a.lifecycle])
        .map(t => clone(t))
    )
  }

  /** 相似度聚合：返回同族模板，按相似度降序 */
  async findFamily(target: SimilarityTarget, opts?: FindFamilyOptions): Promise<FormatTemplate[]> {
    return this.read(() => this.findFamilySync(target, opts))
  }

  /** 以库内某条模板为基准找同族（UI「查看同族」用） */
  async findFamilyById(id: string, opts?: FindFamilyOptions): Promise<FormatTemplate[]> {
    return this.read(() => {
      const base = this.find(id)
      if (!base) return []
      return this.findFamilySync(this.keyOfTemplate(base), opts).filter(t => t.id !== id)
    })
  }

  private findFamilySync(target: SimilarityTarget, opts?: FindFamilyOptions): FormatTemplate[] {
    const threshold = opts?.threshold ?? this.cfg.familyThreshold
    const lifecycles = opts?.lifecycles
    const pool = this.templates.filter(t =>
      opts?.includeArchived ? true : t.lifecycle !== 'archived'
    )
    const key = toFamilyKey(target)
    const scored: Array<{ t: FormatTemplate; sim: number }> = []
    for (const t of pool) {
      if (lifecycles && !lifecycles.includes(t.lifecycle)) continue
      const sim = similarity(key, this.keyOfTemplate(t))
      if (sim >= threshold) scored.push({ t, sim })
    }
    scored.sort((a, b) => {
      if (b.sim !== a.sim) return b.sim - a.sim
      const rank = LIFECYCLE_RANK[b.t.lifecycle] - LIFECYCLE_RANK[a.t.lifecycle]
      if (rank !== 0) return rank
      return Date.parse(b.t.updatedAt) - Date.parse(a.t.updatedAt)
    })
    const out = scored.map(x => clone(x.t))
    return opts?.limit && opts.limit > 0 ? out.slice(0, opts.limit) : out
  }

  private keyOfTemplate(t: FormatTemplate): FamilyKey {
    return { headers: headersOf(t.skeleton), intentId: t.intentId, kind: t.kind }
  }

  // ---------- 数量上限 ----------

  /** 未归档模板数 */
  async count(): Promise<number> {
    return this.read(() => this.templates.filter(t => t.lifecycle !== 'archived').length)
  }

  /**
   * 达到上限时的提示。刻意不做任何自动归档 ——
   * 模板是用户确认过的资产，自动删除的风险高于收益（设计文档 §8.2 决策 2）。
   */
  async checkCapacity(): Promise<CapacityWarning | null> {
    return this.read(() => this.checkCapacitySync())
  }

  private checkCapacitySync(): CapacityWarning | null {
    const alive = this.templates.filter(t => t.lifecycle !== 'archived')
    if (alive.length < this.cfg.maxTemplates) return null
    return {
      current: alive.length,
      max: this.cfg.maxTemplates,
      message: `格式模板已达 ${alive.length} 份（上限 ${this.cfg.maxTemplates} 份），建议归档长期未用的`,
      stale: this.listStaleSync(this.cfg.staleSampleSize)
    }
  }

  /** lastUsedAt 最久的 n 条，供数量上限提示里批量勾选 */
  async listStale(n?: number): Promise<FormatTemplate[]> {
    return this.read(() => this.listStaleSync(n ?? this.cfg.staleSampleSize))
  }

  private listStaleSync(n: number): FormatTemplate[] {
    return this.templates
      .filter(t => t.lifecycle !== 'archived')
      .slice()
      .sort((a, b) => {
        const d = Date.parse(a.stats.lastUsedAt || a.createdAt) - Date.parse(b.stats.lastUsedAt || b.createdAt)
        if (d !== 0) return d
        const c = Date.parse(a.createdAt) - Date.parse(b.createdAt)
        if (c !== 0) return c
        return a.id.localeCompare(b.id)
      })
      .slice(0, Math.max(0, n))
      .map(t => clone(t))
  }

  // ---------- 归档为实例 ----------

  /**
   * 把一次抽取结果归档为实例。
   *
   * 不计入用户可见模板，只留指纹并做相似度聚合：
   *   - 命中同族且表头完全一致 → 并入族头，useCount++（复用计数）
   *   - 命中同族但结构有演进 → 生成新版本，旧版被取代（active 除外，不静默退役用户确认过的）
   *   - 未命中 → 新建 instance
   * 达到数量上限时仍然创建，但返回 capacityWarning，由 UI 提示用户自行归档。
   */
  async addInstance(input: AddInstanceInput): Promise<AddInstanceResult> {
    return this.mutate(() => {
      const skeleton = input?.skeleton
      if (!isSkeleton(skeleton)) {
        return { action: 'rejected' as AddInstanceAction, reason: '骨架为空或结构不合法', template: null, similarity: 0 }
      }
      const headers = headersOf(skeleton)
      if (headers.length < 2) {
        return {
          action: 'rejected' as AddInstanceAction,
          reason: '主 sheet 字段数不足 2，不足以形成格式模板',
          template: null,
          similarity: 0
        }
      }

      const now = this.nowIso()
      const key: FamilyKey = { headers, intentId: input.intentId, kind: 'xlsx' }
      const family = this.findFamilySync(key, { threshold: this.cfg.familyThreshold })
      // 注意：findFamilySync 返回的是深拷贝副本，不是 this.templates 里的真身。
      // 合并时必须在「真身」上改（骨架/口径/useCount/证据/升格），否则改动只落在
      // 副本上，persist 落盘的真身永远是初态 —— 复用计数、升格判定全失效（T12 踩过这个坑）。
      const headRef = family[0]
      const head = headRef ? this.find(headRef.id) : undefined
      const sim = headRef ? similarity(key, this.keyOfTemplate(headRef)) : 0

      // —— 情况一：结构完全一致，并入族头
      if (head && sim >= 0.999) {
        const dup = input.filePath ? head.evidence.some(e => e.filePath === input.filePath) : false
        if (dup) {
          // 同一个产物文件被重复扫描，不重复计数
          head.updatedAt = now
          return {
            action: 'duplicate' as AddInstanceAction,
            template: clone(head),
            similarity: sim,
            familyId: head.id
          }
        }
        head.skeleton = clone(skeleton)
        head.norms = mergeNorms(skeleton.norms, input.norms)
        head.stats.useCount += 1
        head.stats.lastUsedAt = now
        head.updatedAt = now
        if (input.intentLabel) head.intentLabel = input.intentLabel
        if (input.workflow) head.workflow = input.workflow
        this.appendEvidence(head, input, now)
        const promotedTo = this.tryPromoteByUse(head, now)
        const capacityWarning = this.checkCapacitySync() || undefined
        return {
          action: 'merged' as AddInstanceAction,
          template: clone(head),
          similarity: sim,
          familyId: head.id,
          promotedTo,
          capacityWarning
        }
      }

      // —— 情况二：同族但结构有演进，生成新版本
      if (head && this.cfg.supersedeOnEvolution) {
        const prev = this.find(head.id)
        const next = this.buildTemplate({
          skeleton,
          intentId: input.intentId,
          intentLabel: input.intentLabel,
          workflow: input.workflow,
          name: input.name || head.name,
          norms: mergeNorms(skeleton.norms, input.norms),
          now,
          version: (prev?.version || 1) + 1,
          supersedes: head.id,
          lifecycle: 'instance'
        })
        // 复用历史可以继承（同族演进，使用记录是真实的），
        // 但信任度必须重新积累 —— accept/reject 清零，否则新结构会白蹭 active 强度
        next.stats.useCount = (prev?.stats.useCount || 0) + 1
        next.stats.lastUsedAt = now
        this.appendEvidence(next, input, now)
        // 复用历史继承过来了，所以这里也要走一次升格判定，否则会出现
        // 「useCount 已经 3 次却还是 instance」这种自相矛盾的状态
        const promotedTo = this.tryPromoteByUse(next, now)
        this.templates.push(next)

        // 被新版取代 → archived。但用户确认过的 active 不静默退役
        if (prev && prev.lifecycle !== 'active') {
          prev.lifecycle = 'archived'
          prev.updatedAt = now
        }
        const capacityWarning = this.checkCapacitySync() || undefined
        return {
          action: 'evolved' as AddInstanceAction,
          template: clone(next),
          similarity: sim,
          familyId: head.id,
          promotedTo,
          capacityWarning
        }
      }

      // —— 情况三：同族但关闭了演进取代，或没有同族 → 新建
      if (head) {
        // 演进取代被关闭时，退化为并入族头但保留族头原结构（不丢用户已确认的骨架）
        this.appendEvidence(head, input, now)
        head.stats.useCount += 1
        head.stats.lastUsedAt = now
        head.updatedAt = now
        const promotedTo = this.tryPromoteByUse(head, now)
        return {
          action: 'merged' as AddInstanceAction,
          template: clone(head),
          similarity: sim,
          familyId: head.id,
          promotedTo,
          capacityWarning: this.checkCapacitySync() || undefined
        }
      }

      const created = this.buildTemplate({
        skeleton,
        intentId: input.intentId,
        intentLabel: input.intentLabel,
        workflow: input.workflow,
        name: input.name || this.deriveName(input, skeleton),
        norms: mergeNorms(skeleton.norms, input.norms),
        now,
        version: 1,
        lifecycle: 'instance'
      })
      created.stats.useCount = 1
      created.stats.lastUsedAt = now
      this.appendEvidence(created, input, now)
      this.templates.push(created)
      return {
        action: 'created' as AddInstanceAction,
        template: clone(created),
        similarity: 0,
        familyId: created.id,
        capacityWarning: this.checkCapacitySync() || undefined
      }
    })
  }

  private deriveName(input: { fileName?: string; filePath?: string }, skeleton: XlsxSkeleton): string {
    // 优先用 fileName；只有 filePath 时先取 basename，否则绝对路径会被当成文件名保留下来
    const src = input.fileName || (input.filePath ? path.basename(input.filePath) : '')
    const fromFile = cleanName(src)
    if (fromFile) return fromFile
    const primary = (skeleton.sheets || []).find(s => s.isPrimary) || skeleton.sheets?.[0]
    if (primary?.name) return primary.name
    return '未命名格式'
  }

  private buildTemplate(args: {
    skeleton: XlsxSkeleton
    intentId?: string
    intentLabel?: string
    workflow?: string
    name: string
    norms: string[]
    now: string
    version: number
    supersedes?: string
    lifecycle: Lifecycle
  }): FormatTemplate {
    return {
      id: newId(),
      name: args.name,
      intentId: args.intentId,
      intentLabel: args.intentLabel,
      workflow: args.workflow,
      kind: 'xlsx',
      lifecycle: args.lifecycle,
      version: args.version,
      supersedes: args.supersedes,
      effectiveFrom: args.now,
      skeleton: clone(args.skeleton),
      norms: args.norms.slice(),
      stats: {
        useCount: 0,
        acceptCount: 0,
        rejectCount: 0,
        lastUsedAt: args.now
      },
      evidence: [],
      createdAt: args.now,
      updatedAt: args.now
    }
  }

  private appendEvidence(t: FormatTemplate, input: AddInstanceInput, now: string): void {
    if (!input.filePath) return
    if (t.evidence.some(e => e.filePath === input.filePath)) return
    t.evidence.push({
      filePath: input.filePath,
      fileName: input.fileName || path.basename(input.filePath),
      extractedAt: now
    })
  }

  /** 源文件还在不在。只存 schema 不存副本，所以删了也能套用，只是标记一下便于 UI 提示 */
  syncEvidenceExistence(): number {
    let changed = 0
    for (const t of this.templates) {
      for (const e of t.evidence) {
        const missing = !fs.existsSync(e.filePath)
        if (missing !== (e.pathMissing === true)) {
          e.pathMissing = missing ? true : undefined
          changed++
        }
      }
    }
    return changed
  }

  // ---------- 用户手动保存 ----------

  /**
   * 用户手动「存为我的格式」—— 唯一能直接到 active 的路径（设计文档 §7 强信号）。
   * 默认不取代同族现有模板；只有显式传 supersede: true 才会把旧版归档。
   */
  async saveAsTemplate(input: SaveAsTemplateInput): Promise<SaveAsTemplateResult> {
    return this.mutate(() => {
      const skeleton = input?.skeleton
      if (!isSkeleton(skeleton)) throw new Error('[skeleton-store] saveAsTemplate: 骨架为空或结构不合法')
      const headers = headersOf(skeleton)
      if (headers.length < 2) {
        throw new Error('[skeleton-store] saveAsTemplate: 主 sheet 字段数不足 2，不足以形成格式模板')
      }
      const now = this.nowIso()
      const name = (input.name || '').trim() || this.deriveName(input, skeleton)
      const lifecycle: Lifecycle = input.lifecycle && input.lifecycle !== 'instance' ? input.lifecycle : 'active'
      const norms = mergeNorms(skeleton.norms, input.norms)

      // 同名同意图且结构完全一致 → 就地刷新，不产生重复条目
      if (input.mergeSameName !== false) {
        const same = this.templates.find(
          t =>
            t.lifecycle !== 'archived' &&
            dedupeKey(t.intentId, t.name) === dedupeKey(input.intentId, name) &&
            similarity(this.keyOfTemplate(t), { headers, intentId: input.intentId, kind: 'xlsx' }) >= 0.999
        )
        if (same) {
          same.skeleton = clone(skeleton)
          same.norms = norms
          same.lifecycle = lifecycle
          same.effectiveFrom = now
          same.updatedAt = now
          same.stats.lastUsedAt = now
          if (input.intentLabel) same.intentLabel = input.intentLabel
          if (input.workflow) same.workflow = input.workflow
          this.appendEvidence(same, input as AddInstanceInput, now)
          return { template: clone(same), superseded: [], capacityWarning: this.checkCapacitySync() || undefined }
        }
      }

      const key: FamilyKey = { headers, intentId: input.intentId, kind: 'xlsx' }
      const family = this.findFamilySync(key, { threshold: this.cfg.familyThreshold })
      const head = family[0]
      const superseded: string[] = []

      const created = this.buildTemplate({
        skeleton,
        intentId: input.intentId,
        intentLabel: input.intentLabel,
        workflow: input.workflow,
        name,
        norms,
        now,
        version: head ? head.version + 1 : 1,
        supersedes: head?.id,
        lifecycle
      })
      created.stats.useCount = Math.max(1, head?.stats.useCount || 1)
      created.stats.lastUsedAt = now
      this.appendEvidence(created, input as AddInstanceInput, now)
      this.templates.push(created)

      // 显式取代才归档旧版；绝不静默覆盖用户已确认过的资产
      if (input.supersede === true && head) {
        const prev = this.find(head.id)
        if (prev) {
          prev.lifecycle = 'archived'
          prev.updatedAt = now
          superseded.push(prev.id)
        }
      }

      return {
        template: clone(created),
        superseded,
        capacityWarning: this.checkCapacitySync() || undefined
      }
    })
  }

  // ---------- 生命周期 ----------

  /** candidate 升 active 的唯一判定点，条件可配置，全库只此一处 */
  canPromoteToActive(t: FormatTemplate): boolean {
    const c = this.cfg.activeCriteria
    return t.stats.acceptCount >= c.minAcceptCount && t.stats.rejectCount <= c.maxRejectCount
  }

  /** 复用次数达标 → candidate。刻意要求 ≥2 次，1 次不升格 */
  private tryPromoteByUse(t: FormatTemplate, now: string): Lifecycle | undefined {
    if (t.lifecycle !== 'instance') return undefined
    if (t.stats.useCount < this.cfg.promoteUseThreshold) return undefined
    t.lifecycle = 'candidate'
    t.updatedAt = now
    return 'candidate'
  }

  /**
   * 升一级：instance → candidate → active。
   * archived 不可逆，需要恢复请用 update({ lifecycle: 'candidate' })。
   */
  async promote(id: string, opts?: { force?: boolean }): Promise<LifecycleChange> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) {
        return { template: null, from: 'instance', to: 'instance', changed: false, reason: '模板不存在' }
      }
      const from = t.lifecycle
      const now = this.nowIso()
      if (from === 'archived') {
        return { template: clone(t), from, to: from, changed: false, reason: '已归档，promote 不恢复；请用 update 改 lifecycle' }
      }
      if (from === 'active') {
        return { template: clone(t), from, to: from, changed: false }
      }
      if (from === 'instance') {
        if (t.stats.useCount < this.cfg.promoteUseThreshold && !opts?.force) {
          return {
            template: clone(t),
            from,
            to: from,
            changed: false,
            reason: `复用 ${t.stats.useCount} 次，未满 ${this.cfg.promoteUseThreshold} 次，不得升格`
          }
        }
        t.lifecycle = 'candidate'
        t.updatedAt = now
        return { template: clone(t), from, to: 'candidate', changed: true }
      }
      // candidate → active
      if (!this.canPromoteToActive(t) && !opts?.force) {
        return {
          template: clone(t),
          from,
          to: from,
          changed: false,
          reason: `未满足升格条件：acceptCount >= ${this.cfg.activeCriteria.minAcceptCount} 且 rejectCount <= ${this.cfg.activeCriteria.maxRejectCount}（当前 ${t.stats.acceptCount} / ${t.stats.rejectCount}）`
        }
      }
      t.lifecycle = 'active'
      t.effectiveFrom = now
      t.updatedAt = now
      return { template: clone(t), from, to: 'active', changed: true }
    })
  }

  /**
   * 降一级：active → candidate → instance → archived。
   * 用户点「本次不套用」累积到阈值时由 recordReject 自动调用。
   */
  async demote(id: string): Promise<LifecycleChange> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) {
        return { template: null, from: 'instance', to: 'instance', changed: false, reason: '模板不存在' }
      }
      const from = t.lifecycle
      const now = this.nowIso()
      const next: Record<Lifecycle, Lifecycle> = {
        active: 'candidate',
        candidate: 'instance',
        instance: 'archived',
        archived: 'archived'
      }
      const to = next[from]
      if (to === from) return { template: clone(t), from, to, changed: false }
      t.lifecycle = to
      t.updatedAt = now
      return { template: clone(t), from, to, changed: true }
    })
  }

  /** 弃用（§8.1 的 format:delete 语义就是归档，不做物理删除） */
  async archive(id: string): Promise<boolean> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) return false
      t.lifecycle = 'archived'
      t.updatedAt = this.nowIso()
      return true
    })
  }

  /** 数量上限提示里的批量归档 */
  async archiveMany(ids: string[]): Promise<number> {
    return this.mutate(() => {
      const set = new Set(ids || [])
      let n = 0
      const now = this.nowIso()
      for (const t of this.templates) {
        if (set.has(t.id) && t.lifecycle !== 'archived') {
          t.lifecycle = 'archived'
          t.updatedAt = now
          n++
        }
      }
      return n
    })
  }

  // ---------- 统计回写 ----------

  async recordUse(id: string): Promise<FormatTemplate | null> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) return null
      const now = this.nowIso()
      t.stats.useCount += 1
      t.stats.lastUsedAt = now
      t.updatedAt = now
      this.tryPromoteByUse(t, now)
      return clone(t)
    })
  }

  /** 采纳：唯一能让 candidate 自动升 active 的回写 */
  async recordAccept(id: string): Promise<FormatTemplate | null> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) return null
      const now = this.nowIso()
      t.stats.acceptCount += 1
      t.stats.lastUsedAt = now
      t.stats.lastAcceptedAt = now
      t.updatedAt = now
      if (t.lifecycle === 'candidate' && this.canPromoteToActive(t)) {
        t.lifecycle = 'active'
        t.effectiveFrom = now
      }
      return clone(t)
    })
  }

  /** 拒绝：连续拒绝到阈值，active 自动降级为 candidate */
  async recordReject(id: string): Promise<FormatTemplate | null> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) return null
      const now = this.nowIso()
      t.stats.rejectCount += 1
      t.stats.lastUsedAt = now
      t.updatedAt = now
      if (t.lifecycle === 'active' && t.stats.rejectCount >= this.cfg.autoDemoteRejectCount) {
        t.lifecycle = 'candidate'
      }
      return clone(t)
    })
  }

  // ---------- 衰减 ----------

  /**
   * 90 天未用 → archived。
   *
   * 刻意不衰减 instance：instance 是系统自动留档的观察记录，用户从未确认过它，
   * 而且 findFamily 默认排除 archived，一旦把 instance 衰减掉，下次同类任务就
   * 找不到族头、复用次数永远累计不到 2 次，这条格式族再也升不了 candidate。
   * 换句话说：衰减 instance 不是「清理」，是「误伤」。
   * 需要清理 instance 时走 listStale + archiveMany，由用户勾选决定。
   */
  async applyDecay(): Promise<DecayResult> {
    return this.mutate(() => {
      const now = this.nowIso()
      const decayed: DecayResult['decayed'] = []
      let scanned = 0
      for (const t of this.templates) {
        if (t.lifecycle === 'archived') continue
        if (!this.cfg.decayLifecycles.includes(t.lifecycle)) continue
        scanned++
        const last = t.stats.lastUsedAt || t.updatedAt || t.createdAt
        const idleDays = daysBetween(last, now)
        if (idleDays > this.cfg.decayDays) {
          t.lifecycle = 'archived'
          t.updatedAt = now
          decayed.push({ id: t.id, name: t.name, lifecycle: t.lifecycle, lastUsedAt: last, idleDays: Math.round(idleDays) })
        }
      }
      if (decayed.length > 0) this.log(`衰减归档 ${decayed.length} 条（>${this.cfg.decayDays} 天未用）`)
      return { scanned, decayed }
    })
  }

  // ---------- 编辑 ----------

  /** 改名 / 改口径 / 改 lifecycle / 换骨架 */
  async update(id: string, patch: FormatTemplatePatch): Promise<FormatTemplate | null> {
    return this.mutate(() => {
      const t = this.find(id)
      if (!t) return null
      const now = this.nowIso()
      if (patch.name !== undefined && String(patch.name).trim()) t.name = String(patch.name).trim()
      if (patch.intentId !== undefined) t.intentId = patch.intentId
      if (patch.intentLabel !== undefined) t.intentLabel = patch.intentLabel
      if (patch.workflow !== undefined) t.workflow = patch.workflow
      if (patch.norms !== undefined) t.norms = patch.norms.map(String)
      if (patch.skeleton !== undefined && isSkeleton(patch.skeleton)) t.skeleton = clone(patch.skeleton)
      if (patch.lifecycle !== undefined) {
        t.lifecycle = normalizeLifecycle(patch.lifecycle)
        if (t.lifecycle === 'active') t.effectiveFrom = now
      }
      t.updatedAt = now
      return clone(t)
    })
  }

  // ---------- 导入导出 ----------

  async exportAll(): Promise<FormatTemplateBundle> {
    return this.read(() => ({
      kind: 'hrai-format-templates' as const,
      version: STORE_VERSION,
      exportedAt: this.nowIso(),
      templates: this.templates.map(t => clone(t))
    }))
  }

  /**
   * 导入。按 intentId + name 判重，冲突时**不静默覆盖** ——
   * 未给出裁决的条目原样留在 conflicts 里返回，等调用方逐条决定（设计文档 §8.1 决策 3）。
   * 拿到结果后再次调用本方法并带上 resolutions / defaultResolution 即可完成导入。
   */
  async importAll(bundle: unknown, opts?: ImportOptions): Promise<ImportResult> {
    return this.mutate(() => {
      const result: ImportResult = {
        imported: 0,
        skipped: 0,
        renamed: [],
        overwritten: [],
        conflicts: [],
        unresolved: [],
        errors: []
      }
      const list = this.extractBundleTemplates(bundle)
      if (!list) {
        result.errors.push('导入内容不是合法的格式模板包（缺 templates 数组）')
        return result
      }
      const now = this.nowIso()
      const suffix = opts?.renameSuffix || DEFAULT_RENAME_SUFFIX
      const resolutions = opts?.resolutions || {}

      for (const rawItem of list) {
        const incoming = normalizeTemplate(rawItem)
        if (!incoming) {
          result.errors.push('跳过一条无法解析的模板记录')
          continue
        }
        const key = dedupeKey(incoming.intentId, incoming.name)
        const existing = this.templates.find(
          t => t.id === incoming.id || dedupeKey(t.intentId, t.name) === key
        )

        if (!existing) {
          const fresh = { ...incoming, id: this.ensureUniqueId(incoming.id), updatedAt: now }
          this.templates.push(fresh)
          result.imported++
          continue
        }

        const identical =
          similarity(this.keyOfTemplate(existing), this.keyOfTemplate(incoming)) >= 0.999 &&
          JSON.stringify(existing.norms || []) === JSON.stringify(incoming.norms || [])
        // 完全一样的内容，导入进来也是同一份，直接跳过不算冲突
        if (identical) {
          result.skipped++
          continue
        }

        const resolution = resolutions[incoming.id] || opts?.defaultResolution
        if (!resolution) {
          result.conflicts.push({
            key,
            incoming,
            existing: clone(existing),
            similarity: similarity(this.keyOfTemplate(existing), this.keyOfTemplate(incoming)),
            suggestion: existing.lifecycle === 'active' ? 'keep' : 'overwrite'
          })
          result.unresolved.push(key)
          continue
        }

        if (resolution === 'keep') {
          result.skipped++
          continue
        }
        if (resolution === 'overwrite') {
          const idx = this.templates.findIndex(t => t.id === existing.id)
          const merged: FormatTemplate = {
            ...incoming,
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: now
          }
          this.templates[idx] = merged
          result.imported++
          result.overwritten.push(existing.id)
          continue
        }
        // rename：并存，新条目换 id 换名字
        const name = this.ensureUniqueName(`${incoming.name}${suffix}`, key)
        const fresh: FormatTemplate = {
          ...incoming,
          id: this.ensureUniqueId(incoming.id),
          name,
          updatedAt: now
        }
        this.templates.push(fresh)
        result.imported++
        result.renamed.push({ id: fresh.id, name })
      }

      return result
    })
  }

  private extractBundleTemplates(bundle: unknown): unknown[] | null {
    if (Array.isArray(bundle)) return bundle
    if (bundle && typeof bundle === 'object') {
      const b = bundle as Record<string, unknown>
      if (Array.isArray(b.templates)) return b.templates
    }
    return null
  }

  private ensureUniqueId(id: string): string {
    if (!this.templates.some(t => t.id === id)) return id
    return newId()
  }

  private ensureUniqueName(base: string, scopeKey: string): string {
    const taken = new Set(
      this.templates.filter(t => dedupeKey(t.intentId, t.name) === scopeKey).map(t => t.name)
    )
    if (!taken.has(base)) return base
    let i = 2
    while (taken.has(`${base} ${i}`)) i++
    return `${base} ${i}`
  }
}

// ============ 内部小工具 ============

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 合并骨架自带口径与外部补充口径，去重且保持顺序 */
function mergeNorms(base: string[] | undefined, extra: string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of [...(base || []), ...(extra || [])]) {
    const s = String(n || '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}
