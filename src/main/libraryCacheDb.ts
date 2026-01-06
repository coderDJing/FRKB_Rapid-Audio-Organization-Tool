import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb } from './libraryDb'
import { log } from './log'
import { ISongInfo } from '../types/globals'

export type SongCacheEntry = {
  size: number
  mtimeMs: number
  info: ISongInfo
}

export type CoverIndexEntry = {
  filePath: string
  hash: string
  ext: string
}

export type LegacyCacheRoots = {
  songRoots: Set<string>
  coverRoots: Set<string>
}

const migratedSongRoots = new Set<string>()
const migratedCoverRoots = new Set<string>()

function toNumber(value: any): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeRoot(value: any): string {
  let normalized = path.normalize(String(value || ''))
  normalized = normalized.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

async function ensureSongCacheMigrated(db: any, listRoot: string): Promise<void> {
  if (!listRoot || migratedSongRoots.has(listRoot)) return
  migratedSongRoots.add(listRoot)
  try {
    const countRow = db
      .prepare('SELECT COUNT(1) as count FROM song_cache WHERE list_root = ?')
      .get(listRoot)
    if (countRow && Number(countRow.count) > 0) return
    const cacheFile = path.join(listRoot, '.songs.cache.json')
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
        infoJson = JSON.stringify(info)
      } catch {
        continue
      }
      rows.push({ filePath, size, mtimeMs, infoJson })
    }
    if (!rows.length) return
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const run = db.transaction((items: typeof rows) => {
      for (const row of items) {
        insert.run(listRoot, row.filePath, row.size, row.mtimeMs, row.infoJson)
      }
    })
    run(rows)
  } catch (error) {
    log.error('[sqlite] song cache migrate failed', error)
  }
}

async function ensureCoverIndexMigrated(db: any, listRoot: string): Promise<void> {
  if (!listRoot || migratedCoverRoots.has(listRoot)) return
  migratedCoverRoots.add(listRoot)
  try {
    const countRow = db
      .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ?')
      .get(listRoot)
    if (countRow && Number(countRow.count) > 0) return
    const indexPath = path.join(listRoot, '.frkb_covers', '.index.json')
    if (!(await fs.pathExists(indexPath))) return
    const json = await fs.readJSON(indexPath).catch(() => null)
    const fileToHash = json && typeof json === 'object' ? (json.fileToHash as any) : null
    const hashToExt = json && typeof json === 'object' ? (json.hashToExt as any) : null
    if (!fileToHash || typeof fileToHash !== 'object') return
    const rows: CoverIndexEntry[] = []
    for (const [filePath, hash] of Object.entries(fileToHash)) {
      if (!filePath || typeof hash !== 'string' || !hash) continue
      const extRaw = hashToExt && typeof hashToExt === 'object' ? hashToExt[hash] : null
      const ext = typeof extRaw === 'string' && extRaw.trim() ? extRaw : '.jpg'
      rows.push({ filePath, hash, ext })
    }
    if (!rows.length) return
    const insert = db.prepare(
      'INSERT OR REPLACE INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?)'
    )
    const run = db.transaction((items: CoverIndexEntry[]) => {
      for (const row of items) {
        insert.run(listRoot, row.filePath, row.hash, row.ext)
      }
    })
    run(rows)
  } catch (error) {
    log.error('[sqlite] cover index migrate failed', error)
  }
}

export async function loadSongCache(listRoot: string): Promise<Map<string, SongCacheEntry> | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const rows = db
      .prepare('SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?')
      .all(listRoot)
    const map = new Map<string, SongCacheEntry>()
    for (const row of rows || []) {
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
      map.set(String(row.file_path), { size, mtimeMs, info })
    }
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  }
}

export async function replaceSongCache(
  listRoot: string,
  entries: Map<string, SongCacheEntry>
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  try {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    const wipe = db.prepare('DELETE FROM song_cache WHERE list_root = ?')
    const run = db.transaction(() => {
      wipe.run(listRoot)
      for (const [filePath, entry] of entries) {
        const infoJson = JSON.stringify(entry.info)
        insert.run(listRoot, filePath, entry.size, entry.mtimeMs, infoJson)
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
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const insert = db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, info_json = excluded.info_json'
    )
    const remove = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const run = db.transaction(() => {
      if (oldFilePath && oldFilePath !== filePath) {
        remove.run(listRoot, oldFilePath)
      }
      insert.run(listRoot, filePath, entry.size, entry.mtimeMs, JSON.stringify(entry.info))
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
  try {
    db.prepare('DELETE FROM song_cache WHERE list_root = ?').run(listRoot)
    return true
  } catch (error) {
    log.error('[sqlite] song cache clear failed', error)
    return false
  }
}

export async function removeSongCacheEntry(listRoot: string, filePath: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  try {
    await ensureSongCacheMigrated(db, listRoot)
    db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?').run(
      listRoot,
      filePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] song cache delete failed', error)
    return false
  }
}

export async function loadCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const row = db
      .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
      .get(listRoot, filePath)
    if (!row || !row.hash) return null
    return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
  } catch (error) {
    log.error('[sqlite] cover index load failed', error)
    return undefined
  }
}

export async function upsertCoverIndexEntry(
  listRoot: string,
  filePath: string,
  hash: string,
  ext: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath || !hash) return false
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    db.prepare(
      'INSERT INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET hash = excluded.hash, ext = excluded.ext'
    ).run(listRoot, filePath, hash, ext || '.jpg')
    return true
  } catch (error) {
    log.error('[sqlite] cover index upsert failed', error)
    return false
  }
}

