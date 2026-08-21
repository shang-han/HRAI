import fs from 'fs'
import path from 'path'
import { app, shell } from 'electron'
import AdmZip from 'adm-zip'

interface UpdateConfig {
  owner: string
  repo: string
}

interface ReleaseInfo {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string
  releaseNotes: string
  downloadUrl: string
  fileName: string
  size: number
  publishedAt: string
  /** incremental=增量更新 | full=全量更新 */
  updateType: 'incremental' | 'full'
  deltaUrl: string
  deltaFileName: string
  deltaSize: number
  /** Gitee 单附件 100MB 限制下的全量安装包分卷 */
  parts: Array<{ name: string; url: string; size: number }>
}

interface DownloadState {
  total: number
  downloaded: number
  percent: number
  filePath: string
}

function compareVersions(a: string, b: string): number {
  const na = a.replace(/^v/i, '').toLowerCase()
  const nb = b.replace(/^v/i, '').toLowerCase()
  const pa = na.split('.').map(n => parseInt(n, 10) || 0)
  const pb = nb.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
  // 数值相同：预发布版本（含 -，如 1.0.1-beta）低于正式版
  const aPre = na.includes('-')
  const bPre = nb.includes('-')
  if (aPre !== bPre) return aPre ? -1 : 1
  return 0
}

/**
 * Gitee 在线升级管理器。
 * 检查 Gitee Releases 最新版本 -> 下载安装包 -> 调用安装程序。
 */
export class GiteeUpdater {
  private getConfig: () => UpdateConfig
  private onProgress: ((state: DownloadState) => void) | null = null
  private downloadAbort: AbortController | null = null

  constructor(getConfig: () => UpdateConfig) {
    this.getConfig = getConfig
  }

  setProgressHandler(handler: (state: DownloadState) => void | null) {
    this.onProgress = handler
  }

  private validateConfig(): UpdateConfig {
    const cfg = this.getConfig()
    const owner = (cfg.owner || '').trim()
    const repo = (cfg.repo || '').trim()
    if (!owner || !repo) {
      throw new Error('请先在系统设置中填写 Gitee 仓库 owner/repo')
    }
    return { owner, repo }
  }

