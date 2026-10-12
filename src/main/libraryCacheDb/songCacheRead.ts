import type { SqliteDatabase } from '../libraryDb'

export type SongCacheDbRow = {
  file_path: string
  size: unknown
  mtime_ms: unknown
  info_json: unknown
}

export type SongCacheTrackFieldRow = {
  file_path: string
  track_number: unknown
  added_at_ms: unknown
}

// 与写连接分离的实时读取；每批使用同一个事务快照，不能读 playlist_view_snapshot。
export const readSongCacheRows = (db: SqliteDatabase, roots: string[]): SongCacheDbRow[][] => {
  const select = db.prepare<SongCacheDbRow>(
    'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
  )
  return db.transaction(() => roots.map((root) => select.all(root)))()
}

export const readSongCacheTrackFieldRows = (
  db: SqliteDatabase,
  roots: string[]
): SongCacheTrackFieldRow[][] => {
  const select = db.prepare<SongCacheTrackFieldRow>(
    `SELECT file_path,
            CASE WHEN json_valid(info_json) THEN json_extract(info_json, '$.playlistTrackNumber') END AS track_number,
            CASE WHEN json_valid(info_json) THEN json_extract(info_json, '$.addedAtMs') END AS added_at_ms
     FROM song_cache
     WHERE list_root = ?`
  )
  return db.transaction(() => roots.map((root) => select.all(root)))()
}
