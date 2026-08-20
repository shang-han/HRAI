import React, { useState } from 'react'
import { Button, Input, Progress } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined, CheckOutlined, DatabaseOutlined } from '@ant-design/icons'

const QUESTIONS = [
  { key: 'name', label: '企业名称', placeholder: '例如：杭州示例科技有限公司' },
  { key: 'industry', label: '所属行业', placeholder: '例如：互联网软件 / 制造业 / 贸易' },
  { key: 'scale', label: '员工规模', placeholder: '例如：50-100 人' },
  { key: 'mainBusiness', label: '主营业务', placeholder: '简单描述公司主要做什么' },
  { key: 'targetCustomers', label: '目标客户', placeholder: '例如：中小企业客户 / 个人消费者' },
  { key: 'city', label: '所在城市', placeholder: '例如：杭州' },
  { key: 'painPoints', label: '当前人事/行政管理的痛点', placeholder: '例如：考勤靠手工统计、制度不完善、招聘周期长' },
  { key: 'usageScenarios', label: '最希望 Hermes 帮你做什么', placeholder: '例如：生成制度、写招聘文案、做考勤报表' },
  { key: 'tone', label: '品牌/文案语气偏好', placeholder: '例如：正式严谨 / 年轻活泼 / 简洁直接' },
  { key: 'compliance', label: '合规与敏感信息要求', placeholder: '例如：薪资信息需加密、文案避免绝对化承诺（可留空）' }
]

const CompanyOnboardingPage: React.FC<{ onCompleted: () => void }> = ({ onCompleted }) => {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const question = QUESTIONS[index]
  const isLast = index === QUESTIONS.length - 1

  const goNext = () => {
    if (isLast) {
      void handleSave()
    } else {
      setIndex(index + 1)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.electronAPI.company.saveAnswers(answers)
      onCompleted()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-blue-50 via-canvas to-canvas dark:from-canvas p-4">
      <div className="w-full max-w-xl bg-surface rounded-2xl shadow-xl p-6 flex flex-col" style={{ minHeight: 480 }}>
        <div className="text-center mb-5">
          <div className="text-3xl mb-2">🏢</div>
          <h1 className="text-xl font-bold text-ink">企业信息初始化</h1>
          <p className="text-sm text-inkMuted mt-1">
            共 {QUESTIONS.length} 个固定问题，答案会保存为全局个性化知识库，后续生成内容自动参考
          </p>
        </div>

        <div className="mb-4">
          <Progress
            percent={Math.round(((index + 1) / QUESTIONS.length) * 100)}
            showInfo={false}
            strokeColor={getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#4F46E5'}
          />
          <div className="text-xs text-inkMuted mt-1">
            第 {index + 1} / {QUESTIONS.length} 题
          </div>
        </div>

        <div className="flex-1">
          <div className="text-sm text-inkMuted mb-2 flex items-center gap-1">
            <DatabaseOutlined /> 全局个性化知识库
          </div>
          <label className="block text-base font-medium text-ink mb-2">
            {question.label}
          </label>
          <Input.TextArea
            autoFocus
            rows={5}
            value={answers[question.key] || ''}
            placeholder={question.placeholder}
            onChange={e => setAnswers(prev => ({ ...prev, [question.key]: e.target.value }))}
          />
          <div className="text-xs text-inkMuted mt-2">可以留空跳过，之后仍可在系统设置中补充。</div>
        </div>

        <div className="flex items-center justify-between mt-5">
          <Button
            icon={<ArrowLeftOutlined />}
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            上一题
          </Button>
          <Button type="primary" size="large" loading={saving} onClick={goNext} icon={isLast ? <CheckOutlined /> : <ArrowRightOutlined />}>
            {isLast ? '完成并保存' : '下一题'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CompanyOnboardingPage
