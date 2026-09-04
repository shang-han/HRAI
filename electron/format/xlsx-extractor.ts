import path from 'path'

/**
 * xlsx 骨架抽取器（P2 结构复用 · 第 1 步）
 *
 * 从 Agent 产出的 xlsx 里抽出「结构」而非「内容」：字段序列、公式、冻结/筛选、
 * 数据验证、数字格式。产物是 FormatTemplate 的素材，最终注入 prompt 让 Agent
 * 用 openpyxl 复刻结构。
 *
 * 设计约束（详见 outputs/P2-结构复用详细设计.md §3）：
 * - 公式必须做行号抽象：=D2/C2 → =D{r}/C{r}，否则 Agent 只会给第 2 行写公式
 * - 口径反推全部规则化，不让 LLM 猜（猜错无 evidence、无法 debug）
 * - sampleRows 必须脱敏，个人信息列不落盘
 */

// ============ 常量 ============

const MAX_SCAN_ROWS = 500
const MAX_SAMPLE_VALUES = 50
const MAX_ENUM_UNIQUE = 20
const MIN_ROWS_FOR_ENUM = 5
const SAMPLE_ROW_COUNT = 3
const MAX_HEADER_SCAN = 5
/** 只从数据区前 N 个非空值里取列公式，避开末尾「合计」行的区间公式 */
const FORMULA_LOOKAHEAD = 10

/**
 * 命中这些列名的列，sampleRows 里一律打码，不落任何真实值。
 * 宁可多脱敏：模板 schema 未来可能被导出分享，泄露员工个人信息是不可接受的。
 */
const SENSITIVE_RE =
  /姓名|名字|手机|电话|联系方式|身份证|证件号|银行卡|卡号|邮箱|工号|住址|紧急联系人|保管人|经办人|领用人|使用人|责任人|联系人|账号|密码/

const MASK = '***'

// ============ 类型 ============

export type ColumnType = 'text' | 'number' | 'date' | 'percent' | 'formula' | 'enum'

export interface ColumnSpec {
  /** 表头原文 */
  key: string
  /** 0-based 列序号，顺序本身即口径 */
  index: number
  width?: number
  numFmt?: string
  align?: string
  inferredType: ColumnType
  enumValues?: string[]
  /**
   * 枚举来源：validation = 表里真有下拉验证（权威，可作为口径输出）；
   * heuristic = 靠值重复度猜的（只作类型提示，不作为口径，避免噪音）
   */
  enumSource?: 'validation' | 'heuristic'
  /** 已做 {r} 抽象的公式，带前导 = */
  formula?: string
  /** 单列口径提示 */
  normHint?: string
}

export interface DVSpec {
  sqref: string
  type: string
  formulae: string[]
}

export interface SheetSkeleton {
  name: string
  index: number
  headerRow: number
  columns: ColumnSpec[]
  freeze?: string
  autoFilter?: string
  dataValidation?: DVSpec[]
  rowCount: number
  isPrimary: boolean
  sampleRows: string[][]
}

export interface XlsxSkeleton {
  kind: 'xlsx'
  sheets: SheetSkeleton[]
  /** 规则化口径语句 */
  norms: string[]
  /** 召回指纹：文件名清洗词 + 表头字段名（+ 外部传入的 intentId） */
  signals: string[]
}

export interface ExtractOptions {
  intentId?: string
}

export interface ExtractResult {
  ok: boolean
  /** 抽取失败/不适格的原因，给用户看 */
  reason?: string
  skeleton?: XlsxSkeleton
}

// ============ 工具 ============

function colLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const m = (x - 1) % 26
    s = String.fromCharCode(65 + m) + s
    x = (x - m - 1) / 26
  }
  return s
}

/** exceljs 的 formula 不带前导 =；共享公式挂在 sharedFormula 上 */
function getFormula(cell: any): string | undefined {
  const raw = cell?.formula ?? cell?.sharedFormula
  if (!raw) return undefined
  const s = String(raw)
  return s.startsWith('=') ? s : '=' + s
}

