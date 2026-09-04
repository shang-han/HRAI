/**
 * 格式模板库 IPC 处理器（P2 第 5 步）
 *
 * 对应设计文档 outputs/P2-结构复用详细设计.md 的 §8.1（format:* 命名空间）。
 * 所有处理器都委托给第 2 步的 SkeletonStore + 第 1 步的 xlsx-extractor，本文件不持有状态。
 *
 * 本文件**不 import electron**，因此可以在 node 里直接跑测试（验证见 tests/run-format-ipc-tests.mjs）。
 * electron 侧的注册（ipcMain.handle）在 format-ipc.ts 里做薄薄一层转发。
 *
 * 设计硬约束（改动时不要破坏）：
 *   - 跨意图不套用：召回侧已保证（recall.ts 跨意图 score=0）。本层只负责存取，不引入跨意图逻辑。
 *   - 删除=归档：format:delete 走 store.archive()，不是物理删除（模板是用户确认过的资产）。
 *   - 导入绝不静默覆盖：importAll 默认 resolution='rename'，冲突自动并存改名。
 */

import fs from 'fs'
import path from 'path'
import { SkeletonStore } from './skeleton-store'
import type { SaveAsTemplateInput, FormatTemplatePatch } from './skeleton-store'
import { extractXlsxSkeleton } from './xlsx-extractor'

export interface FormatHandlerOptions {
  /** 返回 workspace/output 目录，供 format:candidates 扫描候选 xlsx */
  getWorkspaceOutputDir?: () => string
}

export type FormatHandler = (...args: any[]) => Promise<any>

export interface FormatHandlers {
  [channel: string]: FormatHandler
}

/**
 * 构建全部 format:* 处理器。返回 { channel: handler }，由 format-ipc.ts 注册到 ipcMain。
 * handler 的参数顺序与 preload 里的 invoke 调用一一对应（event 由 ipc-ipc 层剥离）。
 */
export function createFormatHandlers(store: SkeletonStore, opts: FormatHandlerOptions = {}): FormatHandlers {
  const getOutputDir = opts.getWorkspaceOutputDir
  return {
    // 摘要列表（默认排除 archived；includeArchived 可拿全量）
    'format:list': async (arg?: { includeArchived?: boolean }) =>
      store.list({ includeArchived: arg?.includeArchived }),

    'format:get': async (id: string) => store.get(id),

    // 字段序列预览（给 UI 渲染），直接返回模板本体
    'format:preview': async (id: string) => store.get(id),

    // 扫描 workspace/output 下的 xlsx 候选，抽骨架但不落盘（供「存为我的格式」前预览）
    'format:candidates': async (arg?: { dir?: string }) => {
      const dir = arg?.dir || getOutputDir?.()
      if (!dir || !fs.existsSync(dir)) return []
      const files: string[] = []
      const walk = (d: string) => {
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(d, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('~$')) continue // 排除 Excel 临时锁文件
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (/\.xlsx$/i.test(e.name)) files.push(p)
        }
      }
      walk(dir)
      const out: Array<{ filePath: string; fileName: string; skeleton: unknown }> = []
      for (const f of files) {
        const r = await extractXlsxSkeleton(f)
        if (r.ok && r.skeleton) out.push({ filePath: f, fileName: path.basename(f), skeleton: r.skeleton })
      }
      return out
    },

    // 抽单个 xlsx 骨架（不落盘），返回 { ok, reason?, skeleton? }
    'format:extract': async (arg: { filePath: string }) => extractXlsxSkeleton(arg.filePath),

    // 保存为模板（可指定 lifecycle；默认 active —— 手动保存是唯一能直接到 active 的路径）。
    // P0-1 修复：前端采纳时不传 intentId，若直接落库则 getByIntentSync 永远召回不到（死资产）。
    // 修法是「证据链继承」：按产出文件路径反查采集器落库的 instance，继承其意图信息。
    // 采集器（6C）落库的 instance 与手动采纳的 candidate 同名同意图且结构一致时，
    // saveAsTemplate 的 mergeSameName 分支会就地刷新同一条 —— 不产生重复格式族。
    'format:save': async (input: SaveAsTemplateInput) => {
      if (input && !input.intentId && input.filePath) {
        const inherited = store.findIntentByEvidence(input.filePath)
        if (inherited) {
          input = {
            ...input,
            intentId: inherited.intentId,
            intentLabel: input.intentLabel || inherited.intentLabel,
            workflow: input.workflow || inherited.workflow
          }
        }
      }
      return store.saveAsTemplate(input)
    },

    // 改名 / 改口径 / 改 lifecycle
    'format:update': async (id: string, patch: FormatTemplatePatch) => store.update(id, patch),

    // 删除 = 归档（模板是用户确认过的资产，不物理删除）
    'format:delete': async (id: string) => store.archive(id),

    // 记录「本次不套用」（rejectCount++）
    'format:reject': async (id: string) => store.recordReject(id),

    // P1-2 隐式接受：套用后用户没点拒绝、继续发下一条消息 = 接受（§7 信号④）。
    // acceptCount++，满足 canPromoteToActive 条件时 candidate 自动升 active。
    'format:accept': async (id: string) => store.recordAccept(id),

    // 导出全部为 json 文件（换机器 / 备份）
    'format:exportAll': async (arg: { filePath: string }) => {
      const bundle = await store.exportAll()
      fs.writeFileSync(arg.filePath, JSON.stringify(bundle, null, 2), 'utf-8')
      return { success: true, count: bundle.templates.length }
    },

    // 导入全部（冲突自动并存改名，绝不静默覆盖）
    'format:importAll': async (arg: { filePath: string }) => {
      let bundle: unknown
      try {
        const raw = fs.readFileSync(arg.filePath, 'utf-8')
        bundle = JSON.parse(raw)
      } catch (err: any) {
        // 通道契约：导入任何包都不抛异常。畸形 JSON 也走结构化错误返回（E3 攻击测试）
        return { imported: 0, skipped: 0, renamed: [], overwritten: [], conflicts: [], unresolved: [], errors: [`文件不是合法 JSON：${err?.message || err}`] }
      }
      // 冲突裁决用 defaultResolution（字段名是 defaultResolution，不是 resolution ——
      // 传错会被静默忽略，导致冲突条目只进 conflicts 而不落地，导入看起来"什么都没发生"）
      return store.importAll(bundle, { defaultResolution: 'rename' })
    }
  }
}
