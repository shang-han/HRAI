import crypto from 'crypto'
import https from 'https'
import http from 'http'
import si from 'systeminformation'
import { StorageManager } from './storage-manager'

const ACTIVATION_SERVER = 'http://49.233.171.82:9000'
const OFFLINE_GRACE_DAYS = 7

interface LicenseData {
  activationToken: string
  deviceFpHash: string
  deviceName: string
  activatedAt: string
  lastValidatedAt: string
}

interface ActivateResponse {
  success: boolean
  activation_token?: string
  detail?: string
}

interface ValidateResponse {
  valid: boolean
  reason?: string
}

export class ActivationManager {
  private storageManager: StorageManager

  constructor(storageManager: StorageManager) {
    this.storageManager = storageManager
  }

  async activate(code: string): Promise<{ success: boolean; message: string }> {
    try {
      const deviceFpHash = await this.getDeviceFingerprint()
      const deviceName = await this.getDeviceName()

      const response = await this.httpPost<ActivateResponse>('/activate', {
        code: code.trim().toUpperCase(),
        device_fp_hash: deviceFpHash,
        device_name: deviceName
      })

      if (response.success && response.activation_token) {
        const licenseData: LicenseData = {
          activationToken: response.activation_token,
          deviceFpHash,
          deviceName,
          activatedAt: new Date().toISOString(),
          lastValidatedAt: new Date().toISOString()
        }
        this.storageManager.saveLicense(licenseData)
        return { success: true, message: '激活成功' }
      } else {
        return { success: false, message: response.detail || '激活失败' }
      }
    } catch (err: any) {
      return { success: false, message: `激活请求失败: ${err.message}` }
    }
  }

  async validate(): Promise<{ valid: boolean; message: string }> {
    const license = this.storageManager.getLicense() as LicenseData | null

    if (!license) {
      return { valid: false, message: '未激活' }
    }

    try {
      const deviceFpHash = await this.getDeviceFingerprint()

      const response = await this.httpPost<ValidateResponse>('/validate', {
        activation_token: license.activationToken,
        device_fp_hash: deviceFpHash
      })

      if (response.valid) {
        // 更新最后验证时间
        license.lastValidatedAt = new Date().toISOString()
        this.storageManager.saveLicense(license)
        return { valid: true, message: '授权有效' }
      } else {
        return { valid: false, message: response.reason || '授权无效' }
      }
    } catch (err: any) {
      // 网络错误 — 检查离线宽限期
      const lastValidated = new Date(license.lastValidatedAt)
      const daysSinceValidation = (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24)

      if (daysSinceValidation <= OFFLINE_GRACE_DAYS) {
        return { valid: true, message: `离线模式（剩余 ${Math.ceil(OFFLINE_GRACE_DAYS - daysSinceValidation)} 天）` }
      }

      return { valid: false, message: '授权验证失败且已超过离线宽限期' }
    }
  }

  async getStatus(): Promise<{ activated: boolean; message: string; license?: any }> {
    const license = this.storageManager.getLicense() as LicenseData | null

    if (!license) {
      return { activated: false, message: '未激活' }
    }

    const validation = await this.validate()
    return {
      activated: validation.valid,
      message: validation.message,
      license: {
        deviceName: license.deviceName,
        activatedAt: license.activatedAt,
        lastValidatedAt: license.lastValidatedAt
      }
    }
  }

  async getDeviceFingerprint(): Promise<string> {
    try {
      const [cpu, mem, disk, network] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.diskLayout(),
        si.networkInterfaces()
      ])

      const raw = [
        cpu.manufacturer,
        cpu.brand,
        cpu.cores,
        mem.total,
        disk[0]?.serialNum || '',
        disk[0]?.name || '',
        (network[0] as any)?.mac || ''
      ].join('|')

      return crypto.createHash('sha256').update(raw).digest('hex')
    } catch {
      // 降级方案：使用随机但持久的标识
      const license = this.storageManager.getLicense() as LicenseData | null
      return license?.deviceFpHash || crypto.createHash('sha256').update('fallback-device').digest('hex')
    }
  }

  private async getDeviceName(): Promise<string> {
    try {
      const os = await si.osInfo()
      return os.hostname || 'Unknown Device'
    } catch {
      return 'Unknown Device'
    }
  }

  private httpPost<T>(urlPath: string, body: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, ACTIVATION_SERVER)
      const data = JSON.stringify(body)

      const client = url.protocol === 'https:' ? https : http
      const req = client.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 10000
      }, (res) => {
        let responseBody = ''
        res.on('data', chunk => responseBody += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody) as T)
          } catch {
            reject(new Error(`响应解析失败: ${responseBody}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('请求超时'))
      })

      req.write(data)
      req.end()
    })
  }
}
