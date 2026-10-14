import type { SqliteDatabase } from '../libraryDb'
import { performance } from 'node:perf_hooks'
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
}

export const readSongSearchPage = (
  db: SqliteDatabase,
  afterRowId: number,
  limit: number,
  onTimings?: (timings: SongSearchPageTimings) => void
): ProjectedSongSearchRow[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 1))
  const safeAfter = Number.isFinite(afterRowId) ? Math.max(0, Math.floor(afterRowId)) : 0
  const startedAt = performance.now()
  const rows = db
    .prepare<SongSearchPageSourceRow>(
      `SELECT rowid AS row_id, list_root, file_path, info_json
       FROM song_cache
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    )
    .all(safeAfter, safeLimit)
  const sqlFinishedAt = performance.now()
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
      maxJsonChars
    })
  }
  return projected
}
