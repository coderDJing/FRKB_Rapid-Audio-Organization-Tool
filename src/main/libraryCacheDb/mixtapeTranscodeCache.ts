import { getLibraryDb } from '../libraryDb'
import { log } from '../log'

const TABLE = 'mixtape_transcode_cache'

export type TranscodeCacheEntry = {
  filePath: string
  size: number
  mtimeMs: number
  cacheFilename: string
  transcodeStatus: 'pending' | 'processing' | 'done' | 'failed'
  createdAtMs: number
}

/**
 * 批量查询转码缓存状态
 * @returns filePath → TranscodeCacheEntry 映射（仅返回 status = 'done' 的记录）
 */
export function loadTranscodeCacheBatch(filePaths: string[]): Map<string, TranscodeCacheEntry> {
  const result = new Map<string, TranscodeCacheEntry>()
  if (!filePaths.length) return result
  const db = getLibraryDb()
  if (!db) return result
  try {
    const placeholders = filePaths.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT file_path, size, mtime_ms, cache_filename, transcode_status, created_at_ms FROM ${TABLE} WHERE file_path IN (${placeholders}) AND transcode_status = 'done'`
      )
      .all(...filePaths)
    for (const row of rows) {
      result.set(row.file_path, {
        filePath: row.file_path,
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms),
        cacheFilename: row.cache_filename,
        transcodeStatus: row.transcode_status,
        createdAtMs: Number(row.created_at_ms)
      })
    }
  } catch (error) {
    log.error('[sqlite] 混音转码缓存批量查询失败', error)
  }
  return result
}

/**
 * 查询单个文件的转码缓存
 */
export function loadTranscodeCacheEntry(filePath: string): TranscodeCacheEntry | null {
  if (!filePath) return null
  const db = getLibraryDb()
  if (!db) return null
  try {
    const row = db
      .prepare(
        `SELECT file_path, size, mtime_ms, cache_filename, transcode_status, created_at_ms FROM ${TABLE} WHERE file_path = ?`
      )
      .get(filePath)
    if (!row) return null
    return {
      filePath: row.file_path,
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      cacheFilename: row.cache_filename,
      transcodeStatus: row.transcode_status,
      createdAtMs: Number(row.created_at_ms)
    }
  } catch (error) {
    log.error('[sqlite] 混音转码缓存查询失败', error)
    return null
  }
}

/**
 * 插入或更新转码缓存记录
 */
export function upsertTranscodeCacheEntry(
  filePath: string,
  stat: { size: number; mtimeMs: number },
  cacheFilename: string,
  status: TranscodeCacheEntry['transcodeStatus']
): boolean {
  if (!filePath || !cacheFilename) return false
  const db = getLibraryDb()
  if (!db) return false
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (file_path, size, mtime_ms, cache_filename, transcode_status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         cache_filename = excluded.cache_filename,
         transcode_status = excluded.transcode_status,
         created_at_ms = excluded.created_at_ms`
    ).run(filePath, stat.size, stat.mtimeMs, cacheFilename, status, Date.now())
    return true
  } catch (error) {
    log.error('[sqlite] 混音转码缓存写入失败', error)
    return false
  }
}

/**
 * 更新转码状态
 */
export function updateTranscodeCacheStatus(
  filePath: string,
  status: TranscodeCacheEntry['transcodeStatus']
): boolean {
  if (!filePath) return false
  const db = getLibraryDb()
  if (!db) return false
  try {
    db.prepare(`UPDATE ${TABLE} SET transcode_status = ? WHERE file_path = ?`).run(status, filePath)
    return true
  } catch (error) {
    log.error('[sqlite] 混音转码缓存状态更新失败', error)
    return false
  }
}

/**
 * 批量删除转码缓存记录
 */
export function removeTranscodeCacheEntries(filePaths: string[]): number {
  if (!filePaths.length) return 0
  const db = getLibraryDb()
  if (!db) return 0
  try {
    const placeholders = filePaths.map(() => '?').join(',')
    const info = db
      .prepare(`DELETE FROM ${TABLE} WHERE file_path IN (${placeholders})`)
      .run(...filePaths)
    return Number(info?.changes || 0)
  } catch (error) {
    log.error('[sqlite] 混音转码缓存删除失败', error)
    return 0
  }
}

/**
 * 列出所有已完成的转码缓存文件名（用于定期清理）
 */
export function listAllTranscodeCacheFilenames(): string[] {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db.prepare(`SELECT cache_filename FROM ${TABLE}`).all()
    return rows.map((row: { cache_filename: string }) => row.cache_filename)
  } catch (error) {
    log.error('[sqlite] 混音转码缓存文件名列表查询失败', error)
    return []
  }
}

/**
 * 列出所有需要转码的文件路径（status = 'pending' 或 'failed'）
 */
export function listPendingTranscodeFilePaths(): string[] {
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(`SELECT file_path FROM ${TABLE} WHERE transcode_status IN ('pending', 'failed')`)
      .all()
    return rows.map((row: { file_path: string }) => row.file_path)
  } catch (error) {
    log.error('[sqlite] 混音待转码文件查询失败', error)
    return []
  }
}
