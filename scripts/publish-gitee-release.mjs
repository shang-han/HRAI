// 发布 Gitee Release 并上传全量安装包
// 需要 Gitee Private Token（不要提交到 git）：
//   GITEE_TOKEN=xxx node scripts/publish-gitee-release.mjs
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const token = process.env.GITEE_TOKEN
if (!token) {
  console.error('缺少 GITEE_TOKEN。请在 Gitee 生成私人令牌后执行：')
  console.error('  GITEE_TOKEN=你的token node scripts/publish-gitee-release.mjs')
  process.exit(1)
}

const owner = process.env.GITEE_OWNER || 'dk-zy'
const repo = process.env.GITEE_REPO || 'hrai'
const cur = pkg.version.split('.').map(Number)
const version = process.env.RELEASE_VERSION || `${cur[0]}.${cur[1]}.${(cur[2] || 0) + 1}`
const tag = `v${version}`
const releaseFile = process.env.RELEASE_FILE || path.resolve(`release/Hermes人事行政智能专家 Setup ${version}.exe`)
if (!fs.existsSync(releaseFile)) {
  console.error('未找到安装包:', releaseFile)
  process.exit(1)
}

const base = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases`
const q = `access_token=${encodeURIComponent(token)}`

async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : JSON.stringify(body)
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(`${method} ${url} -> HTTP ${resp.status}: ${JSON.stringify(data)}`)
  return data
}

const release = await api('POST', `${base}?${q}`, {
  tag_name: tag,
  name: `Hermes HR Admin v${version}`,
  body: `Hermes 人事行政智能专家 v${version}\n\n本版本包含：\n- ACP 响应解析修复\n- Git Bash 工具卡死修复\n- Gitee 在线升级支持\n- 微信/企微渠道单通道`,
  target_commitish: 'master',
  prerelease: false
})
console.log('release created:', release.id || release.tag_name)

const form = new FormData()
form.append('file', new Blob([fs.readFileSync(releaseFile)]), path.basename(releaseFile))
await api('POST', `${base}/${release.id}/attach_files?${q}`, form)
console.log('asset uploaded:', path.basename(releaseFile))
console.log('done')
