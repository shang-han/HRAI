/**
 * 格式模板库单例（P2 第 5 步 IPC 挂载用）
 *
 * 召回（intent-router）与 IPC（format:*）必须共用同一份内存态，
 * 否则路由注入和「我的格式」Tab 会各写各的、相互看不到。
 * 本模块用一个进程内单例保证这点。
 *
 * 注意：本文件 import electron（取 userData 目录），因此**不能**在 node 测试里直接 import；
 * 测试请直接 `new SkeletonStore({ dataDir })`，handler 逻辑在 format-handlers.ts（不依赖 electron）。
 */

import path from 'path'
import { app } from 'electron'
import { SkeletonStore } from './skeleton-store'

let _store: SkeletonStore | null = null
let _initPromise: Promise<SkeletonStore> | null = null

/** 格式模板库默认落盘目录：与 template.json / company_profile.json 同级（data/） */
export function formatStoreDataDir(): string {
  return path.join(app.getPath('userData'), 'data')
}

/** 进程内单例：首次调用异步 init，之后返回同一实例 */
export function getFormatStore(dataDir: string = formatStoreDataDir()): Promise<SkeletonStore> {
  if (_store) return Promise.resolve(_store)
  if (!_initPromise) {
    const s = new SkeletonStore({ dataDir })
    _initPromise = s.init().then(() => {
      _store = s
      return s
    })
  }
  return _initPromise
}
