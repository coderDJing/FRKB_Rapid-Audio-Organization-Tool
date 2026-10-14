import type { SqliteDatabase } from '../libraryDb'
import { performance } from 'node:perf_hooks'
import { collectSqliteReadContext, type SqliteReadContext } from './sqliteReadDiagnostics'
import {
  projectSongSearchRow,
  type ProjectedSongSearchRow,
  type SongSearchPageSourceRow
} from './songSearchProjection'

// 临时诊断：区分 SQL 读取与 JSON/分析字段投影，确认根因并复测后删除。
export type SongSearchPageTimings = {
  sqlMs: number
  projectionMs: number
  rowCount: number
  jsonChars: number
  maxJsonChars: number
  prepareMs: number
  firstRowMs: number
  remainingRowsMs: number
  processCpuUserMs: number
  processCpuSystemMs: number
  context?: SqliteReadContext
}

const contextCollected = new WeakSet<SqliteDatabase>()

export const readSongSearchPage = (
  db: SqliteDatabase,
  afterRowId: number,
  limit: number,
  onTimings?: (timings: SongSearchPageTimings) => void
): ProjectedSongSearchRow[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 1))
  const safeAfter = Number.isFinite(afterRowId) ? Math.max(0, Math.floor(afterRowId)) : 0
  const startedAt = performance.now()
  const startedCpu = onTimings ? process.cpuUsage() : undefined
  const sql = `SELECT rowid AS row_id, list_root, file_path, info_json
       FROM song_cache
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
  const statement = db.prepare<SongSearchPageSourceRow>(sql)
  const preparedAt = performance.now()
  let firstRowMs = 0
  let remainingRowsMs = 0
  let rows: SongSearchPageSourceRow[]
  if (onTimings) {
    // 诊断路径仍完整读取同一个 SELECT，不额外重读冷页。
    const iterator = statement.iterate(safeAfter, safeLimit)
    rows = []
    try {
      const first = iterator.next()
      const firstRowAt = performance.now()
      firstRowMs = firstRowAt - preparedAt
      if (!first.done) rows.push(first.value)
      for (const row of iterator) rows.push(row)
      remainingRowsMs = performance.now() - firstRowAt
    } finally {
      iterator.return?.()
    }
  } else {
    rows = statement.all(safeAfter, safeLimit)
  }
  const sqlFinishedAt = performance.now()
  const sqlCpu = startedCpu ? process.cpuUsage(startedCpu) : undefined
  const projected = rows.map((row) => projectSongSearchRow(row))
  const projectionFinishedAt = performance.now()
  if (onTimings) {
    let jsonChars = 0
    let maxJsonChars = 0
    for (const row of rows) {
      const chars = row.info_json?.length || 0
      jsonChars += chars
      maxJsonChars = Math.max(maxJsonChars, chars)
    }
    onTimings({
      sqlMs: sqlFinishedAt - startedAt,
      projectionMs: projectionFinishedAt - sqlFinishedAt,
      rowCount: rows.length,
      jsonChars,
      maxJsonChars,
      prepareMs: Math.round(preparedAt - startedAt),
      firstRowMs: Math.round(firstRowMs),
      remainingRowsMs: Math.round(remainingRowsMs),
      // CPU 为进程级差值，不能单独证明该 worker 的 CPU 或锁等待。
      processCpuUserMs: Math.round((sqlCpu?.user || 0) / 1000),
      processCpuSystemMs: Math.round((sqlCpu?.system || 0) / 1000),
      context:
        sqlFinishedAt - startedAt >= 500 && !contextCollected.has(db)
          ? (() => {
              contextCollected.add(db)
              return collectSqliteReadContext(db, sql, [safeAfter, safeLimit])
            })()
          : undefined
    })
  }
  return projected
}
