/**
 * 企业信息问答式引导管理器。
 *
 * 首次使用时由 Hermes 动态生成问题，逐轮收集企业基本信息，
 * AI 判断信息足够后输出完整企业画像 JSON，持久化并注入后续任务。
 */
export class OnboardingManager {
  private logManager: any
  private hermesManager: any
  private storageManager: any
  private intentRouter: any
  private sessionId: string | null = null

  constructor(logManager: any, hermesManager: any, storageManager: any, intentRouter: any) {
    this.logManager = logManager
    this.hermesManager = hermesManager
    this.storageManager = storageManager
    this.intentRouter = intentRouter
  }

  get activeSessionId(): string | null {
    return this.sessionId
  }

  private async ensureSession(): Promise<string> {
    if (!this.hermesManager.isRunning) {
      await this.hermesManager.start()
    }
    if (!this.sessionId) {
      this.sessionId = await this.hermesManager.createSession()
    }
    if (!this.sessionId) throw new Error('Hermes 会话创建失败')
    return this.sessionId
  }

  start(): Promise<string> {
    return this.ensureSession()
  }

  systemPrompt(): string {
    return [
      '你是 Hermes 人事行政智能专家的企业信息收集助手。',
      '你的任务是通过逐轮问答，了解使用企业的基础信息，用于后续生成更贴合该企业的制度、表单、文案与报表。',
      '规则：',
      '1. 每次回复必须只输出一个 JSON 对象，不要输出 JSON 以外的任何文字、代码块标记或解释。',
      '2. JSON 格式：{"phase":"ask","question":"下一个问题"} 或 {"phase":"done","profile":{...},"closing":"一句完成语"}。',
      '3. 第一轮 phase 必须是 ask，只问第一个最重要的问题。',
      '4. 根据用户回答动态选择下一个问题，优先补充对企业人事/行政工作最有影响的维度，例如：企业名称、所属行业、员工规模、主营业务、目标客户、所在城市、当前人事行政管理方式与痛点、使用 Hermes 的主要场景、品牌与语气偏好、敏感合规要求。',
      '5. 不要重复已问过的问题；当信息足够形成可用的企业画像（通常 6-10 轮）时，phase 输出 done，并在 profile 中汇总所有已知信息。',
      '6. profile 字段使用中文语义化 key（如 name/industry/scale/city/mainBusiness/targetCustomers/painPoints/usageScenarios/tone/compliance），未知字段不要编造，留空字符串。',
      '现在开始第一轮。'
    ].join('\n')
  }

  answerPrompt(answer: string): string {
    return [
      '企业信息收集继续。用户刚才回答：',
      answer,
      '',
      '请仍只输出一个 JSON 对象。',
      '若信息已足够，输出 {"phase":"done","profile":{...},"closing":"..."}；',
      '否则输出 {"phase":"ask","question":"下一个问题"}。'
    ].join('\n')
  }

  /**
   * 从 AI 完整回复中解析 JSON；解析失败时把原文作为问题返回，流程不中断。
   */
  parseReply(full: string): { phase: 'ask' | 'done' | 'invalid'; question?: string; profile?: any; closing?: string } {
    const text = (full || '').trim()
    if (!text) return { phase: 'invalid', question: '请再次回答上一个问题。' }

    // 提取最后一个 JSON 对象（模型可能夹带少量说明文字）
    const matches = text.match(/\{[\s\S]*\}/g)
    if (matches) {
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(matches[i])
          if (parsed && (parsed.phase === 'ask' || parsed.phase === 'done')) {
            return {
              phase: parsed.phase,
              question: parsed.question,
              profile: parsed.profile,
              closing: parsed.closing
            }
          }
        } catch { /* try next JSON candidate */ }
      }
    }

    // 兜底：把整段文本当问题展示，让用户继续回答
    return { phase: 'invalid', question: text }
  }

  saveProfile(profile: any): void {
    if (!profile || typeof profile !== 'object') return
    this.storageManager?.saveCompanyProfile?.(profile)
    this.hermesManager?.writeCompanyContext?.(profile)
    this.intentRouter?.setCompanyProfile?.(profile)
    this.logManager?.info('企业画像已保存')
  }
}
