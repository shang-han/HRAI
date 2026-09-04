import React, { useEffect, useState } from 'react'
import { App as AntApp, Button, Empty, Tag } from 'antd'
import { DeleteOutlined, FileTextOutlined } from '@ant-design/icons'

interface KnowledgeAssetMeta {
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

/**
 * 设置面板「文档资产」页：企业文档资产库列表（查看/删除）。
 * 采纳入口在聊天消息下方的「采纳为资产」按钮，不在这里。
 */
const KnowledgeAssetsView: React.FC = () => {
  const { message } = AntApp.useApp()
  const [assets, setAssets] = useState<KnowledgeAssetMeta[]>([])

  // 每次点进本页都会重新挂载，直接拉一次即可
  useEffect(() => {
    window.electronAPI.knowledge.list()
      .then(list => setAssets(list || []))
      .catch(() => setAssets([]))
  }, [])

  const remove = async (a: KnowledgeAssetMeta) => {
    await window.electronAPI.knowledge.remove(a.id)
    setAssets(list => list.filter(x => x.id !== a.id))
    message.success(`已移除 ${a.fileName}`)
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium mb-2">文档资产</h3>
        <p className="text-xs text-inkMuted leading-5">
          用户确认的产出文件入库后，AI 写同类内容时会自动检索并参考这些资产——越用越懂你的企业。
        </p>
      </div>
      <div className="text-xs text-inkMuted space-y-1">
        <p>· 入库方式：对话产出文件后，点击消息下方的「采纳为资产」确认入库（勾选 xlsx 时可同时选「把表结构存为我的惯用格式」）。</p>
        <p>· 支持类型：docx / pptx / md / txt / csv + xlsx 的文本、口径与术语。</p>
        <p>· xlsx 的<b>表结构</b>（列顺序/类型/公式）由侧边栏「我的格式」页管理，与本页内容分离。</p>
      </div>
      {assets.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-xs text-inkMuted">还没有文档资产。对话产出后，点击消息下方的「采纳为资产」即可入库。</span>} />
      ) : (
        <div className="space-y-1">
          {assets.map(a => (
            <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surfaceSubtle dark:bg-canvas text-sm text-inkSecondary">
              <FileTextOutlined className="text-inkMuted shrink-0" />
              <span className="truncate flex-1" title={a.fileName}>{a.fileName}</span>
              {a.keywords.slice(0, 4).map(k => (
                <Tag key={k} className="ml-1 mr-0 text-xs" bordered={false}>{k}</Tag>
              ))}
              <span className="text-xs text-inkMuted shrink-0">{a.totalChars} 字</span>
              <span className="text-xs text-inkMuted shrink-0">{new Date(a.addedAt).toLocaleDateString('zh-CN')}</span>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(a)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default KnowledgeAssetsView
