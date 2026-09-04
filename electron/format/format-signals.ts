import fs from 'fs'
import path from 'path'
import { extractXlsxSkeleton } from './xlsx-extractor'
import type { SkeletonStore } from './skeleton-store'

/**
 * P2 第 6C 步：采纳信号自动采集（设计 §7 信号③）。
 *
 * 定义：同一 intentId 的任务**又生成了** xlsx 且与既有族头相似度 ≥0.7 → useCount++，
 * 累计 2 次自动升格 instance → candidate。聚合 / 计数 / 升格 / 去重全部由
 * `SkeletonStore.addInstance()` 负责 —— 本模块只负责「发现新产出文件」：
 *
 *   发任务前  snapshotOutputDir()   记录 output 下 xlsx 的 {mtime, size}
 *   任务完成后 harvestNewXlsx()     diff 出新增/变更文件 → 抽骨架 → addInstance
 *
 * 本文件**不 import electron**（可在 node 直接单测）。落盘失败、目录不存在、
 * 抽取失败一律静默跳过 —— 信号采集是后台增强，绝不能把主流程拖挂。
 */

export interface OutputSnapshot {
  /** filePath → mtimeMs + size，用于 diff 出「这次任务新产出」的文件 */
  files: Map<string, { mtimeMs: number; size: number }>
}

/** 采集上下文：来自 prepare() 的业务意图（没有匹配意图就采集不了，直接跳过） */
export interface HarvestContext {
  intentId?: string
  intentLabel?: string
  workflow?: string
}

export interface HarvestOutcome {
  action: string
  filePath: string
  /** addInstance 返回的族头 id；rejected 时为空 */
  familyId?: string
  similarity?: number
  /** promotedTo：本次是否触发生命周期升格 */
  promotedTo?: string
  reason?: string
}

export interface HarvestReport {
  /** 实际进入 addInstance 的文件数（含 rejected） */
  harvested: number
  outcomes: HarvestOutcome[]
  capacityWarning?: unknown
}

function listXlsx(dir: string): Map<string, { mtimeMs: number; size: number }> {
  const out = new Map<string, { mtimeMs: number; size: number }>()
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('~$')) continue // Excel 锁文件
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.xlsx$/i.test(e.name)) {
        try {
          const st = fs.statSync(p)
          out.set(p, { mtimeMs: st.mtimeMs, size: st.size })
        } catch {
          /* 文件正在被写/已删除：跳过 */
        }
      }
    }
  }
  walk(dir)
  return out
}

/** 发任务前调用：记录 output 目录里现有 xlsx 的指纹 */
export function snapshotOutputDir(dir: string): OutputSnapshot {
  if (!dir || !fs.existsSync(dir)) return { files: new Map() }
  return { files: listXlsx(dir) }
}

/**
 * 任务完成后调用：diff 快照，把新增/更新的 xlsx 抽骨架交给 store 聚合。
 *
 * - 旧文件且未变更 → 不碰（不能把历史产物重复计成「本次产出」）
 * - 抽取失败 → 记 outcome(reason)，不抛
 * - store 落库异常 → 捕获记 reason，不抛
 */
export async function harvestNewXlsx(
  store: SkeletonStore,
  dir: string,
  snapshot: OutputSnapshot,
  ctx: HarvestContext,
  opts?: { now?: () => number }
): Promise<HarvestReport> {
  const report: HarvestReport = { harvested: 0, outcomes: [] }
  // 没有业务意图绑定就没有 intentId 可挂 —— 跨意图硬约束下，宁可不采集也不能挂错意图
  if (!ctx.intentId) return report
  if (!dir || !fs.existsSync(dir)) return report

  const current = listXlsx(dir)
  const fresh: string[] = []
  for (const [p, cur] of current) {
    const before = snapshot.files.get(p)
    if (!before || before.mtimeMs !== cur.mtimeMs || before.size !== cur.size) fresh.push(p)
  }

  for (const filePath of fresh) {
    // 已处理过的文件回写进快照：后续延迟补扫（文件晚于 onDone 落盘的场景）不会重复计数
    const cur = current.get(filePath)
    if (cur) snapshot.files.set(filePath, cur)
    report.harvested += 1
    let skeleton: Awaited<ReturnType<typeof extractXlsxSkeleton>>['skeleton']
    try {
      const r = await extractXlsxSkeleton(filePath)
      if (!r.ok || !r.skeleton) {
        report.outcomes.push({ action: 'skip-extract', filePath, reason: r.reason || '骨架抽取不通过' })
        continue
      }
      skeleton = r.skeleton
    } catch (err: any) {
      report.outcomes.push({ action: 'skip-extract', filePath, reason: err?.message || String(err) })
      continue
    }

    try {
      const res = await store.addInstance({
        skeleton,
        intentId: ctx.intentId,
        intentLabel: ctx.intentLabel,
        workflow: ctx.workflow,
        name: path.basename(filePath).replace(/\.xlsx$/i, ''),
        filePath,
        fileName: path.basename(filePath)
      })
      report.outcomes.push({
        action: res.action,
        filePath,
        familyId: res.familyId,
        similarity: res.similarity,
        promotedTo: res.promotedTo,
        reason: res.reason
      })
      if (res.capacityWarning) report.capacityWarning = res.capacityWarning
    } catch (err: any) {
      report.outcomes.push({ action: 'error', filePath, reason: err?.message || String(err) })
    }
  }
  return report
}
