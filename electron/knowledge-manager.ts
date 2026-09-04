import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'

/**
 * 企业文档资产库（"越用越懂"的底座）
 *
 * 用户确认采纳的产出文件（docx/xlsx/csv/md/txt/json/pptx）在这里被解析成
 * 结构化资产：标题 + 关键词 + 分块正文。主进程启动时加载，意图路由
 * （intent-router）在装配任务指令时按用户原话/意图关键词检索并注入片段，
 * 让 AI 产出时天然带上企业已确认的文档结构、口径与素材。
 *
 * 存储：userData/data/knowledge_assets.json（单文件，资产量级小）。
 */

export interface KnowledgeChunk {
  index: number
  text: string
}

export interface KnowledgeAsset {
  id: string
  path: string
  fileName: string
  ext: string
  size: number
  mtime: number
  sessionId?: string
  addedAt: string
  title: string
  keywords: string[]
  chunks: KnowledgeChunk[]
  totalChars: number
}

/** 列表/勾选用的轻量项（不带正文分块） */
export interface KnowledgeAssetMeta {
  id: string
  fileName: string
  ext: string
  size: number
  mtime: number
  sessionId?: string
  addedAt: string
  title: string
  keywords: string[]
  totalChars: number
}

/** 对话产出目录里的候选文件（采纳弹窗用） */
export interface KnowledgeCandidate {
  path: string
  fileName: string
  ext: string
  size: number
  mtime: number
}

/** 检索命中项（注入 prompt 用） */
export interface KnowledgeRecall {
  assetId: string
  fileName: string
  title: string
  mtime: number
  chunks: KnowledgeChunk[]
}

const CHUNK_SIZE = 500
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 超过 20MB 不解析
const SUPPORTED_EXTS = ['docx', 'xlsx', 'csv', 'md', 'txt', 'json', 'pptx']

/** docx/pptx 里常见的 XML 实体解码（够用即可，不引入 DOM 库） */
function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** 从 office xml 里提取纯文本：段落按 </w:p>/</a:p> 分行，取所有 <w:t> 文本 */
function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .split(/<\/w:p>|<\/a:p>|<w:tr>|<\/w:tr>/)
    .flatMap(para => {
      const texts = para.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []
      const line = texts.map(t => xmlDecode(t.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))).join('')
      return line.trim() ? [line.trim()] : []
    })
    .join('\n')
}

function extractDocx(buf: Buffer): string {
  try {
    const zip = new AdmZip(buf)
    const entry = zip.getEntry('word/document.xml')
    return entry ? xmlToText(entry.getData().toString('utf-8')) : ''
  } catch {
    return ''
  }
}

function extractPptx(buf: Buffer): string {
  try {
    const zip = new AdmZip(buf)
    const slides = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    const parts = slides.map(e => xmlToText(e.getData().toString('utf-8')))
    return parts.filter(p => p.trim()).join('\n')
  } catch {
    return ''
  }
}

async function extractXlsx(buf: Buffer): Promise<string> {
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const lines: string[] = []
    for (const sheet of wb.worksheets) {
      lines.push(`【Sheet: ${sheet.name}】`)
      let rows = 0
      sheet.eachRow((row, rowNumber) => {
        if (rows >= 300 || lines.length > 2000) return
        const cells: string[] = []
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value
          if (v !== null && v !== undefined) {
            cells.push(typeof v === 'object' && v !== null ? String((v as any).text ?? '') : String(v))
          }
        })
        const line = `${rowNumber}: ${cells.join(' | ')}`.trim()
        if (line) {
          lines.push(line)
          rows += 1
        }
      })
    }
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** 按 ext 分发解析；失败或类型不支持返回空串（调用方跳过） */
async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_FILE_SIZE) return ''
  const buf = fs.readFileSync(filePath)
  switch (ext) {
    case 'docx':
      return extractDocx(buf)
    case 'xlsx':
      return extractXlsx(buf)
    case 'pptx':
      return extractPptx(buf)
    case 'json':
      try {
        const parsed = JSON.parse(buf.toString('utf-8'))
        return JSON.stringify(parsed, null, 1).slice(0, 40000)
      } catch {
        return ''
      }
    default:
      return buf.toString('utf-8').slice(0, 400000)
  }
}

