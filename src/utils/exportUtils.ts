// 导出意图检测与格式工具

export interface ExportIntent {
  format: string
  label: string
  extension: string
}

const EXPORT_TYPES: ExportIntent[] = [
  { format: 'docx', label: 'Word', extension: '.docx' },
  { format: 'xlsx', label: 'Excel', extension: '.xlsx' },
  { format: 'pptx', label: 'PPT', extension: '.pptx' },
  { format: 'md', label: 'Markdown', extension: '.md' },
  { format: 'txt', label: '文本', extension: '.txt' },
]

// 触发词：明确要求生成/导出文档时才自动导出，避免误触发
const TRIGGER_KEYWORDS = ['导出', '生成', '制作', '转成', '转换成', '保存为', '做成']

/**
 * 检测用户消息中的导出意图
 */
export function detectExportIntent(message: string): ExportIntent | null {
  const text = message.toLowerCase()
  if (!TRIGGER_KEYWORDS.some(kw => text.includes(kw))) return null

  for (const type of EXPORT_TYPES) {
    const keywords: Record<string, string[]> = {
      docx: ['word', 'docx', 'doc'],
      xlsx: ['excel', 'xlsx'],
      pptx: ['ppt', 'pptx', '幻灯片'],
      md: ['markdown', 'md'],
      txt: ['txt', '文本文件'],
    }
    if (keywords[type.format].some(kw => text.includes(kw))) {
      return type
    }
  }
  return null
}

/**
 * 根据格式生成建议文件名（取 AI 回复开头作为标题）
 */
export function suggestFileName(content: string, intent: ExportIntent): string {
  const firstLine = content
    .split('\n')
    .map(l => l.replace(/^#+\s*/, '').trim())
    .find(l => l && l.length >= 2 && l.length <= 40)

  const base = (firstLine || '文档')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 30)
  const date = new Date().toISOString().slice(0, 10)
  return `${base}_${date}${intent.extension}`
}

/**
 * 解析 AI 回复为可导出内容：
 * - Excel 优先尝试从 Markdown 表格解析为数组
 * - 其余格式直接使用 Markdown 文本
 */
export function prepareExportContent(content: string, format: string): any {
  if (format !== 'xlsx') return content

  // 解析 Markdown 表格
  const tableLines = content.split('\n').filter(l => l.trim().startsWith('|'))
  if (tableLines.length >= 2) {
    const parseRow = (line: string): string[] =>
      line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

    const headers = parseRow(tableLines[0])
    const rows = tableLines.slice(2).map(parseRow)

    if (headers.length > 0 && rows.length > 0) {
      return rows.map(row => {
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => { obj[h || `列${i + 1}`] = row[i] ?? '' })
        return obj
      })
    }
  }

  // 无法解析表格时，按行写入单列
  return content.split('\n').filter(l => l.trim())
}

export function getFileFilters(format: string): { name: string; extensions: string[] }[] {
  const filters: Record<string, { name: string; extensions: string[] }[]> = {
    docx: [{ name: 'Word 文档', extensions: ['docx'] }],
    xlsx: [{ name: 'Excel 文档', extensions: ['xlsx'] }],
    pptx: [{ name: 'PowerPoint 文档', extensions: ['pptx'] }],
    md: [{ name: 'Markdown 文件', extensions: ['md'] }],
    txt: [{ name: '文本文件', extensions: ['txt'] }],
  }
  return filters[format] || [{ name: '所有文件', extensions: ['*'] }]
}