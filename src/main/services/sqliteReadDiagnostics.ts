import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { SqliteDatabase } from '../libraryDb'

/** 临时只读诊断：慢查询才收集，不做 checkpoint、VACUUM 或修改连接参数。 */
export const isSqliteReadDiagnosticsEnabled = () =>
  process.env.FRKB_APP_PACKAGED === '0' ||
  (process.env.FRKB_APP_PACKAGED === '1' && /-rc(?:\.|$)/i.test(process.env.FRKB_APP_VERSION || ''))

export type SqliteReadContext = {
  queryPlan: string[]
  journalMode: unknown
  busyTimeoutMs: unknown
  pageSize: unknown
  pageCount: unknown
  freePageCount: unknown
  cacheSize: unknown
  mmapSize: unknown
  databaseBytes: number | null
  walBytes: number | null
  contextCollectionMs: number
  diagnosticError?: string
}

const fileSize = (file: string): number | null => {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

export const collectSqliteReadContext = (
  db: SqliteDatabase,
  sql: string,
  params: Array<string | number>
): SqliteReadContext => {
  const startedAt = performance.now()
  const context: SqliteReadContext = {
    queryPlan: [],
    journalMode: null,
    busyTimeoutMs: null,
    pageSize: null,
    pageCount: null,
    freePageCount: null,
    cacheSize: null,
    mmapSize: null,
    databaseBytes: null,
    walBytes: null,
    contextCollectionMs: 0
  }
  try {
    context.queryPlan = db
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
    context.journalMode = db.pragma('journal_mode', { simple: true })
    context.busyTimeoutMs = db.pragma('busy_timeout', { simple: true })
    context.pageSize = db.pragma('page_size', { simple: true })
    context.pageCount = db.pragma('page_count', { simple: true })
    context.freePageCount = db.pragma('freelist_count', { simple: true })
    context.cacheSize = db.pragma('cache_size', { simple: true })
    context.mmapSize = db.pragma('mmap_size', { simple: true })
    if (!db.memory) {
      context.databaseBytes = fileSize(db.name)
      context.walBytes = fileSize(`${db.name}-wal`)
    }
  } catch (error) {
    // 诊断失败不应丢弃已经读到的缓存；返回原因而非隐藏失败。
    context.diagnosticError = error instanceof Error ? error.message : String(error)
  }
  context.contextCollectionMs = Math.round(performance.now() - startedAt)
  return context
}
