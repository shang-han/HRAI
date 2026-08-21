import https from 'https'
import http from 'http'
import zlib from 'zlib'
import { StorageManager } from './storage-manager'

interface ModelProvider {
  id: string
  name: string
  type: 'dialogue' | 'image' | 'video' | 'multimodal'
  apiEndpoint: string
  apiKey: string
  modelName: string
  params: Record<string, any>
  enabled: boolean
  isPrimary?: boolean
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

// 任务类型关键词映射
const TASK_KEYWORDS: Record<string, string[]> = {
  image: ['生成图片', '画', '绘图', '流程图', '架构图', '示意图', '插图'],
  video: ['视频脚本', '分镜', '短视频', '培训视频'],
  multimodal: ['分析图片', '识别', '看图', '图片内容', '图文分析']
}

export class ModelRouter {
  private storageManager: StorageManager
  private activeRequests = new Map<string, { destroy: () => void }>()

  constructor(storageManager: StorageManager) {
    this.storageManager = storageManager
  }

  /**
   * 将用户填写的 OpenAI 兼容地址规范化为完整的 /chat/completions 端点。
   * 兼容类似 https://dashscope.aliyuncs.com/compatible-mode/v1 的 base 地址。
   */
  private normalizeChatEndpoint(endpoint: string): string {
    const trimmed = endpoint.trim().replace(/\/+$/, '')
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed
    return `${trimmed}/chat/completions`
  }

  /**
   * 获取当前对话模型：优先 isPrimary，其次第一个启用的
   */
  getDefaultDialogueModel(config: any): ModelProvider | null {
    const providers: ModelProvider[] = config?.modelConfig?.dialogue || []
    return (
      providers.find(p => p.enabled && p.isPrimary) ||
      providers.find(p => p.enabled) ||
      null
    )
  }

  /**
   * 测试模型连接
   */
  async testConnection(model: ModelProvider): Promise<{ success: boolean; message: string }> {
    if (!model?.apiEndpoint) return { success: false, message: '请先填写 API 端点' }
    if (!model?.modelName) return { success: false, message: '请先填写模型名称' }
    if (!model?.apiKey?.trim()) return { success: false, message: '请先填写 API Key' }

    try {
      const start = Date.now()
      const content = await this.callOpenAICompatible(model, [
        { role: 'user', content: '请只回复"OK"两个字。' }
      ])
      const elapsed = Date.now() - start
      return { success: true, message: `连接成功（${elapsed}ms）` }
    } catch (err: any) {
      return { success: false, message: err.message }
    }
  }

  /**
   * 从 OpenAI 兼容 API 获取可用模型名称列表。
   * 支持 DeepSeek / OpenAI / 通义千问（DashScope 兼容模式）/ 智谱等。
   */
  async listModels(model: ModelProvider): Promise<{ success: boolean; models?: string[]; message?: string }> {
    if (!model?.apiEndpoint) return { success: false, message: '请先填写 API 端点' }
    if (!model?.apiKey?.trim()) return { success: false, message: '请先填写 API Key' }

    const normalized = this.normalizeChatEndpoint(model.apiEndpoint)
    const base = normalized.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
    const url = `${base}/models`

    try {
      const raw = await this.httpGetJson(url, model.apiKey.trim())
      const ids: string[] = []

      if (Array.isArray(raw?.data)) {
        for (const item of raw.data) {
          if (item?.id) ids.push(String(item.id))
        }
      } else if (Array.isArray(raw?.models)) {
        for (const item of raw.models) {
          if (typeof item === 'string') ids.push(item)
          else if (item?.id) ids.push(String(item.id))
        }
      } else if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === 'string') ids.push(item)
          else if (item?.id) ids.push(String(item.id))
        }
      }

