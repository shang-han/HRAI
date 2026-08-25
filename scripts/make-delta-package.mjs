// 生成 Gitee 增量更新包
// 用法:
//   node scripts/make-delta-package.mjs <旧版本号> [旧构建目录] [新构建目录]
// 示例:
//   node scripts/make-delta-package.mjs 1.0.0 release/prev-win-unpacked release/win-unpacked
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
const newVersion = pkg.version
const prevVersion = process.argv[2]
if (!prevVersion) {
  console.error('用法: node scripts/make-delta-package.mjs <旧版本号> [旧构建目录] [新构建目录]')
  process.exit(1)
}
const prevDir = path.resolve(process.argv[3] || 'release/prev-win-unpacked')
const currDir = path.resolve(process.argv[4] || 'release/win-unpacked')
const outName = `delta-${prevVersion}-${newVersion}.zip`
const outPath = path.join('release', outName)

function walk(dir) {
  const map = new Map()
  function rec(base) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name)
      const rel = path.relative(dir, full).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        rec(full)
      } else {
        const data = fs.readFileSync(full)
        const hash = crypto.createHash('sha256').update(data).digest('hex')
        map.set(rel, { size: data.length, hash })
      }
    }
  }
  if (fs.existsSync(dir)) rec(dir)
  return map
}

console.log('对比构建目录...')
const prev = walk(prevDir)
const curr = walk(currDir)

const changed = []
const deleted = []
for (const [rel, info] of curr) {
  const old = prev.get(rel)
  if (!old || old.hash !== info.hash) changed.push(rel)
}
for (const rel of prev.keys()) {
  if (!curr.has(rel)) deleted.push(rel)
}

console.log(`新增/修改: ${changed.length} 个文件, 删除: ${deleted.length} 个文件`)

const zip = new AdmZip()
for (const rel of changed) {
  zip.addLocalFile(path.join(currDir, rel), path.dirname(rel))
}
zip.addFile('manifest.json', Buffer.from(JSON.stringify({ deleted }, null, 2), 'utf-8'))
fs.mkdirSync('release', { recursive: true })
zip.writeZip(outPath)
console.log(`增量包已生成: ${outPath}`)
console.log(`大小: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB`)
console.log(`发布时上传到 Gitee Release，并同时上传全量安装包。`)