function isBlank(v: any): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

/**
 * 把逐行公式里的行号抽象成 {r}，区间引用（如 SUM(C2:C31)）保持原样。
 * =D2/C2        → =D{r}/C{r}
 * =IF(E2>=3,..) → =IF(E{r}>=3,..)
 * =SUM(E2:E21)  → =SUM(E2:E21)
 */
export function abstractFormula(formula: string, sampleRow: number): string {
  const re = /(\$?)([A-Z]{1,3})(\$?)(\d+)/g
  const tokens: Array<{ start: number; end: number; col: string; row: number; pre: string; suf: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(formula)) !== null) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      col: m[2],
      row: Number(m[4]),
      pre: m[1],
      suf: m[3]
    })
  }
  let out = ''
  let last = 0
  for (const t of tokens) {
    const before = formula.slice(0, t.start).trimEnd()
    const after = formula.slice(t.end).trimStart()
    const inRange = before.endsWith(':') || after.startsWith(':')
    out += formula.slice(last, t.start)
    if (!inRange && t.row === sampleRow) {
      out += `${t.pre}${t.col}${t.suf}{r}`
    } else {
      out += formula.slice(t.start, t.end)
    }
    last = t.end
  }
  return out + formula.slice(last)
}

/** 把公式里的列字母换回表头名，便于人类/LLM 读懂：=D{r}/C{r} → =实出勤/应出勤 */
function humanizeFormula(formula: string, colByLetter: Map<string, string>): string {
  return formula.replace(/(\$?)([A-Z]{1,3})(\$?)\{r\}/g, (all, _p1, col: string, _p3) => {
    return colByLetter.get(col) ?? all
  })
}

/** 3月考勤汇总表 / 2026-03-考勤表 → 考勤汇总表，去掉易变的时间成分 */
function cleanFileName(filePath: string): string {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, '')
    .replace(/20\d{2}\s*年?/g, '')
    .replace(/\d{1,2}\s*月/g, '')
    .replace(/\d{1,2}\s*日/g, '')
    .replace(/\d{8}/g, '')
    .replace(/[()（）\[\]【】\s_\-—]+/g, '')
}

function isMergedRow(ws: any, row: number): boolean {
  const merges: string[] = ws?.model?.merges || []
  return merges.some((ref: string) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(ref))
    if (!m) return false
    const r1 = Number(m[2])
    const r2 = Number(m[4])
    return row >= r1 && row <= r2 && r1 !== r2
  })
}

// ============ 表头行检测 ============

interface HeaderCandidate {
  row: number
  score: number
  filled: number
}

/**
 * 启发式表头检测：前 MAX_HEADER_SCAN 行里挑最像表头的一行。
 * 判据：连续非空列数 + 下一行是否为数值/日期（文本表头下面跟数据）+ 合并单元格惩罚。
 */
function pickHeaderRow(ws: any, rowCount: number, colCount: number): HeaderCandidate | null {
  const limit = Math.min(rowCount, MAX_HEADER_SCAN)
  let best: HeaderCandidate | null = null

  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r)
    let filled = 0
    for (let c = 1; c <= colCount; c++) {
      if (isBlank(row.getCell(c).value)) break
      filled++
    }
    if (filled < 2) continue

    let score = filled
    const next = ws.getRow(r + 1)
    let nextFilled = 0
    let numericLike = 0
    for (let c = 1; c <= filled; c++) {
      const v = next.getCell(c).value
      if (isBlank(v)) continue
      nextFilled++
      if (typeof v === 'number' || v instanceof Date || typeof v === 'object') numericLike++
    }
    // 表头下面紧跟数据行，是表头最典型的特征
    if (nextFilled > 0 && numericLike / nextFilled >= 0.5) score += 3
    if (isMergedRow(ws, r)) score -= 5

    if (!best || score > best.score) best = { row: r, score, filled }
  }

  return best
}

// ============ 列推断 ============