  async checkForUpdates(): Promise<ReleaseInfo> {
    const { owner, repo } = this.validateConfig()
    const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`

    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Hermes-HR-Admin-Updater' },
      signal: AbortSignal.timeout(15000)
    })
    if (resp.status === 404) {
      return {
        hasUpdate: false,
        latestVersion: '',
        currentVersion: app.getVersion(),
        releaseNotes: '',
        downloadUrl: '',
        fileName: '',
        size: 0,
        publishedAt: '',
        updateType: 'full',
        deltaUrl: '',
        deltaFileName: '',
        deltaSize: 0,
        parts: []
      }
    }
    if (!resp.ok) {
      throw new Error(`检查更新失败：HTTP ${resp.status}`)
    }

    const release: any = await resp.json()
    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '')
    const currentVersion = app.getVersion()
    const assets: any[] = Array.isArray(release.assets) ? release.assets : []
    const exactExe = assets.find((a: any) => /\.exe$/i.test(a.name || ''))
    const firstPart = assets.find((a: any) => /\.exe\.part\d+$/i.test(a.name || ''))
    const exeAsset = exactExe || assets[0]
    const downloadUrl = String(exactExe?.browser_download_url || release.assets_url || '')

    let fileName = String(exeAsset?.name || `Hermes-Setup-${latestVersion}.exe`)
    if (!exactExe && firstPart) {
      fileName = String(firstPart.name).replace(/\.part\d+$/i, '')
    }

    // 分卷附件按编号排序
    const partAssets = fileName
      ? assets
          .filter((a: any) => String(a.name || '').toLowerCase().startsWith(fileName.toLowerCase() + '.part'))
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
      : []
    const parts = partAssets.map((a: any) => ({
      name: String(a.name),
      url: String(a.browser_download_url || ''),
      size: Number(a.size || 0)
    }))

    // 增量包命名约定：delta-<旧版本>-<新版本>.zip
    const deltaPatterns = [
      `delta-${currentVersion}-${latestVersion}.zip`,
      `delta-v${currentVersion}-v${latestVersion}.zip`
    ]
    const deltaAsset =
      assets.find((a: any) => deltaPatterns.includes(String(a.name || '').toLowerCase())) ||
      assets.find((a: any) => /^delta-.*\.zip$/i.test(a.name || ''))
    const deltaUrl = String(deltaAsset?.browser_download_url || '')
    const deltaSize = Number(deltaAsset?.size || 0)
    const fullSize = exactExe
      ? Number(exactExe.size || 0)
      : parts.reduce((sum, part) => sum + part.size, 0)

    // 策略：同 major.minor 版本线且增量包存在，并且增量包明显小于全量包时使用增量；
    // 跨大版本或增量包接近全量包大小时回退全量更新。
    const [curMajor, curMinor] = currentVersion.split('.').map(n => parseInt(n, 10) || 0)
    const [newMajor, newMinor] = latestVersion.split('.').map(n => parseInt(n, 10) || 0)
    const sameSeries = curMajor === newMajor && curMinor === newMinor
    const useDelta = !!deltaUrl && sameSeries && (fullSize === 0 || deltaSize < fullSize * 0.75)

    // 预发布版本不视为正式更新（避免已是最新时还弹更新框）
    const isPrerelease = release.prerelease === true
    return {
      hasUpdate: !isPrerelease && !!latestVersion && compareVersions(latestVersion, currentVersion) > 0,
      latestVersion,
      currentVersion,
      releaseNotes: String(release.body || release.notes || ''),
      downloadUrl,
      fileName,
      size: fullSize,
      publishedAt: String(release.created_at || ''),
      updateType: useDelta ? 'incremental' : 'full',
      deltaUrl,
      deltaFileName: String(deltaAsset?.name || ''),
      deltaSize,
      parts
    }
  }

  async downloadLatest(): Promise<{ filePath: string; updateType: 'incremental' | 'full' }> {
    const info = await this.checkForUpdates()
    if (!info.hasUpdate) {
      throw new Error('当前已经是最新版本')
    }
    if (!info.downloadUrl) {
      throw new Error('没有找到可用的更新包')
    }

    const incremental = info.updateType === 'incremental' && !!info.deltaUrl
    const fileName = incremental ? (info.deltaFileName || `delta-${info.currentVersion}-${info.latestVersion}.zip`) : info.fileName

    this.downloadAbort?.abort()
    this.downloadAbort = new AbortController()

    const updateDir = path.join(app.getPath('userData'), 'updates')
    if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true })
    const filePath = path.join(updateDir, fileName)

    if (!incremental && !info.downloadUrl && info.parts.length > 0) {
      // Gitee 分卷下载：逐个下载后按顺序合并
      const partPaths: string[] = []
      let downloadedTotal = 0
      for (const part of info.parts) {
        const partPath = `${filePath}.${part.name.match(/part\d+$/i)?.[0] || 'part'}`
        await this.downloadToFile(part.url, partPath, part.size, downloadedTotal, info.size)
        downloadedTotal += part.size
        partPaths.push(partPath)
      }
      const out = fs.openSync(filePath, 'w')
      for (const partPath of partPaths) {
        const data = fs.readFileSync(partPath)
        fs.writeSync(out, data)
        fs.unlinkSync(partPath)
      }
      fs.closeSync(out)
      this.onProgress?.({ total: info.size, downloaded: info.size, percent: 100, filePath })
      return { filePath, updateType: 'full' }
    }

    const url = incremental ? info.deltaUrl : info.downloadUrl
    await this.downloadToFile(url, filePath, info.size, 0, info.size)
    return { filePath, updateType: incremental ? 'incremental' : 'full' }
  }

  private async downloadToFile(url: string, filePath: string, partSize: number, offsetBase: number, total: number): Promise<void> {
    const resp = await fetch(url, { signal: this.downloadAbort?.signal })
    if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`)

    const expected = Number(resp.headers.get('content-length') || partSize || 0)
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let downloaded = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      downloaded += value.length
      const current = offsetBase + downloaded
      this.onProgress?.({
        total: total || expected,
        downloaded: current,
        percent: total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 0,
        filePath
      })
    }

    fs.writeFileSync(filePath, Buffer.concat(chunks))
  }

  /**
   * 安装更新：
   * - 全量：启动下载好的 NSIS 安装程序
   * - 增量：解压变更文件到安装目录，删除已移除文件，然后重启应用
   */
  async install(filePath: string, updateType: 'incremental' | 'full' = 'full'): Promise<void> {
    if (!fs.existsSync(filePath)) throw new Error('更新包不存在，请重新下载')

    if (updateType === 'incremental') {
      this.applyDelta(filePath)
      app.relaunch()
      app.quit()
      return
    }

    await shell.openPath(filePath)
  }

  private applyDelta(filePath: string): void {
    const installRoot = path.dirname(app.getPath('exe'))
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries()

    const manifestEntry = entries.find(e => e.entryName === 'manifest.json')
    if (manifestEntry) {
      const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
      for (const deleted of (manifest.deleted || []) as string[]) {
        const target = path.join(installRoot, deleted)
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true })
        }
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory || entry.entryName === 'manifest.json') continue
      const target = path.join(installRoot, entry.entryName)
      const dir = path.dirname(target)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(target, entry.getData())
    }
  }

  cancelDownload(): void {
    this.downloadAbort?.abort()
    this.downloadAbort = null
  }
}
