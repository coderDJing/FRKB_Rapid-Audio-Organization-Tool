import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { ISongInfo } from '../../types/globals'
import type { SongCacheEntry } from './types'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath,
  normalizeInfoJsonFilePath
} from './pathResolvers'

const migratedSongRoots = new Set<string>()

export function migrateSongCacheRows(
  db: any,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare('SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?')
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const newFileKey = resolvedFile.key
        const absFilePath = resolveAbsoluteFilePath(newListRootKey, newFileKey)
        const infoJson = normalizeInfoJsonFilePath(row?.info_json, absFilePath)
        del.run(newListRootKey, newFileKey)
        const result = update.run(newListRootKey, newFileKey, infoJson, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
}

export async function ensureSongCacheMigrated(db: any, listRoot: string): Promise<void> {
  const resolved = resolveListRootInput(listRoot)
  if (!resolved) return
  const listRootKey = resolved.key
  const listRootAbs = resolved.abs
  if (!listRootKey || migratedSongRoots.has(listRootKey)) return
  migratedSongRoots.add(listRootKey)
  try {
    const countRow = db
      .prepare('SELECT COUNT(1) as count FROM song_cache WHERE list_root = ?')
      .get(listRootKey)
    if (countRow && Number(countRow.count) > 0) return
    if (!listRootAbs) return
    const cacheFile = path.join(listRootAbs, '.songs.cache.json')
    if (!(await fs.pathExists(cacheFile))) return
    const json = await fs.readJSON(cacheFile).catch(() => null)
    const entries = json && typeof json === 'object' ? (json.entries as any) : null
    if (!entries || typeof entries !== 'object') return
    const rows: Array<{ filePath: string; size: number; mtimeMs: number; infoJson: string }> = []
    for (const [filePath, entry] of Object.entries(entries)) {
      if (!filePath || typeof entry !== 'object' || entry === null) continue
      const size = toNumber((entry as any).size)
      const mtimeMs = toNumber((entry as any).mtimeMs)
      const info = (entry as any).info
      if (size === null || mtimeMs === null || !info) continue
      let infoJson = ''
      try {
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
        if (info && typeof info === 'object') {
          ;(info as ISongInfo).filePath = absFilePath
        }
        infoJson = JSON.stringify(info)
        rows.push({
          filePath: resolvedFile.key,
          size,
          mtimeMs,
          infoJson
        })
      } catch {
        continue
      }
    }
    if (!rows.length) return
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const run = db.transaction((items: typeof rows) => {
      for (const row of items) {
        insert.run(listRootKey, row.filePath, row.size, row.mtimeMs, row.infoJson)
      }
    })
    run(rows)
  } catch (error) {
    log.error('[sqlite] song cache migrate failed', error)
  }
}

export async function loadSongCache(listRoot: string): Promise<Map<string, SongCacheEntry> | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const rows = db
      .prepare('SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?')
      .all(listRootKey)
    const legacyRows = legacyListRoot
      ? db
          .prepare(
            'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?'
          )
          .all(legacyListRoot)
      : []
    const map = new Map<string, SongCacheEntry>()
    const appendRows = (rowsToUse: any[], rootKey: string, legacyRelRoot?: string) => {
      for (const row of rowsToUse || []) {
        if (!row || !row.file_path || row.info_json === undefined) continue
        let info: ISongInfo | null = null
        try {
          info = JSON.parse(String(row.info_json)) as ISongInfo
        } catch {
          info = null
        }
        const size = toNumber(row.size)
        const mtimeMs = toNumber(row.mtime_ms)
        if (!info || size === null || mtimeMs === null) continue
        let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
        if (legacyRelRoot) {
          const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
          if (resolvedLegacy && resolvedLegacy.isRelativeKey) {
            absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
          }
        }
        info.filePath = absFilePath
        map.set(absFilePath, { size, mtimeMs, info })
      }
    }
    appendRows(rows, listRootKey)
    if (legacyRows && legacyRows.length > 0 && legacyListRoot && listRootAbs) {
      appendRows(legacyRows, legacyListRoot, legacyListRoot)
      if (resolvedRoot.isRelativeKey) {
        migrateSongCacheRows(db, legacyListRoot, listRootKey, listRootAbs)
      }
    }
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  }
}