function parseEnumFormulae(formulae: string[]): string[] {
  const out: string[] = []
  for (const f of formulae) {
    const s = String(f).replace(/^"|"$/g, '')
    for (const part of s.split(',')) {
      const v = part.trim()
      if (v) out.push(v)
    }
  }
  return out
}

interface InferResult {
  type: ColumnType
  enumValues?: string[]
  enumSource?: 'validation' | 'heuristic'
}

function inferType(
  values: any[],
  numFmt: string | undefined,
  hasFormula: boolean,
  dvEnums: string[]
): InferResult {
  if (hasFormula) return { type: 'formula' }
  if (dvEnums.length > 0) return { type: 'enum', enumValues: dvEnums, enumSource: 'validation' }
  if (values.length === 0) return { type: 'text' }

  // 带公式的单元格在 exceljs 里有三种形态，都得处理：
  //   {formula, result} 已求值 → 取 result
  //   {formula}         未求值（Python 写的公式，没有缓存结果）→ 跳过，不计入类型判断
  //   {text}            富文本/超链接 → 取 text
  // 不处理的话 "[object Object]" 会混进取值集合，把数字列污染成枚举列。
  const unwrapped: any[] = []
  for (const v of values) {
    if (v && typeof v === 'object') {
      if ('result' in v) {
        unwrapped.push((v as any).result)
        continue
      }
      if ('formula' in v || 'sharedFormula' in v) continue
      if ('text' in v) {
        unwrapped.push((v as any).text)
        continue
      }
    }
    unwrapped.push(v)
  }

  let numCount = 0
  let dateCount = 0
  let textCount = 0
  for (const v of unwrapped) {
    if (typeof v === 'number') numCount++
    else if (v instanceof Date) dateCount++
    else if (v !== null && v !== undefined && String(v).trim() !== '') textCount++
  }
  if (numCount + dateCount + textCount === 0) return { type: 'text' }

  // 数值列优先判定：「迟到次数」这类字段天然低基数（取值只有 0/1/2/3），
  // 只要没有文本混杂就一律算数字，否则会被下面的枚举启发式误判。
  if (numCount > 0 && textCount === 0) {
    return { type: numFmt && numFmt.includes('%') ? 'percent' : 'number' }
  }
  if (dateCount > 0 && numCount === 0 && textCount === 0) return { type: 'date' }

  const uniq = new Set(
    unwrapped.map(v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)))
  )
  // 唯一值占比过高说明不是枚举（姓名列每行都不同，就该是 text）
  if (
    dateCount === 0 &&
    uniq.size <= MAX_ENUM_UNIQUE &&
    values.length >= MIN_ROWS_FOR_ENUM &&
    uniq.size < values.length * 0.8
  ) {
    return { type: 'enum', enumValues: Array.from(uniq), enumSource: 'heuristic' }
  }
  return { type: 'text' }
}

