import React, { useEffect, useState } from 'react'
import { App as AntApp, Button, Input } from 'antd'

// 与引导页《企业信息问答》同源（CompanyOnboardingPage 的 QUESTIONS）：
// 改字段时两边要同步，否则引导页填的内容在这里看不到
const FIELDS = [
  { key: 'name', label: '企业名称', placeholder: '例如：杭州示例科技有限公司', wide: false },
  { key: 'industry', label: '所属行业', placeholder: '例如：互联网软件 / 制造业 / 贸易', wide: false },
  { key: 'scale', label: '员工规模', placeholder: '例如：50-100 人', wide: false },
  { key: 'mainBusiness', label: '主营业务', placeholder: '简单描述公司主要做什么', wide: true },
  { key: 'targetCustomers', label: '目标客户', placeholder: '例如：中小企业客户 / 个人消费者', wide: false },
  { key: 'city', label: '所在城市', placeholder: '例如：杭州', wide: false },
  { key: 'painPoints', label: '当前人事/行政管理的痛点', placeholder: '例如：考勤靠手工统计、制度不完善、招聘周期长', wide: true },
  { key: 'usageScenarios', label: '最希望 Hermes 帮你做什么', placeholder: '例如：生成制度、写招聘文案、做考勤报表', wide: true },
  { key: 'tone', label: '品牌/文案语气偏好', placeholder: '例如：正式严谨 / 年轻活泼 / 简洁直接', wide: false },
  { key: 'compliance', label: '合规与敏感信息要求', placeholder: '例如：薪资信息需加密、文案避免绝对化承诺（可留空）', wide: true }
]

/**
 * 企业画像编辑（统一设置面板「企业画像」页）。
 * 保存后主进程会同步写入 Hermes 工作区 company_context.json，
 * 所有会话的 AI 都会读取（全局生效）。
 */
const CompanyProfileSection: React.FC = () => {
  const { message } = AntApp.useApp()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.company.status()
      .then(status => {
        const profile = status?.profile || {}
        const initial: Record<string, string> = {}
        for (const f of FIELDS) initial[f.key] = String(profile[f.key] || '')
        setAnswers(initial)
      })
      .catch(() => { /* 读不到就留空表单，保存时会覆盖 */ })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await window.electronAPI.company.saveAnswers(answers)
      message.success('企业画像已保存，全局生效')
    } catch (err: any) {
      message.error(err?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-inkMuted">
        企业画像会注入所有会话的 AI 上下文（公司背景、痛点、语气偏好等），保存后全局生效。
      </p>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map(f => (
          <div key={f.key} className={f.wide ? 'col-span-2' : ''}>
            <div className="text-xs text-inkMuted mb-1">{f.label}</div>
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 4 }}
              value={answers[f.key] || ''}
              placeholder={f.placeholder}
              onChange={e => setAnswers(prev => ({ ...prev, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <Button type="primary" loading={saving} onClick={save}>保存企业画像</Button>
    </div>
  )
}

export default CompanyProfileSection