      const unique = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
      if (unique.length === 0) {
        return { success: false, message: '接口返回中未找到模型列表（该厂商可能不提供 /models 接口）' }
      }
      return { success: true, models: unique }
    } catch (err: any) {
      return { success: false, message: err.message || '获取模型列表失败' }
    }
  }

  private httpGetJson(url: string, apiKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http
      const req = client.get(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        }
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            let detail = ''
            try {
              const parsed = JSON.parse(body)
              detail = parsed?.error?.message || parsed?.message || body.slice(0, 200)
            } catch {
              detail = body.slice(0, 200)
            }
            reject(new Error(`HTTP ${res.statusCode}：${detail || '该接口可能不支持模型列表查询'}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`模型列表响应不是有效 JSON：${body.slice(0, 160)}`))
          }
        })
      })
      req.setTimeout(15000, () => req.destroy(new Error('获取模型列表超时')))
      req.on('error', (err) => reject(err))
    })
  }

  /**
   * 中止指定 channel 的流式请求
   */
  abort(channel: string): void {
    const req = this.activeRequests.get(channel)
    if (req) {
      req.destroy()
      this.activeRequests.delete(channel)
    }
  }

  abortAll(): void {
    for (const [, req] of this.activeRequests) {
      try { req.destroy() } catch { /* ignore */ }
    }
    this.activeRequests.clear()
  }

  /**
   * 自动路由：根据消息内容判断任务类型，返回对应的模型
   */
  autoRoute(message: string): ModelProvider | null {
    const config = this.storageManager.getConfig()
    const { modelConfig } = config

    // 检测任务类型
    const taskType = this.detectTaskType(message)

    let providers: ModelProvider[]
    switch (taskType) {
      case 'image':
        providers = modelConfig.image
        break
      case 'video':
        providers = modelConfig.video
        break
      case 'multimodal':
        providers = modelConfig.multimodal
        break
      default:
        providers = modelConfig.dialogue
    }

    // 返回第一个启用的模型
    return providers.find(p => p.enabled) || providers[0] || null
  }

  getMultimodalModel(): ModelProvider | null {
    const providers = this.storageManager.getConfig()?.modelConfig?.multimodal || []
    return providers.find(p => p.enabled) || providers[0] || null
  }

  /**
   * 检测任务类型
   */
  private detectTaskType(message: string): 'dialogue' | 'image' | 'video' | 'multimodal' {
    for (const [type, keywords] of Object.entries(TASK_KEYWORDS)) {
      if (keywords.some(kw => message.includes(kw))) {
        return type as any
      }
    }
    return 'dialogue'
  }

  /**
   * 调用模型（非流式）
   */
  async callModel(model: ModelProvider | null, message: string, config: any, images?: string[]): Promise<{ success: boolean; content?: string; error?: string }> {
    if (!model) {
      return { success: false, error: '没有可用的模型，请先在右上角"模型"中配置并启用一个对话模型' }
    }

    if (!model.apiKey || model.apiKey.trim() === '') {
      return { success: false, error: `${model.name} 的 API Key 未配置，请点击右上角"模型"按钮填写` }
    }

    try {
      if (model.type === 'image') {
        return await this.callImageModel(model, message)
      }

      // 构建消息
      const messages: ChatMessage[] = []

      // 添加系统提示（HR合规提醒）
      if (this.isHRTask(message)) {
        messages.push({
          role: 'system',
          content: '你是人事行政一体化智能专家。在生成涉及人事、劳动用工、员工档案等内容时，请在文档末尾附带用工合规风险提示。内容应结构完整、语言正式通俗、适合中小企业执行。'
        })
      }

      // 添加用户消息
      if (images && images.length > 0 && model.type === 'multimodal') {
        const content: any[] = [{ type: 'text', text: message }]
        for (const img of images) {
          content.push({ type: 'image_url', image_url: { url: img } })
        }
        messages.push({ role: 'user', content })
      } else {
        messages.push({ role: 'user', content: message })
      }

      const response = await this.callOpenAICompatible(model, messages)
      return { success: true, content: response }
    } catch (err: any) {
      return { success: false, error: `模型调用失败: ${err.message}` }
    }
  }

  /**
   * 调用模型（流式）
   */
  async callModelStream(
    model: ModelProvider | null,
    message: string,
    config: any,
    onChunk: (chunk: string) => void,
    onError: (error: string) => void,
    onDone: () => void,
    abortKey?: string,
    images?: string[]
  ): Promise<void> {
    if (!model) {
      onError('没有可用的模型，请先在右上角"模型"中配置并启用一个对话模型')
      return
    }

    if (!model.apiKey || model.apiKey.trim() === '') {
      onError(`${model.name} 的 API Key 未配置，请点击右上角"模型"按钮填写`)
      return
    }

    try {
      const messages: ChatMessage[] = []

      if (this.isHRTask(message)) {
        messages.push({
          role: 'system',
          content: '你是人事行政一体化智能专家。在生成涉及人事、劳动用工、员工档案等内容时，请在文档末尾附带用工合规风险提示。内容应结构完整、语言正式通俗、适合中小企业执行。'
        })
      }

      if (images && images.length > 0 && model.type === 'multimodal') {
        const content: any[] = [{ type: 'text', text: message }]
        for (const img of images) {
          content.push({ type: 'image_url', image_url: { url: img } })
        }
        messages.push({ role: 'user', content })
      } else {
        messages.push({ role: 'user', content: message })
      }

      await this.callOpenAICompatibleStream(model, messages, onChunk, onError, onDone, abortKey)
    } catch (err: any) {
      onError(`模型调用失败: ${err.message}`)
    }
  }

  /**
   * OpenAI 兼容接口调用（非流式）
   */
  private async callOpenAICompatible(model: ModelProvider, messages: ChatMessage[]): Promise<string> {
    const url = new URL(this.normalizeChatEndpoint(model.apiEndpoint))
    const body = JSON.stringify({
      model: model.modelName,
      messages,
      stream: false,
      ...model.params
    })

    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
          'Accept-Encoding': 'gzip, deflate, br',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 60000
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          let data: string
          try {
            data = this.decodeBody(res, buf)
          } catch (err: any) {
            reject(new Error(`响应解压失败: ${err.message}`))
            return
          }

          // 非 2xx 状态：优先解析错误信息
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const json = JSON.parse(data)
              if (json.error?.message) {
                reject(new Error(`HTTP ${res.statusCode}: ${json.error.message}`))
                return
              }
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`))
              return
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`))
              return
            }
          }

          try {
            const json = JSON.parse(data)
            if (json.choices?.[0]?.message?.content) {
              resolve(json.choices[0].message.content)
            } else if (json.error) {
              reject(new Error(json.error.message || '模型返回错误'))
            } else if (!data.trim()) {
              reject(new Error('模型返回空响应'))
            } else {
              reject(new Error('无法解析模型响应'))
            }
          } catch {
            reject(new Error(`响应解析失败 (HTTP ${res.statusCode}): ${data.substring(0, 300)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })

      req.write(body)
      req.end()
    })
  }

  /**
   * 根据 Content-Encoding 解压响应体
   */
  private decodeBody(res: { headers: http.IncomingHttpHeaders }, buf: Buffer): string {
    const enc = (res.headers['content-encoding'] || '').toLowerCase().trim()
    let decoded = buf
    if (enc === 'gzip') {
      decoded = zlib.gunzipSync(buf)
    } else if (enc === 'deflate') {
      try {
        decoded = zlib.inflateSync(buf)
      } catch {
        decoded = zlib.inflateRawSync(buf)
      }
    } else if (enc === 'br') {
      decoded = zlib.brotliDecompressSync(buf)
    }
    return decoded.toString('utf-8')
  }

  /**
   * 根据 Content-Encoding 返回解码后的响应流
   */
  private decodeStream(res: http.IncomingMessage): NodeJS.ReadableStream {
    const enc = (res.headers['content-encoding'] || '').toLowerCase().trim()
    if (enc === 'gzip') return res.pipe(zlib.createGunzip())
    if (enc === 'deflate') return res.pipe(zlib.createInflate())
    if (enc === 'br') return res.pipe(zlib.createBrotliDecompress())
    return res
  }

  /**
   * OpenAI 兼容接口调用（流式 SSE）
   */
  private async callOpenAICompatibleStream(
    model: ModelProvider,
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onError: (error: string) => void,
    onDone: () => void,
    abortKey?: string
  ): Promise<void> {
    const url = new URL(this.normalizeChatEndpoint(model.apiEndpoint))
    const body = JSON.stringify({
      model: model.modelName,
      messages,
      stream: true,
      ...model.params
    })

    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
          'Accept-Encoding': 'gzip, deflate, br',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 120000
      }, (res) => {
        // 非 2xx：收集响应并返回错误信息
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            let data = ''
            try { data = this.decodeBody(res, Buffer.concat(chunks)) } catch { /* ignore */ }
            let msg = `HTTP ${res.statusCode}`
            try {
              const json = JSON.parse(data)
              if (json.error?.message) msg = `HTTP ${res.statusCode}: ${json.error.message}`
            } catch { /* ignore */ }
            if (!data.trim()) msg += ': 服务返回空响应'
            onError(msg)
            reject(new Error(msg))
          })
          return
        }

        let buffer = ''
        const stream = this.decodeStream(res)

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue

            const data = trimmed.slice(6)
            if (data === '[DONE]') {
              onDone()
              resolve()
              return
            }

            try {
              const json = JSON.parse(data)
              const content = json.choices?.[0]?.delta?.content
              if (content) {
                onChunk(content)
              }
            } catch {
              // 忽略解析错误
            }
          }
        })

        stream.on('end', () => {
          onDone()
          resolve()
        })

        stream.on('error', (err) => {
          if (req.destroyed && !req.aborted) return
          onError(err.message)
          reject(err)
        })
      })

      if (abortKey) {
        this.activeRequests.set(abortKey, {
          destroy: () => {
            req.destroy()
            this.activeRequests.delete(abortKey)
          }
        })
      }

      req.on('error', (err) => {
        if (abortKey) this.activeRequests.delete(abortKey)
        onError(err.message)
        reject(err)
      })

      req.on('close', () => {
        if (abortKey) this.activeRequests.delete(abortKey)
      })

      req.on('timeout', () => {
        req.destroy()
        onError('请求超时')
        reject(new Error('请求超时'))
      })

      req.write(body)
      req.end()
    })
  }

  /**
   * 调用图片生成模型
   */
  private async callImageModel(model: ModelProvider, prompt: string): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const url = new URL(model.apiEndpoint)
      const body = JSON.stringify({
        model: model.modelName,
        input: { prompt },
        parameters: model.params
      })

      const response = await new Promise<any>((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http
        const req = client.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${model.apiKey}`,
            'X-DashScope-Async': 'enable',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 60000
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error('响应解析失败'))
            }
          })
        })

        req.on('error', reject)
        req.write(body)
        req.end()
      })

      if (response.output?.task_id) {
        return { success: true, content: `图片生成任务已提交，任务ID: ${response.output.task_id}` }
      } else if (response.output?.results) {
        const urls = response.output.results.map((r: any) => r.url).join('\n')
        return { success: true, content: `图片已生成:\n${urls}` }
      } else {
        return { success: false, error: response.message || '图片生成失败' }
      }
    } catch (err: any) {
      return { success: false, error: `图片模型调用失败: ${err.message}` }
    }
  }

  /**
   * 判断是否为 HR 相关任务
   */
  private isHRTask(message: string): boolean {
    const hrKeywords = ['招聘', '入职', '离职', '考勤', '薪资', '薪酬', '绩效', '员工', '档案', '劳动合同', '社保', '公积金', '加班', '请假', '排班', '培训']
    return hrKeywords.some(kw => message.includes(kw))
  }
}
