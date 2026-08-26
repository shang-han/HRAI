import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * 意图路由（P0 隐形内核）
 *
 * 导航点击或自由输入命中业务意图后，不改变用户看到的原文，
 * 而是把原文装配成带技能、模板、输出契约和合规底线的任务指令，
 * 再交给 Hermes Agent 执行。整个过程对 UI 透明。
 */

export interface IntentMeta {
  /** 导航点击时由 Sidebar 携带的标签（精确匹配 manifest.labels） */
  hint?: string
  /** 也可直接指定意图 ID */
  id?: string
}

export interface IntentDefinition {
  id: string
  labels: string[]
  category: string
  workflow: 'document-drafting' | 'form-filling' | 'spreadsheet-report' | 'analysis-advice'
  description: string
  skills: string[]
  keywords: string[]
  contextHints: string[]
  templateHints: string[]
  outputContract: string[]
  guardrails: string[]
}

export interface PreparedIntent {
  taskId: string
  prompt: string
  matched: boolean
  source: 'nav' | 'keyword' | 'none'
  matchedBy: string
  intent?: IntentDefinition
  original: string
  sessionId?: string
}

interface IntentLogEntry {
  ts: string
  taskId: string
  sessionId?: string
  event: 'start' | 'done' | 'error' | 'fallback'
  source?: string
  matched?: boolean
  intentId?: string
  label?: string
  workflow?: string
  matchedBy?: string
  original?: string
  prompt?: string
  detail?: string
  durationMs?: number
}

const WORKFLOW_LABEL: Record<string, string> = {
  'document-drafting': '制度/文案起草',
  'form-filling': '单据/表格填写',
  'spreadsheet-report': '台账/报表生成',
  'analysis-advice': '分析/建议'
}

const WORKFLOW_GUIDANCE: Record<string, string> = {
  'document-drafting': '按“目的 → 适用范围 → 职责/流程 → 执行步骤 → 检查清单”组织内容，语言正式、可落地。',
  'form-filling': '先生成可直接填写/打印的完整表单结构，再说明填写规范；缺失信息用占位符并列为“待确认字段”。',
  'spreadsheet-report': '先定义统计口径与字段，再输出表头结构；如生成 Excel 文件，必须使用表格公式而不是在正文里估算结果。',
  'analysis-advice': '结论先行，再给出依据、假设、风险与建议；数值必须来自输入或明确标注为假设。'
}

export class IntentRouter {
  private intents: IntentDefinition[] = []
  private logManager: any
  private logFile: string
  private startedAt = new Map<string, number>()
  private endedAt = new Set<string>()
  private companyProfile: any = null
  private storageManager: any = null
  /** 内置工作区绝对路径；会话没单独设工作目录时用它 */
  private defaultWorkDir = ''

