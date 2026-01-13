import { getLibraryDb } from './libraryDb'
import { log } from './log'

export type RecycleBinRecord = {
  filePath: string
  deletedAtMs: number
  originalPlaylistPath?: string | null
  originalFileName?: string | null
  sourceType?: string | null
}

const TABLE = 'recycle_bin_records'

function normalizeRecord(row: any): RecycleBinRecord | null {
  if (!row || !row.file_path) return null
  const deletedAtMs = Number(row.deleted_at_ms)
  if (!Number.isFinite(deletedAtMs)) return null
  return {
    filePath: String(row.file_path),
    deletedAtMs,
    originalPlaylistPath: row.original_playlist_path ? String(row.original_playlist_path) : null,
    originalFileName: row.original_file_name ? String(row.original_file_name) : null,
    sourceType: row.source_type ? String(row.source_type) : null
  }
}

export function listRecycleBinRecords(): RecycleBinRecord[] {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type FROM ${TABLE}`
      )
      .all()
    return (rows || [])
      .map((row: any) => normalizeRecord(row))
      .filter(Boolean) as RecycleBinRecord[]
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
      .prepare(
        `SELECT file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type FROM ${TABLE} WHERE file_path = ? LIMIT 1`
      )
      .get(filePath)
    return normalizeRecord(row)
  } catch (error) {
    log.error('[sqlite] recycle bin get failed', error)
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
      `INSERT INTO ${TABLE} (file_path, deleted_at_ms, original_playlist_path, original_file_name, source_type)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         deleted_at_ms = excluded.deleted_at_ms,
         original_playlist_path = excluded.original_playlist_path,
         original_file_name = excluded.original_file_name,
         source_type = excluded.source_type`
    ).run(
      record.filePath,
      record.deletedAtMs,
      record.originalPlaylistPath ?? null,
      record.originalFileName ?? null,
      record.sourceType ?? null
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

export default {
  listRecycleBinRecords,
  getRecycleBinRecord,
  upsertRecycleBinRecord,
  deleteRecycleBinRecord,
  deleteRecycleBinRecords
}