/** 按行边界把长文本切成 ≤CHUNK_SIZE 的块 */
function chunkText(text: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > CHUNK_SIZE) {
      chunks.push({ index: chunks.length, text: cur })
      cur = ''
    }
    cur = cur ? `${cur}\n${line}` : line
  }
  if (cur.trim()) chunks.push({ index: chunks.length, text: cur })
  return chunks
}

interface KeywordStats {
  [key: string]: number
}

/** 简单关键词：文件名主干 + 正文高频字符/英文词（不引入分词依赖） */
function extractKeywords(text: string, fileName: string): string[] {
  const words: KeywordStats = {}
  const push = (w: string) => {
    const k = w.trim()
    if (k.length >= 2) words[k] = (words[k] || 0) + 1
  }
  // 英文/数字词
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) push(m[0].toLowerCase())
  // 中文高频单字（去掉常用虚词/标点），每个字 ≥2 次才收录
  const stop = new Set('的了是在和有与及或等对就把被给为以也这那一个不会都而于从并其所说当可但只令何无此分别至更最又且每我你他她它们如果因为所以虽然即使无论关于其他以及自己对于以后进行帮助应该需要'.
    split(''))
  const freq: KeywordStats = {}
  for (const ch of text) {
    if (/^[一-龥]$/.test(ch) && !stop.has(ch)) freq[ch] = (freq[ch] || 0) + 1
  }
  for (const [ch, n] of Object.entries(freq)) {
    if (n >= 3) push(ch)
  }
  const entries = Object.entries(words)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
  const stem = path.parse(fileName).name
  const kws = [stem]
  for (const [w] of entries) {
    if (kws.length >= 15 || !kws.includes(w)) kws.push(w)
    if (kws.length >= 15) break
  }
  return kws.slice(0, 15).map(k => k.toLowerCase())
}

function normPath(p: string): string {
  return path.resolve(p).toLowerCase()
}