function inferColumns(
  ws: any,
  headerRow: number,
  headerKeys: string[],
  rowCount: number,
  dvMap: Map<string, string[]>,
  allowSample: boolean
): { columns: ColumnSpec[]; sampleRows: string[][]; dataRowCount: number } {
  const scanEnd = Math.min(rowCount, headerRow + MAX_SCAN_ROWS)
  const columns: ColumnSpec[] = []
  const sampleRows: string[][] = []
  let dataRowCount = 0

  // 先取样例行的原始值（脱敏在最后统一做）
  const rawSamples: any[][] = []
  if (allowSample) {
    for (let r = headerRow + 1; r <= scanEnd && rawSamples.length < SAMPLE_ROW_COUNT; r++) {
      const row = ws.getRow(r)
      const vals: any[] = []
      let anyValue = false
      for (let i = 0; i < headerKeys.length; i++) {
        const v = row.getCell(i + 1).value
        if (!isBlank(v)) anyValue = true
        vals.push(v)
      }
      if (anyValue) rawSamples.push(vals)
    }
  }

  for (let i = 0; i < headerKeys.length; i++) {
    const c = i + 1
    const headerCell = ws.getRow(headerRow).getCell(c)
    const values: any[] = []
    let formula: string | undefined
    let numFmt: string | undefined
    let align: string | undefined
    let colDataRows = 0

    if (!numFmt && headerCell.numFmt) numFmt = String(headerCell.numFmt)

    for (let r = headerRow + 1; r <= scanEnd; r++) {
      if (values.length >= MAX_SAMPLE_VALUES && formula) break
      const cell = ws.getRow(r).getCell(c)
      if (!numFmt && cell.numFmt) numFmt = String(cell.numFmt)
      if (!align && cell.alignment && (cell.alignment as any).horizontal) {
        align = String((cell.alignment as any).horizontal)
      }
      const v = cell.value
      if (isBlank(v)) continue
      colDataRows++
      // 只在数据区开头取公式：末尾的「合计」行区间公式（SUM(E2:E21)）不代表列语义，
      // 若被取到会把「迟到次数」这类纯数字列误判成 formula 列。
      const f = colDataRows <= FORMULA_LOOKAHEAD ? getFormula(cell) : undefined
      if (f && !formula) formula = abstractFormula(f, r)
      if (values.length < MAX_SAMPLE_VALUES) values.push(v)
    }

    const width = ws.getColumn(c).width
    const dvEnums = dvMap.get(colLetter(c)) || []
    const { type, enumValues, enumSource } = inferType(values, numFmt, !!formula, dvEnums)

    columns.push({
      key: headerKeys[i],
      index: i,
      width: width ? Number(width) : undefined,
      numFmt,
      align,
      inferredType: type,
      enumValues,
      enumSource,
      formula
    })
    dataRowCount = Math.max(dataRowCount, colDataRows)
  }

  for (const raw of rawSamples) {
    sampleRows.push(
      raw.map((v, i) => {
        if (SENSITIVE_RE.test(columns[i]?.key || '')) return MASK
        if (isBlank(v)) return ''
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        if (typeof v === 'object' && v !== null) {
          return String((v as any).result ?? (v as any).text ?? '')
        }
        return String(v)
      })
    )
  }

  return { columns, sampleRows, dataRowCount }
}

// ============ 视图属性 ============

function readFreeze(ws: any): string | undefined {
  const views: any[] = ws?.views || []
  const v = views.find((x: any) => x && x.state === 'frozen')
  if (!v) return undefined
  const xSplit = Number(v.xSplit || 0)
  const ySplit = Number(v.ySplit || 0)
  if (!xSplit && !ySplit) return undefined
  if (!xSplit) return `A${ySplit + 1}`
  if (!ySplit) return `${colLetter(xSplit + 1)}1`
  return `${colLetter(xSplit + 1)}${ySplit + 1}`
}

function readAutoFilter(ws: any): string | undefined {
  const af = ws?.autoFilter
  if (!af) return undefined
  // exceljs 读文件时给的是字符串（"A1:I21"），写文件时才用 {from,to} 对象，两种都要兼容
  if (typeof af === 'string') return af
  if (af.from) {
    const from = af.from
    const to = af.to || af.from
    return `${colLetter(from.column || 1)}${from.row || 1}:${colLetter(to.column || 1)}${to.row || 1}`
  }
  return undefined
}

/**
 * 坑：exceljs 读 openpyxl 写的 dataValidation 时，会把 sqref="F2:F21" 这个范围
 * 展开成「每个单元格一个条目」（F2 / F3 / ... / F21），且条目内部不再带 sqref，
 * 只剩下单元格地址作为 key。所以必须自己按列聚合回范围，否则会漏掉下拉选项。
 */
