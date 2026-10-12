import type { SqliteDatabase } from '../libraryDb'
import {
  projectSongSearchRow,
  type ProjectedSongSearchRow,
  type SongSearchPageSourceRow
} from './songSearchProjection'

export const readSongSearchPage = (
  db: SqliteDatabase,
  afterRowId: number,
  limit: number
): ProjectedSongSearchRow[] => {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 1))
  const safeAfter = Number.isFinite(afterRowId) ? Math.max(0, Math.floor(afterRowId)) : 0
  const rows = db
    .prepare<SongSearchPageSourceRow>(
      `SELECT rowid AS row_id, list_root, file_path, info_json
       FROM song_cache
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    )
    .all(safeAfter, safeLimit)
  return rows.map((row) => projectSongSearchRow(row))
}
