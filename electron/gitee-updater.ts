import fs from 'fs'
import path from 'path'
import { app, shell } from 'electron'

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
}

interface DownloadState {
  total: number
  downloaded: number
  percent: number
  filePath: string
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
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
        publishedAt: ''
      }
    }
    if (!resp.ok) {
      throw new Error(`检查更新失败：HTTP ${resp.status}`)
    }

    const release: any = await resp.json()
    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '')
    const currentVersion = app.getVersion()
    const assets: any[] = Array.isArray(release.assets) ? release.assets : []
    const exeAsset = assets.find((a: any) => /\.exe$/i.test(a.name || '')) || assets[0]
    const downloadUrl = String(exeAsset?.browser_download_url || release.assets_url || '')

    return {
      hasUpdate: !!latestVersion && compareVersions(latestVersion, currentVersion) > 0,
      latestVersion,
      currentVersion,
      releaseNotes: String(release.body || release.notes || ''),
      downloadUrl,
      fileName: String(exeAsset?.name || `Hermes-Setup-${latestVersion}.exe`),
      size: Number(exeAsset?.size || 0),
      publishedAt: String(release.created_at || '')
    }
  }

  async downloadLatest(): Promise<string> {
    const info = await this.checkForUpdates()
    if (!info.hasUpdate || !info.downloadUrl) {
      throw new Error(info.latestVersion ? '当前已经是最新版本' : '没有可用的更新包')
    }

    this.downloadAbort?.abort()
    this.downloadAbort = new AbortController()

    const updateDir = path.join(app.getPath('userData'), 'updates')
    if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true })
    const filePath = path.join(updateDir, info.fileName)

    const resp = await fetch(info.downloadUrl, { signal: this.downloadAbort.signal })
    if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`)

    const total = Number(resp.headers.get('content-length') || info.size || 0)
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let downloaded = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      downloaded += value.length
      this.onProgress?.({
        total,
        downloaded,
        percent: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0,
        filePath
      })
    }

    fs.writeFileSync(filePath, Buffer.concat(chunks))
    this.onProgress?.({ total, downloaded, percent: 100, filePath })
    return filePath
  }

  async install(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) throw new Error('安装包不存在，请重新下载')
    await shell.openPath(filePath)
  }

  cancelDownload(): void {
    this.downloadAbort?.abort()
    this.downloadAbort = null
  }
}