function readDataValidations(ws: any): { list: DVSpec[]; enumsByCol: Map<string, string[]> } {
  const list: DVSpec[] = []
  const enumsByCol = new Map<string, string[]>()
  const model = ws?.dataValidations?.model
  if (!model || typeof model !== 'object') return { list, enumsByCol }

  const byCol = new Map<string, { rows: number[]; formulae: string[]; type: string }>()
  for (const [addr, item] of Object.entries<any>(model)) {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(addr)
    if (!m) continue
    const col = m[1]
    const row = Number(m[2])
    if (!byCol.has(col)) {
      byCol.set(col, { rows: [], formulae: [], type: String(item?.type || '') })
    }
    const entry = byCol.get(col)!
    entry.rows.push(row)
    if (entry.formulae.length === 0 && Array.isArray(item?.formulae)) {
      entry.formulae = item.formulae.map((x: any) => String(x))
    }
  }

  for (const [col, entry] of byCol) {
    const rows = entry.rows.sort((a, b) => a - b)
    const sqref =
      rows.length === 1
        ? `${col}${rows[0]}`
        : `${col}${rows[0]}:${col}${rows[rows.length - 1]}`
    list.push({ sqref, type: entry.type, formulae: entry.formulae })
    if (entry.type === 'list' && entry.formulae.length > 0) {
      enumsByCol.set(col, parseEnumFormulae(entry.formulae))
    }
  }
  list.sort((a, b) => a.sqref.localeCompare(b.sqref))
  return { list, enumsByCol }
}

// ============ 口径规则化 ============

/**
 * 全部规则化，不让 LLM 推断。理由：猜出来的口径没有 evidence，
 * 错了无法追溯也无法 debug，而一次错误会连带否定整套模板。
 */
function deriveNorms(sheet: SheetSkeleton): string[] {
  const norms: string[] = []
  const colByLetter = new Map<string, string>()
  for (const col of sheet.columns) colByLetter.set(colLetter(col.index + 1), col.key)

  for (const col of sheet.columns) {
    // 百分比呈现
    if (/出勤率|达成率|完成率|占比|幅度/.test(col.key) && col.numFmt && col.numFmt.includes('%')) {
      norms.push(`${col.key} 以百分比呈现（numFmt: ${col.numFmt}）`)
    }
    // 枚举取值限定：只认表里真有的下拉验证。靠重复度猜出来的不作为口径输出，
    // 否则「部门 取值限定为：研发部/市场部…」这类噪音会白白吃掉 prompt 预算。
    if (col.enumSource === 'validation' && col.enumValues && col.enumValues.length > 0) {
      norms.push(`${col.key} 取值限定为：${col.enumValues.join(' / ')}`)
    }
    // 逐行计算公式：翻译成字段名。含阈值比较的额外标注，提醒这是易变口径
    if (col.formula && col.formula.includes('{r}')) {
      const human = humanizeFormula(col.formula.replace(/^=/, ''), colByLetter)
      if (/>=|<=|>|</.test(col.formula)) {
        norms.push(`${col.key} = ${human}（含阈值比较，阈值可能随制度调整，套用前需确认）`)
      } else {
        norms.push(`${col.key} = ${human}`)
      }
    }
  }

  return norms
}

function buildSignals(filePath: string, sheet: SheetSkeleton, intentId?: string): string[] {
  const out = new Set<string>()
  const cleaned = cleanFileName(filePath)
  if (cleaned) out.add(cleaned)
  if (sheet?.name) out.add(sheet.name)
  for (const col of sheet?.columns || []) {
    const k = String(col.key || '').trim()
    if (k) out.add(k)
  }
  if (intentId) out.add(intentId)
  return Array.from(out)
}

// ============ 主入口 ============

/**
 * 抽取 xlsx 结构骨架。
 * 只完整抽取「数据行最多」的主 sheet，其余 sheet 仅记录名字与表头字段名，
 * 避免注入体积失控。
 */
