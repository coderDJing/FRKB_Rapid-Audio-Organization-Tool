import { getLibraryDb, isSqliteRow } from './libraryDb'
import { log } from './log'

export type RecycleBinRecord = {
  filePath: string
  deletedAtMs: number
  originalPlaylistPath?: string | null
  originalFileName?: string | null
  sourceType?: string | null
  fileId?: string | null
  contentSha256?: string | null
  contentSize?: number | null
}

const TABLE = 'recycle_bin_records'

const SELECT_COLUMNS = `file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type, file_id, content_sha256, content_size`

function normalizeRecord(row: unknown): RecycleBinRecord | null {
  if (!isSqliteRow(row) || !row.file_path) return null
  const deletedAtMs = Number(row.deleted_at_ms)
  if (!Number.isFinite(deletedAtMs)) return null
  const contentSize = Number(row.content_size)
  return {
    filePath: String(row.file_path),
    deletedAtMs,
    originalPlaylistPath: row.original_playlist_path ? String(row.original_playlist_path) : null,
    originalFileName: row.original_file_name ? String(row.original_file_name) : null,
    sourceType: row.source_type ? String(row.source_type) : null,
    fileId: row.file_id ? String(row.file_id) : null,
    contentSha256: row.content_sha256 ? String(row.content_sha256) : null,
    contentSize: Number.isFinite(contentSize) && contentSize > 0 ? contentSize : null
  }
}

export function listRecycleBinRecords(): RecycleBinRecord[] {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TABLE}`).all()
    return (rows || []).map((row) => normalizeRecord(row)).filter(Boolean) as RecycleBinRecord[]
  } catch (error) {
    log.error('[sqlite] recycle bin list failed', error)
    return []
  }
}

export function getRecycleBinRecord(filePath: string): RecycleBinRecord | null {
  const db = getLibraryDb()
  if (!db || !filePath) return null
  try {
    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE file_path = ? LIMIT 1`)
      .get(filePath)
    return normalizeRecord(row)
  } catch (error) {
    log.error('[sqlite] recycle bin get failed', error)
    return null
  }
}

export function getRecycleBinRecordByFileId(fileId: string): RecycleBinRecord | null {
  const db = getLibraryDb()
  const normalized = String(fileId || '').trim()
  if (!db || !normalized) return null
  try {
    const row = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE file_id = ? ORDER BY deleted_at_ms DESC LIMIT 1`
      )
      .get(normalized)
    return normalizeRecord(row)
  } catch (error) {
    log.error('[sqlite] recycle bin get by fileId failed', error)
    return null
  }
}

export function upsertRecycleBinRecord(record: RecycleBinRecord): boolean {
  const db = getLibraryDb()
  if (!db || !record?.filePath) return false
  try {
    const existing = db
      .prepare(`SELECT deleted_at_ms FROM ${TABLE} WHERE file_path = ?`)
      .get(record.filePath)
    const existingMs =
      existing && Number.isFinite(Number(existing.deleted_at_ms))
        ? Number(existing.deleted_at_ms)
        : null
    if (existingMs !== null && existingMs > record.deletedAtMs) {
      return false
    }
    db.prepare(
      `INSERT INTO ${TABLE} (
         file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type,
         file_id, content_sha256, content_size
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         deleted_at_ms = excluded.deleted_at_ms,
         original_playlist_path = excluded.original_playlist_path,
         original_file_name = excluded.original_file_name,
         source_type = excluded.source_type,
         file_id = COALESCE(excluded.file_id, ${TABLE}.file_id),
         content_sha256 = COALESCE(excluded.content_sha256, ${TABLE}.content_sha256),
         content_size = COALESCE(excluded.content_size, ${TABLE}.content_size)`
    ).run(
      record.filePath,
      record.deletedAtMs,
      record.originalPlaylistPath ?? null,
      record.originalFileName ?? null,
      record.sourceType ?? null,
      record.fileId ?? null,
      record.contentSha256 ?? null,
      record.contentSize ?? null
    )
    return true
  } catch (error) {
    log.error('[sqlite] recycle bin upsert failed', error)
    return false
  }
}

export function deleteRecycleBinRecord(filePath: string): boolean {
  const db = getLibraryDb()
  if (!db || !filePath) return false
  try {
    db.prepare(`DELETE FROM ${TABLE} WHERE file_path = ?`).run(filePath)
    return true
  } catch (error) {
    log.error('[sqlite] recycle bin delete failed', error)
    return false
  }
}

export function deleteRecycleBinRecords(filePaths: string[]): number {
  const db = getLibraryDb()
  if (!db || !Array.isArray(filePaths) || filePaths.length === 0) return 0
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE file_path = ?`)
    const run = db.transaction((items: string[]) => {
      for (const fp of items) {
        del.run(fp)
      }
    })
    run(filePaths)
    return filePaths.length
  } catch (error) {
    log.error('[sqlite] recycle bin bulk delete failed', error)
    return 0
  }
}