export async function removeCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const row = db
      .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
      .get(listRoot, filePath)
    if (!row || !row.hash) {
      return null
    }
    db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
      listRoot,
      filePath
    )
    return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
  } catch (error) {
    log.error('[sqlite] cover index delete failed', error)
    return undefined
  }
}

export async function loadCoverIndexEntries(listRoot: string): Promise<CoverIndexEntry[] | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const rows = db
      .prepare('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
      .all(listRoot)
    return (rows || [])
      .filter((row: any) => row && row.file_path && row.hash)
      .map((row: any) => ({
        filePath: String(row.file_path),
        hash: String(row.hash),
        ext: String(row.ext || '.jpg')
      }))
  } catch (error) {
    log.error('[sqlite] cover index list failed', error)
    return null
  }
}

export async function removeCoverIndexEntries(
  listRoot: string,
  filePaths: string[]
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  if (!Array.isArray(filePaths) || filePaths.length === 0) return true
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
    const run = db.transaction((items: string[]) => {
      for (const fp of items) {
        del.run(listRoot, fp)
      }
    })
    run(filePaths)
    return true
  } catch (error) {
    log.error('[sqlite] cover index bulk delete failed', error)
    return false
  }
}

export async function clearCoverIndex(listRoot: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  try {
    db.prepare('DELETE FROM cover_index WHERE list_root = ?').run(listRoot)
    return true
  } catch (error) {
    log.error('[sqlite] cover index clear failed', error)
    return false
  }
}

export async function countCoverIndexByHash(
  listRoot: string,
  hash: string
): Promise<number | null> {
  const db = getLibraryDb()
  if (!db || !listRoot || !hash) return null
  try {
    const row = db
      .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ? AND hash = ?')
      .get(listRoot, hash)
    return row ? Number(row.count) : 0
  } catch (error) {
    log.error('[sqlite] cover index count failed', error)
    return null
  }
}

export async function pruneCachesByRoots(
  keepRoots: Iterable<string> | null | undefined
): Promise<{ songCacheRemoved: number; coverIndexRemoved: number }> {
  const db = getLibraryDb()
  if (!db) return { songCacheRemoved: 0, coverIndexRemoved: 0 }
  try {
    const keepSet = new Set<string>()
    if (keepRoots) {
      for (const root of keepRoots) {
        const normalized = normalizeRoot(root)
        if (normalized) keepSet.add(normalized)
      }
    }

    const pruneTable = (table: 'song_cache' | 'cover_index'): number => {
      const rows = db.prepare(`SELECT DISTINCT list_root FROM ${table}`).all()
      if (!rows || rows.length === 0) return 0
      const toRemove: string[] = []
      for (const row of rows) {
        const raw = row?.list_root
        const normalized = normalizeRoot(raw)
        if (!normalized || !keepSet.has(normalized)) {
          toRemove.push(String(raw))
        }
      }
      if (toRemove.length === 0) return 0
      const del = db.prepare(`DELETE FROM ${table} WHERE list_root = ?`)
      let removed = 0
      const run = db.transaction((items: string[]) => {
        for (const item of items) {
          const info = del.run(item) as any
          removed += Number(info?.changes || 0)
        }
      })
      run(toRemove)
      return removed
    }

    const songCacheRemoved = pruneTable('song_cache')
    const coverIndexRemoved = pruneTable('cover_index')
    return { songCacheRemoved, coverIndexRemoved }
  } catch (error) {
    log.error('[sqlite] cache prune failed', error)
    return { songCacheRemoved: 0, coverIndexRemoved: 0 }
  }
}

export async function migrateLegacyCachesInLibrary(
  dbRoot: string,
  roots?: LegacyCacheRoots
): Promise<void> {
  const db = getLibraryDb()
  if (!db || !dbRoot) return
  const resolvedRoots = roots || (await scanLegacyCacheRoots(dbRoot))
  if (resolvedRoots.songRoots.size === 0 && resolvedRoots.coverRoots.size === 0) return
  for (const root of resolvedRoots.songRoots) {
    await ensureSongCacheMigrated(db, root)
  }
  for (const root of resolvedRoots.coverRoots) {
    await ensureCoverIndexMigrated(db, root)
  }
}

export async function scanLegacyCacheRoots(dbRoot: string): Promise<LegacyCacheRoots> {
  const songRoots = new Set<string>()
  const coverRoots = new Set<string>()
  if (!dbRoot) return { songRoots, coverRoots }
  const libRoot = path.join(dbRoot, 'library')
  if (!(await fs.pathExists(libRoot))) return { songRoots, coverRoots }

  const walk = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      let hasSongCache = false
      let hasCoverDir = false
      for (const entry of entries) {
        if (entry.isFile() && entry.name === '.songs.cache.json') {
          hasSongCache = true
        } else if (entry.isDirectory() && entry.name === '.frkb_covers') {
          hasCoverDir = true
        }
      }
      if (hasSongCache) songRoots.add(dir)
      if (hasCoverDir) {
        const indexPath = path.join(dir, '.frkb_covers', '.index.json')
        if (await fs.pathExists(indexPath)) {
          coverRoots.add(dir)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === '.frkb_covers') continue
        const full = path.join(dir, entry.name)
        await walk(full)
      }
    } catch {}
  }

  await walk(libRoot)
  return { songRoots, coverRoots }
}