export async function extractXlsxSkeleton(
  filePath: string,
  opts?: ExtractOptions
): Promise<ExtractResult> {
  let ExcelJS: any
  try {
    const mod: any = await import('exceljs')
    ExcelJS = mod.default || mod
  } catch (err: any) {
    return { ok: false, reason: `exceljs 加载失败：${err?.message || err}` }
  }

  let wb: any
  try {
    wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(filePath)
  } catch (err: any) {
    return { ok: false, reason: `读取失败：${err?.message || err}` }
  }

  const sheets: SheetSkeleton[] = []
  const raw: Array<{ ws: any; index: number; header: HeaderCandidate; dv: ReturnType<typeof readDataValidations> }> = []

  for (let i = 0; i < wb.worksheets.length; i++) {
    const ws = wb.worksheets[i]
    const rowCount = Number(ws.rowCount || 0)
    const colCount = Number(ws.columnCount || 0)
    if (rowCount < 2 || colCount < 1) {
      sheets.push({
        name: String(ws.name || `Sheet${i + 1}`),
        index: i,
        headerRow: 1,
        columns: [],
        rowCount,
        isPrimary: false,
        sampleRows: []
      })
      continue
    }
    const header = pickHeaderRow(ws, rowCount, colCount)
    if (!header) {
      sheets.push({
        name: String(ws.name || `Sheet${i + 1}`),
        index: i,
        headerRow: 1,
        columns: [],
        rowCount,
        isPrimary: false,
        sampleRows: []
      })
      continue
    }
    raw.push({ ws, index: i, header, dv: readDataValidations(ws) })
  }

  // 先按数据行数挑主 sheet，再做完整抽取
  let scored = raw.map(item => {
    const dataRows = Math.max(0, (item.ws.rowCount || 0) - item.header.row)
    return { item, dataRows }
  })
  scored.sort((a, b) => b.dataRows - a.dataRows)
  const primaryIndex = scored.length > 0 ? scored[0].item.index : -1

  const full: SheetSkeleton[] = []
  for (const { item, dataRows } of scored) {
    const { ws, index, header, dv } = item
    const headerKeys: string[] = []
    for (let c = 1; c <= header.filled; c++) {
      headerKeys.push(String(ws.getRow(header.row).getCell(c).value ?? '').trim())
    }
    const isPrimary = index === primaryIndex
    const { columns, sampleRows } = inferColumns(
      ws,
      header.row,
      headerKeys,
      ws.rowCount,
      dv.enumsByCol,
      isPrimary
    )
    const skel: SheetSkeleton = {
      name: String(ws.name || `Sheet${index + 1}`),
      index,
      headerRow: header.row,
      columns,
      freeze: readFreeze(ws),
      autoFilter: readAutoFilter(ws),
      dataValidation: dv.list.length > 0 ? dv.list : undefined,
      rowCount: Number(ws.rowCount || 0),
      isPrimary,
      sampleRows
    }
    // 非主 sheet 只保留字段名，避免注入体积失控
    if (!isPrimary) {
      skel.columns = columns.map(c => ({ key: c.key, index: c.index, inferredType: 'text' as ColumnType }))
      skel.freeze = undefined
      skel.autoFilter = undefined
      skel.dataValidation = undefined
      skel.sampleRows = []
    }
    void dataRows
    full.push(skel)
  }

  const all = [...full, ...sheets].sort((a, b) => a.index - b.index)
  const primary = all.find(s => s.isPrimary)
  if (!primary || primary.columns.length === 0) {
    return { ok: false, reason: '未检测到有效表头，或表内无数据' }
  }
  if (primary.rowCount - primary.headerRow < 1) {
    return { ok: false, reason: '表头下没有数据行，不足以形成格式模板' }
  }

  return {
    ok: true,
    skeleton: {
      kind: 'xlsx',
      sheets: all,
      norms: deriveNorms(primary),
      signals: buildSignals(filePath, primary, opts?.intentId)
    }
  }
}

/** 只给 UI 预览用的精简摘要 */
export function summarizeSkeleton(sk: XlsxSkeleton): {
  sheetName: string
  headerRow: number
  fields: string[]
  freeze?: string
  autoFilter?: string
  norms: string[]
} {
  const p = sk.sheets.find(s => s.isPrimary) || sk.sheets[0]
  return {
    sheetName: p?.name || '',
    headerRow: p?.headerRow || 1,
    fields: (p?.columns || []).map(c => c.key),
    freeze: p?.freeze,
    autoFilter: p?.autoFilter,
    norms: sk.norms
  }
}
