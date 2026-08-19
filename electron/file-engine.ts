import fs from 'fs'
import path from 'path'

export class FileEngine {
  /**
   * 导入文件
   */
  async importFile(filePath: string): Promise<{ success: boolean; content?: string; type?: string; error?: string }> {
    try {
      const ext = path.extname(filePath).toLowerCase()
      const stat = fs.statSync(filePath)

      // 检查文件大小（20MB限制）
      if (stat.size > 20 * 1024 * 1024) {
        return { success: false, error: '文件大小超过 20MB 限制' }
      }

      // 文本文件
      if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        return { success: true, content, type: 'text' }
      }

      // 图片文件
      if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
        const buffer = fs.readFileSync(filePath)
        const base64 = buffer.toString('base64')
        const mimeType = this.getImageMimeType(ext)
        const dataUrl = `data:${mimeType};base64,${base64}`
        return { success: true, content: dataUrl, type: 'image' }
      }

      return { success: false, error: `不支持的文件格式: ${ext}` }
    } catch (err: any) {
      return { success: false, error: `文件读取失败: ${err.message}` }
    }
  }

  /**
   * 导出文件
   */
  async exportFile(format: string, content: any, filePath: string): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      switch (format) {
        case 'txt':
          fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8')
          break

        case 'md':
          fs.writeFileSync(filePath, typeof content === 'string' ? content : this.toMarkdown(content), 'utf-8')
          break

        case 'docx':
          await this.exportDocx(content, filePath)
          break

        case 'xlsx':
          await this.exportXlsx(content, filePath)
          break

        case 'pptx':
          await this.exportPptx(content, filePath)
          break

        default:
          return { success: false, error: `不支持的导出格式: ${format}` }
      }

      return { success: true, message: `文件已导出到: ${filePath}` }
    } catch (err: any) {
      return { success: false, error: `导出失败: ${err.message}` }
    }
  }

  /**
   * 导出 Word 文档
   */
  private async exportDocx(content: any, filePath: string): Promise<void> {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')

    const paragraphs: InstanceType<typeof Paragraph>[] = []

    if (typeof content === 'string') {
      // 将 markdown 文本转换为 docx 段落
      const lines = content.split('\n')
      for (const line of lines) {
        if (line.startsWith('# ')) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line.slice(2), bold: true, size: 32 })],
            heading: HeadingLevel.HEADING_1
          }))
        } else if (line.startsWith('## ')) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line.slice(3), bold: true, size: 28 })],
            heading: HeadingLevel.HEADING_2
          }))
        } else if (line.startsWith('### ')) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line.slice(4), bold: true, size: 24 })],
            heading: HeadingLevel.HEADING_3
          }))
        } else if (line.trim()) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line })]
          }))
        } else {
          paragraphs.push(new Paragraph({ children: [] }))
        }
      }
    }

    const doc = new Document({
      sections: [{
        children: paragraphs.length > 0 ? paragraphs : [
          new Paragraph({ children: [new TextRun({ text: '空文档' })] })
        ]
      }]
    })

    const buffer = await Packer.toBuffer(doc)
    fs.writeFileSync(filePath, buffer)
  }

  /**
   * 导出 Excel 文件
   */
  private async exportXlsx(content: any, filePath: string): Promise<void> {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()

    if (Array.isArray(content) && content.length > 0) {
      const sheet = workbook.addWorksheet('Sheet1')

      // 表头
      if (typeof content[0] === 'object') {
        const headers = Object.keys(content[0])
        sheet.addRow(headers)
        sheet.getRow(1).font = { bold: true }

        // 数据行
        for (const row of content) {
          sheet.addRow(headers.map(h => (row as any)[h]))
        }
      } else {
        // 简单数组
        for (const item of content) {
          sheet.addRow([item])
        }
      }

      // 自动列宽
      sheet.columns.forEach(col => {
        col.width = 20
      })
    } else {
      // 空表格
      const sheet = workbook.addWorksheet('Sheet1')
      sheet.addRow(['空表格'])
    }

    await workbook.xlsx.writeFile(filePath)
  }

  /**
   * 导出 PowerPoint 文件
   */
  private async exportPptx(content: any, filePath: string): Promise<void> {
    const PptxGenJS = (await import('pptxgenjs')).default
    const pptx = new PptxGenJS()

    if (typeof content === 'string') {
      // 将文本内容按段落分成幻灯片
      const sections = content.split(/\n---\n|\n##\s/).filter(s => s.trim())

      if (sections.length === 0) {
        const slide = pptx.addSlide()
        slide.addText(content.substring(0, 500), { x: 0.5, y: 0.5, w: 9, h: 6.5, fontSize: 14 })
      } else {
        for (const section of sections) {
          const slide = pptx.addSlide()
          slide.addText(section.trim(), { x: 0.5, y: 0.5, w: 9, h: 6.5, fontSize: 14, valign: 'top' })
        }
      }
    } else if (Array.isArray(content)) {
      for (const item of content) {
        const slide = pptx.addSlide()
        if (item.title) {
          slide.addText(item.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 24, bold: true })
        }
        if (item.content) {
          slide.addText(item.content, { x: 0.5, y: 1.5, w: 9, h: 5.5, fontSize: 14, valign: 'top' })
        }
      }
    }

    await pptx.writeFile({ fileName: filePath })
  }

  /**
   * 导入模板文件
   */
  async importTemplates(filePath: string): Promise<{ success: boolean; templates?: any[]; error?: string }> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const templates = JSON.parse(content)
      if (!Array.isArray(templates)) {
        return { success: false, error: '模板文件格式不正确' }
      }
      return { success: true, templates }
    } catch (err: any) {
      return { success: false, error: `模板导入失败: ${err.message}` }
    }
  }

  /**
   * 导出模板文件
   */
  async exportTemplates(filePath: string, templates: any[]): Promise<{ success: boolean; error?: string }> {
    try {
      fs.writeFileSync(filePath, JSON.stringify(templates, null, 2), 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `模板导出失败: ${err.message}` }
    }
  }

  private getImageMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp'
    }
    return map[ext] || 'image/png'
  }

  private toMarkdown(content: any): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((item: any) => {
        if (typeof item === 'string') return item
        return Object.entries(item).map(([k, v]) => `**${k}**: ${v}`).join('\n')
      }).join('\n\n---\n\n')
    }
    return JSON.stringify(content, null, 2)
  }
}