export async function loadSongCacheEntry(
  listRoot: string,
  filePath: string
): Promise<SongCacheEntry | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  try {
    await ensureSongCacheMigrated(db, listRoot)
    let row = db
      .prepare(
        'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(listRootKey, fileKeyRaw)
      if (row) {
        hitListRoot = listRootKey
        hitFilePath = fileKeyRaw
        legacyHit = true
      }
    }
    if (!row && legacyListRoot && legacyFilePath) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row || row.info_json === undefined) return null
    let info: ISongInfo | null = null
    try {
      info = JSON.parse(String(row.info_json)) as ISongInfo
    } catch {
      info = null
    }
    const size = toNumber(row.size)
    const mtimeMs = toNumber(row.mtime_ms)
    if (!info || size === null || mtimeMs === null) return null
    const absFilePath =
      resolvedFile.abs || resolveAbsoluteFilePath(hitListRoot, String(hitFilePath))
    info.filePath = absFilePath
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const normalizedInfoJson = normalizeInfoJsonFilePath(row.info_json, absFilePath)
        const del = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
        const update = db.prepare(
          'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
        )
        del.run(listRootKey, fileKey)
        update.run(listRootKey, fileKey, normalizedInfoJson, hitListRoot, hitFilePath)
      } catch {}
    }
    return { size, mtimeMs, info }
  } catch (error) {
    log.error('[sqlite] song cache entry load failed', error)
    return undefined
  }
}

export async function updateSongCacheKey(
  listRoot: string,
  filePath: string,
  keyText: string
): Promise<boolean> {
  try {
    const entry = await loadSongCacheEntry(listRoot, filePath)
    if (!entry) return false
    if (entry.info.key === keyText) return true
    entry.info.key = keyText
    return await upsertSongCacheEntry(listRoot, filePath, entry)
  } catch (error) {
    log.error('[sqlite] song cache key update failed', error)
    return false
  }
}

export async function updateSongCacheBpm(
  listRoot: string,
  filePath: string,
  bpm: number
): Promise<boolean> {
  const normalizedBpm = Number.isFinite(bpm) ? Number(bpm.toFixed(2)) : null
  if (normalizedBpm === null) return false
  try {
    const entry = await loadSongCacheEntry(listRoot, filePath)
    if (!entry) return false
    if (entry.info.bpm === normalizedBpm) return true
    entry.info.bpm = normalizedBpm
    return await upsertSongCacheEntry(listRoot, filePath, entry)
  } catch (error) {
    log.error('[sqlite] song cache bpm update failed', error)
    return false
  }
}

export async function replaceSongCache(
  listRoot: string,
  entries: Map<string, SongCacheEntry>
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const wipe = db.prepare('DELETE FROM song_cache WHERE list_root = ?')
    const run = db.transaction(() => {
      wipe.run(listRootKey)
      if (legacyListRoot) wipe.run(legacyListRoot)
      for (const [filePath, entry] of entries) {
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
        const infoJson = normalizeInfoJsonFilePath(JSON.stringify(entry.info), absFilePath)
        insert.run(listRootKey, resolvedFile.key, entry.size, entry.mtimeMs, infoJson)
      }
    })
    run()
    return true
  } catch (error) {
    log.error('[sqlite] song cache replace failed', error)
    return false
  }
}

export async function upsertSongCacheEntry(
  listRoot: string,
  filePath: string,
  entry: SongCacheEntry,
  oldFilePath?: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const fileKey = resolvedFile.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const insert = db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, info_json = excluded.info_json'
    )
    const remove = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const run = db.transaction(() => {
      if (oldFilePath && oldFilePath !== filePath) {
        const resolvedOldFile = resolveFilePathInput(listRootAbs, oldFilePath)
        if (resolvedOldFile) {
          remove.run(listRootKey, resolvedOldFile.key)
          if (resolvedOldFile.keyRaw) remove.run(listRootKey, resolvedOldFile.keyRaw)
          if (legacyListRoot && resolvedOldFile.legacyAbs) {
            remove.run(legacyListRoot, resolvedOldFile.legacyAbs)
          }
        }
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        remove.run(legacyListRoot, resolvedFile.legacyAbs)
      }
      if (resolvedFile.keyRaw) {
        remove.run(listRootKey, resolvedFile.keyRaw)
      }
      const absFilePath = resolveAbsoluteFilePath(listRootKey, fileKey)
      const infoJson = normalizeInfoJsonFilePath(JSON.stringify(entry.info), absFilePath)
      insert.run(listRootKey, fileKey, entry.size, entry.mtimeMs, infoJson)
    })
    run()
    return true
  } catch (error) {
    log.error('[sqlite] song cache upsert failed', error)
    return false
  }
}

export async function clearSongCache(listRoot: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    db.prepare('DELETE FROM song_cache WHERE list_root = ?').run(listRootKey)
    if (legacyListRoot) {
      db.prepare('DELETE FROM song_cache WHERE list_root = ?').run(legacyListRoot)
    }
    return true
  } catch (error) {
    log.error('[sqlite] song cache clear failed', error)
    return false
  }
}

export async function removeSongCacheEntry(listRoot: string, filePath: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
      listRootKey,
      resolvedFile.key
    )
    if (resolvedFile.keyRaw) {
      db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
    return true
  } catch (error) {
    log.error('[sqlite] song cache delete failed', error)
    return false
  }
}