function hashId(p: string): string {
  const norm = normPath(p)
  let h = 2166136261
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `k${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** 检索分词：英文词 + 中文滑窗 bigram/trigram */
function tokenize(query: string): string[] {
  const tokens: string[] = []
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) tokens.push(m[0].toLowerCase())
  const cjkRuns = query.match(/[一-龥]+/g) || []
  for (const run of cjkRuns) {
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= run.length; i++) tokens.push(run.slice(i, i + size))
    }
  }
  return tokens
}

export class KnowledgeManager {
  private file = ''
  private assets: KnowledgeAsset[] = []
  private logManager: any = null

  constructor(logManager?: any) {
    this.logManager = logManager
    this.file = path.join(app.getPath('userData'), 'data', 'knowledge_assets.json')
  }

  init(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        if (Array.isArray(raw)) this.assets = raw
      }
      this.logManager?.info(`KnowledgeManager: 已加载 ${this.assets.length} 份企业文档资产`)
    } catch (err: any) {
      this.assets = []
      this.logManager?.warn(`KnowledgeManager: 资产文件读取失败，从空库开始: ${err?.message}`)
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.assets))
    } catch (err: any) {
      this.logManager?.error(`KnowledgeManager: 资产保存失败: ${err?.message}`)
    }
  }

  list(): KnowledgeAssetMeta[] {
    return this.assets.map(({ chunks, ...meta }) => meta)
  }

  get(id: string): KnowledgeAsset | undefined {
    return this.assets.find(a => a.id === id)
  }

  /**
   * 登记一份文件为资产。已存在同名路径则覆盖更新（用户重新确认= 新内容为准）。
   * 解析失败（不支持类型/文件损坏/为空）返回 error。
   */
  async add(filePath: string, sessionId?: string): Promise<{ success: boolean; asset?: KnowledgeAssetMeta; error?: string }> {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: '文件不存在' }
      const ext = path.extname(filePath).slice(1).toLowerCase()
      if (!SUPPORTED_EXTS.includes(ext)) return { success: false, error: `暂不支持解析 ${ext || '未知'} 格式` }
      const text = await extractText(filePath)
      if (!text.trim()) return { success: false, error: '未能从文件中提取到文本' }
      const stat = fs.statSync(filePath)
      const id = hashId(filePath)
      const existed = this.assets.find(a => a.id === id)
      const asset: KnowledgeAsset = {
        id,
        path: path.resolve(filePath),
        fileName: path.basename(filePath),
        ext,
        size: stat.size,
        mtime: stat.mtimeMs,
        sessionId: sessionId || existed?.sessionId,
        addedAt: new Date().toISOString(),
        title: path.parse(filePath).name,
        keywords: extractKeywords(text, path.basename(filePath)),
        chunks: chunkText(text),
        totalChars: text.length
      }
      const idx = existed ? this.assets.indexOf(existed) : -1
      if (idx >= 0) this.assets[idx] = asset
      else this.assets.unshift(asset)
      this.save()
      this.logManager?.info(`KnowledgeManager: ${existed ? '更新' : '采纳'}资产 ${asset.fileName}（${asset.totalChars} 字，${asset.chunks.length} 块）`)
      const { chunks: _c, ...meta } = asset
      return { success: true, asset: meta }
    } catch (err: any) {
      return { success: false, error: err?.message || '解析失败' }
    }
  }

  remove(id: string): { success: boolean } {
    const idx = this.assets.findIndex(a => a.id === id)
    if (idx >= 0) {
      this.assets.splice(idx, 1)
      this.save()
      return { success: true }
    }
    return { success: false }
  }

  /** 列出会话 output/ 目录下的候选文件（认可其产出前先看清单） */
  async candidates(workDir: string): Promise<KnowledgeCandidate[]> {
    const outputDir = path.join(workDir || '', 'output')
    if (!fs.existsSync(outputDir)) return []
    const out: KnowledgeCandidate[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 1) return
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.name.startsWith('~$') || e.isSymbolicLink()) continue
        if (e.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        const ext = path.extname(e.name).slice(1).toLowerCase()
        if (!SUPPORTED_EXTS.includes(ext)) continue
        try {
          const stat = fs.statSync(full)
          out.push({ path: full, fileName: e.name, ext, size: stat.size, mtime: stat.mtimeMs })
        } catch {
          // ignore
        }
      }
    }
    walk(outputDir, 0)
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  /**
   * 检索与 query 相关的资产片段（intent-router 注入用）。
   * 打分：token 在标题命中 ×2，正文命中按次数累加；取 top 资产，
   * 命中度最高的分块优先，总量不超过 budgetChars。
   */
  recall(query: string, budgetChars = 2200): KnowledgeRecall[] {
    const tokens = tokenize(query)
    if (!tokens.length || !this.assets.length) return []
    const scored: { asset: KnowledgeAsset; score: number; bestChunks: KnowledgeChunk[] }[] = []
    for (const asset of this.assets) {
      let score = 0
      const titleText = `${asset.title} ${asset.fileName}`.toLowerCase()
      const chunkHits: { chunk: KnowledgeChunk; hits: number }[] = []
      for (const chunk of asset.chunks) {
        const cText = chunk.text.toLowerCase()
        let hits = 0
        for (const tk of tokens) {
          let count = cText.split(tk).length - 1
          if (count > 0) {
            hits += count
            if (titleText.includes(tk)) count += 2
            score += count
          }
        }
        if (hits > 0) chunkHits.push({ chunk, hits })
      }
      if (score > 0) {
        chunkHits.sort((a, b) => b.hits - a.hits)
        scored.push({ asset, score, bestChunks: chunkHits.sort((a, b) => a.chunk.index - b.chunk.index).map(c => c.chunk) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    const hits: KnowledgeRecall[] = []
    let used = 0
    for (const { asset, bestChunks } of scored.slice(0, 3)) {
      const chunks: KnowledgeChunk[] = []
      for (const chunk of bestChunks) {
        if (used + chunk.text.length > budgetChars) break
        chunks.push(chunk)
        used += chunk.text.length
        if (used >= budgetChars) break
      }
      if (chunks.length > 0) {
        hits.push({ assetId: asset.id, fileName: asset.fileName, title: asset.title, mtime: asset.mtime, chunks })
      }
    }
    return hits
  }
}