  constructor(logManager: any, storageManager?: any) {
    this.logManager = logManager
    this.storageManager = storageManager || null
    this.companyProfile = storageManager?.getCompanyProfile?.() || null
    const dataDir = path.join(app.getPath('userData'), 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    this.logFile = path.join(dataDir, 'intent_log.jsonl')
    this.loadManifest()
  }

  private loadManifest(): void {
    try {
      const manifestPath = path.join(app.getAppPath(), 'resources', 'intents', 'hr-intents.json')
      if (fs.existsSync(manifestPath)) {
        const raw = fs.readFileSync(manifestPath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.intents = parsed
          this.logManager?.info(`IntentRouter: 已加载 ${this.intents.length} 个 HR 意图`)
          return
        }
      }
      this.logManager?.warn('IntentRouter: 未找到 hr-intents.json，将仅使用兜底聊天模式')
    } catch (err: any) {
      this.logManager?.error('IntentRouter: 意图清单加载失败', err)
    }
  }

  /**
   * 装配发送给 Hermes 的提示词。界面原文不变，这里生成内部任务信封。
   */
  prepare(original: string, meta?: IntentMeta, sessionId?: string): PreparedIntent {
    // 会话的近期重点工作：无论是否命中业务意图，都作为上下文注入 prompt
    const session = sessionId ? this.storageManager?.getSessionById?.(sessionId) : null
    const workPriority = session?.workPriority || null
    const match = this.match(original, meta)

    if (!match) {
      return {
        taskId: this.makeTaskId(),
        prompt: this.withWorkPriorityContext(
          this.withCustomWorkDirNote(original, session?.workDir || ''),
          workPriority
        ),
        matched: false,
        source: 'none',
        matchedBy: '',
        original,
        sessionId
      }
    }

    const intent = match.intent
    const prompt = this.withWorkPriorityContext(
      this.buildPrompt(original, intent, match.source, match.matchedBy, session?.workDir || ''),
      workPriority
    )

    return {
      taskId: this.makeTaskId(),
      prompt,
      matched: true,
      source: match.source,
      matchedBy: match.matchedBy,
      intent,
      original,
      sessionId
    }
  }

  /**
   * 把近期重点工作作为上下文注入 prompt 开头，
   * 让 AI 输出贴合当前项目背景（无内容时不注入）。
   */
  private withWorkPriorityContext(prompt: string, wp: any): string {
    if (!wp || (!wp.title && !wp.background)) return prompt
    const lines: string[] = []
    lines.push('【近期重点工作（回答与生成内容请贴合以下背景）】')
    if (wp.title) lines.push(`- 标题：${wp.title}`)
    if (wp.background) lines.push(`- 背景：${wp.background}`)
    if (wp.targetAudience) lines.push(`- 目标人群：${wp.targetAudience}`)
    if (wp.scenario) lines.push(`- 使用场景：${wp.scenario}`)
    lines.push('')
    return lines.join('\n') + prompt
  }

  /**
   * 自选工作目录的最小提醒，只用于「没命中业务意图」的自由对话
   * （命中意图时 buildPrompt 里已有完整的【工作区说明】，不重复注入）。
   * 为什么非要有这一段：cwd 指向用户自己的资料目录时，"产物写 output/、
   * 别乱动无关文件"这条约束在内置工作区是靠 AGENTS.md 兜着的，
   * 用户目录里没有那份文件，只能在信封里补上。
   */
  private withCustomWorkDirNote(prompt: string, workDir: string): string {
    const dir = (workDir || '').trim()
    if (!dir) return prompt
    return [
      '【工作区说明】',
      `- 当前工作目录为 ${dir}（用户为本会话指定），所有相对路径都相对它解析。`,
      '- 只在本目录范围内读写；生成的文件放进其中的 output/ 子目录（不存在时先创建），不要改动与本次任务无关的既有文件。',
      ''
    ].join('\n') + prompt
  }

  private match(original: string, meta?: IntentMeta):
    | { intent: IntentDefinition; source: 'nav' | 'keyword'; matchedBy: string }
    | null {
    // 1. 导航点击：label 精确匹配优先
    const hint = meta?.hint?.trim()
    if (hint) {
      const byLabel = this.intents.find(i => i.labels.some(l => l === hint))
      if (byLabel) {
        return { intent: byLabel, source: 'nav', matchedBy: `label:${hint}` }
      }
      const byId = this.intents.find(i => i.id === hint)
      if (byId) {
        return { intent: byId, source: 'nav', matchedBy: `id:${hint}` }
      }
    }

    const id = meta?.id?.trim()
    if (id) {
      const byId = this.intents.find(i => i.id === id)
      if (byId) {
        return { intent: byId, source: 'nav', matchedBy: `id:${id}` }
      }
    }

    // 2. 自由输入：关键词打分，命中次数最高者胜出
    const text = original.toLowerCase()
    let best: { intent: IntentDefinition; score: number; matchedBy: string } | null = null
    for (const intent of this.intents) {
      const hits: string[] = []
      let score = 0
      for (const kw of intent.keywords) {
        const lower = kw.toLowerCase()
        if (!lower) continue
        const count = text.split(lower).length - 1
        if (count > 0) {
          hits.push(kw)
          score += count
        }
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { intent, score, matchedBy: `keywords:${hits.join('|')}` }
      }
    }

    if (best) {
      return { intent: best.intent, source: 'keyword', matchedBy: best.matchedBy }
    }

    // 导航提示未命中清单时，回退到关键词匹配，保证旧导航文案升级后仍可用
    if (hint) {
      const byKeyword = this.match(original, undefined)
      if (byKeyword && byKeyword.source === 'keyword') {
        return { ...byKeyword, source: 'keyword', matchedBy: `fallback-label:${hint};${byKeyword.matchedBy}` }
      }
    }

    return null
  }

  private buildPrompt(
    original: string,
    intent: IntentDefinition,
    source: 'nav' | 'keyword',
    matchedBy: string,
    sessionWorkDir?: string
  ): string {
    const lines: string[] = []
    lines.push('【Hermes HR 业务任务指令】')
    lines.push(`- 业务入口：${intent.category} / ${intent.labels[0]}`)
    lines.push(`- 意图编号：${intent.id}`)
    lines.push(`- 任务类型：${WORKFLOW_LABEL[intent.workflow] || intent.workflow}`)
    lines.push(`- 识别方式：${source === 'nav' ? '业务导航点击' : '自然语言关键词'}（${matchedBy}）`)
    if (intent.skills.length > 0) {
      lines.push(`- 建议技能：${intent.skills.join('、')}。如对应 SKILL.md 可用，请按技能的步骤与脚本执行；不可用时用 Python 或手工方式完成同等任务，并在回复中说明。`)
    }
    if (intent.templateHints.length > 0) {
      lines.push(`- 参考模板：${intent.templateHints.join('、')}（若文件存在必须先读取并按其结构执行）`)
    }
    lines.push(`- 需要收集的信息：${intent.contextHints.join('、')}`)
    lines.push('')
    if (this.companyProfile && typeof this.companyProfile === 'object') {
      lines.push('【企业画像（请所有产出贴合该企业）】')
      for (const [key, value] of Object.entries(this.companyProfile)) {
        if (value !== undefined && value !== null && String(value).trim()) {
          lines.push(`- ${key}: ${String(value)}`)
        }
      }
    }
    lines.push('')
    lines.push('【工作要求】')
    lines.push(`- 任务定位：${intent.description}。${WORKFLOW_GUIDANCE[intent.workflow] || ''}`)
    for (const item of intent.outputContract) {
      lines.push(`- ${item}`)
    }
    lines.push('')
    lines.push('【合规与质量底线】')
    for (const item of intent.guardrails) {
      lines.push(`- ${item}`)
    }
    lines.push('- 所有文件产物只允许写入当前工作目录下的 output/ 子目录（不存在时先创建），并在回复末尾用“📎 生成文件”列出相对路径。')
    lines.push('- 回复末尾固定包含两部分：缺失信息（待确认字段）与 2~4 条下一步建议。')
    lines.push('')
    // 工作区说明必须按会话真实 cwd 生成：用户自选目录里没有 company_context.json /
    // data/ / AGENTS.md，硬写"当前工作目录为 workspace/"会让 AI 去找不存在的文件，
    // 甚至试图跳出 cwd 去访问内置工作区。
    const builtin = (this.defaultWorkDir || '').trim()
    const cwd = (sessionWorkDir || '').trim() || builtin
    const isBuiltin = !(sessionWorkDir || '').trim()
    lines.push('【工作区说明】')
    if (cwd) lines.push(`- 当前工作目录为 ${cwd}，所有相对路径都相对它解析。`)
    if (isBuiltin) {
      lines.push('- 如存在 company_context.json 或 data/ 台账文件，先读取以获取公司上下文。')
      lines.push('- 若工作目录下 AGENTS.md 存在，其中的规则优先级高于本指令中相冲突的表述。')
    } else {
      lines.push('- 这是用户为本会话指定的工作目录，里面可能已有用户自己的资料：动手前先列目录了解结构，不要凭空假设文件布局。')
      lines.push('- 只在本目录范围内读写，不要改动与本次任务无关的既有文件；若目录下存在 AGENTS.md / README.md，其规则优先级高于本指令中相冲突的表述。')
    }
    lines.push('')
    lines.push('【用户原话】')
    lines.push(original)
    return lines.join('\n')
  }

  setCompanyProfile(profile: any): void {
    this.companyProfile = profile || null
  }

  /** 由 main.ts 在启动时注入内置工作区路径（HermesManager.getWorkspacePath()） */
  setDefaultWorkDir(dir: string): void {
    this.defaultWorkDir = dir || ''
  }

  private makeTaskId(): string {
    return `hr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  }

  // ============ 日志 ============

  recordStart(prepared: PreparedIntent): void {
    this.startedAt.set(prepared.taskId, Date.now())
    const entry: IntentLogEntry = {
      ts: new Date().toISOString(),
      taskId: prepared.taskId,
      sessionId: prepared.sessionId,
      event: prepared.matched ? 'start' : 'fallback',
      source: prepared.source,
      matched: prepared.matched,
      intentId: prepared.intent?.id,
      label: prepared.intent?.labels[0],
      workflow: prepared.intent?.workflow,
      matchedBy: prepared.matchedBy || undefined,
      original: prepared.original,
      prompt: prepared.matched ? prepared.prompt : undefined
    }
    this.appendLog(entry)
  }

  recordEnd(taskId: string, event: 'done' | 'error', detail?: string): void {
    if (this.endedAt.has(taskId)) return
    this.endedAt.add(taskId)
    const started = this.startedAt.get(taskId)
    this.startedAt.delete(taskId)
    const entry: IntentLogEntry = {
      ts: new Date().toISOString(),
      taskId,
      event,
      detail: detail || undefined,
      durationMs: started ? Date.now() - started : undefined
    }
    this.appendLog(entry)
  }

  private appendLog(entry: IntentLogEntry): void {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err: any) {
      this.logManager?.error('IntentRouter: 写入 intent_log 失败', err)
    }
  }
}
