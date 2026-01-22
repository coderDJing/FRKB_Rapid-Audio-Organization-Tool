import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb } from './libraryDb'
import { log } from './log'
import {
  decodeMixxxWaveformData,
  encodeMixxxWaveformData,
  MIXXX_WAVEFORM_CACHE_VERSION,
  type MixxxWaveformData
} from './waveformCache'
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

type WaveformCacheMeta = {
  size: number
  mtimeMs: number
  version: number
  sampleRate: number
  step: number
  duration: number
  frames: number
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

function normalizeWaveformMeta(row: any): WaveformCacheMeta | null {
  if (!row) return null
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const version = toNumber(row.version)
  const sampleRate = toNumber(row.sample_rate)
  const step = toNumber(row.step)
  const duration = toNumber(row.duration)
  const frames = toNumber(row.frames)
  if (
    size === null ||
    mtimeMs === null ||
    version === null ||
    sampleRate === null ||
    step === null ||
    duration === null ||
    frames === null
  ) {
    return null
  }
  if (frames <= 0) return null
  return { size, mtimeMs, version, sampleRate, step, duration, frames }
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

export async function loadSongCacheEntry(
  listRoot: string,
  filePath: string
): Promise<SongCacheEntry | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const row = db
      .prepare(
        'SELECT size, mtime_ms, info_json FROM song_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRoot, filePath)
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
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const row = db
      .prepare('SELECT info_json FROM song_cache WHERE list_root = ? AND file_path = ?')
      .get(listRoot, filePath)
    if (!row || row.info_json === undefined) return false
    let info: ISongInfo | null = null
    try {
      info = JSON.parse(String(row.info_json)) as ISongInfo
    } catch {
      info = null
    }
    if (!info) return false
    if (info.key === keyText) return true
    const nextInfo = { ...info, key: keyText }
    db.prepare('UPDATE song_cache SET info_json = ? WHERE list_root = ? AND file_path = ?').run(
      JSON.stringify(nextInfo),
      listRoot,
      filePath
    )
    return true
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
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const normalizedBpm = Number.isFinite(bpm) ? Number(bpm.toFixed(2)) : null
  if (normalizedBpm === null) return false
  try {
    await ensureSongCacheMigrated(db, listRoot)
    const row = db
      .prepare('SELECT info_json FROM song_cache WHERE list_root = ? AND file_path = ?')
      .get(listRoot, filePath)
    if (!row || row.info_json === undefined) return false
    let info: ISongInfo | null = null
    try {
      info = JSON.parse(String(row.info_json)) as ISongInfo
    } catch {
      info = null
    }
    if (!info) return false
    if (info.bpm === normalizedBpm) return true
    const nextInfo = { ...info, bpm: normalizedBpm }
    db.prepare('UPDATE song_cache SET info_json = ? WHERE list_root = ? AND file_path = ?').run(
      JSON.stringify(nextInfo),
      listRoot,
      filePath
    )
    return true
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

export async function loadWaveformCacheData(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<MixxxWaveformData | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  try {
    const row = db
      .prepare(
        'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRoot, filePath)
    if (!row || row.data === undefined) return null
    const meta = normalizeWaveformMeta(row)
    if (!meta || meta.version !== MIXXX_WAVEFORM_CACHE_VERSION) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    if (meta.size !== stat.size || Math.abs(meta.mtimeMs - stat.mtimeMs) > 1) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const payload = Buffer.isBuffer(row.data)
      ? row.data
      : row.data instanceof Uint8Array
        ? Buffer.from(row.data)
        : null
    if (!payload) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const decoded = decodeMixxxWaveformData(
      {
        sampleRate: meta.sampleRate,
        step: meta.step,
        duration: meta.duration,
        frames: meta.frames
      },
      payload
    )
    if (!decoded) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] waveform cache load failed', error)
    return undefined
  }
}

export async function hasWaveformCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  try {
    const row = db
      .prepare(
        'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRoot, filePath)
    if (!row) return false
    const size = toNumber(row.size)
    const mtimeMs = toNumber(row.mtime_ms)
    const version = toNumber(row.version)
    const frames = toNumber(row.frames)
    if (
      size === null ||
      mtimeMs === null ||
      version === null ||
      frames === null ||
      frames <= 0 ||
      version !== MIXXX_WAVEFORM_CACHE_VERSION
    ) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return false
    }
    if (size !== stat.size || Math.abs(mtimeMs - stat.mtimeMs) > 1) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return false
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache check failed', error)
    return false
  }
}

export async function hasWaveformCacheEntryByMeta(
  listRoot: string,
  filePath: string,
  size: number,
  mtimeMs: number
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const sizeNum = toNumber(size)
  const mtimeNum = toNumber(mtimeMs)
  if (sizeNum === null || mtimeNum === null) return false
  try {
    const row = db
      .prepare(
        'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRoot, filePath)
    if (!row) return false
    const rowSize = toNumber(row.size)
    const rowMtime = toNumber(row.mtime_ms)
    const version = toNumber(row.version)
    const frames = toNumber(row.frames)
    if (
      rowSize === null ||
      rowMtime === null ||
      version === null ||
      frames === null ||
      frames <= 0 ||
      version !== MIXXX_WAVEFORM_CACHE_VERSION
    ) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return false
    }
    if (rowSize !== sizeNum || Math.abs(rowMtime - mtimeNum) > 1) {
      await removeWaveformCacheEntry(listRoot, filePath)
      return false
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache meta check failed', error)
    return false
  }
}

export async function upsertWaveformCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: MixxxWaveformData
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  if (!Number.isFinite(data?.sampleRate) || data.sampleRate <= 0) return false
  if (!Number.isFinite(data?.step) || data.step <= 0) return false
  if (!Number.isFinite(data?.duration) || data.duration <= 0) return false
  const encoded = encodeMixxxWaveformData(data)
  if (!encoded) return false
  try {
    db.prepare(
      'INSERT INTO waveform_cache (list_root, file_path, size, mtime_ms, version, sample_rate, step, duration, frames, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, version = excluded.version, sample_rate = excluded.sample_rate, step = excluded.step, duration = excluded.duration, frames = excluded.frames, data = excluded.data'
    ).run(
      listRoot,
      filePath,
      stat.size,
      stat.mtimeMs,
      MIXXX_WAVEFORM_CACHE_VERSION,
      data.sampleRate,
      data.step,
      data.duration,
      encoded.frames,
      encoded.payload
    )
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache upsert failed', error)
    return false
  }
}

export async function moveWaveformCacheEntry(
  listRoot: string,
  oldFilePath: string,
  newFilePath: string,
  stat?: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !oldFilePath || !newFilePath) return false
  if (oldFilePath === newFilePath) return true
  try {
    const row = db
      .prepare(
        'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRoot, oldFilePath)
    if (!row || row.data === undefined) return false
    const meta = normalizeWaveformMeta(row)
    if (!meta || meta.version !== MIXXX_WAVEFORM_CACHE_VERSION) {
      await removeWaveformCacheEntry(listRoot, oldFilePath)
      return false
    }
    const payload = Buffer.isBuffer(row.data)
      ? row.data
      : row.data instanceof Uint8Array
        ? Buffer.from(row.data)
        : null
    if (!payload) {
      await removeWaveformCacheEntry(listRoot, oldFilePath)
      return false
    }
    const nextSize = stat && Number.isFinite(stat.size) ? Number(stat.size) : Number(meta.size)
    const nextMtime =
      stat && Number.isFinite(stat.mtimeMs) ? Number(stat.mtimeMs) : Number(meta.mtimeMs)
    db.prepare(
      'INSERT INTO waveform_cache (list_root, file_path, size, mtime_ms, version, sample_rate, step, duration, frames, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, version = excluded.version, sample_rate = excluded.sample_rate, step = excluded.step, duration = excluded.duration, frames = excluded.frames, data = excluded.data'
    ).run(
      listRoot,
      newFilePath,
      nextSize,
      nextMtime,
      meta.version,
      meta.sampleRate,
      meta.step,
      meta.duration,
      meta.frames,
      payload
    )
    db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?').run(
      listRoot,
      oldFilePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache move failed', error)
    return false
  }
}

export async function updateWaveformCacheStat(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  try {
    const result = db
      .prepare(
        'UPDATE waveform_cache SET size = ?, mtime_ms = ? WHERE list_root = ? AND file_path = ?'
      )
      .run(stat.size, stat.mtimeMs, listRoot, filePath)
    return result.changes > 0
  } catch (error) {
    log.error('[sqlite] waveform cache stat update failed', error)
    return false
  }
}

export async function removeWaveformCacheEntry(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  try {
    db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?').run(
      listRoot,
      filePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache delete failed', error)
    return false
  }
}

export async function clearWaveformCache(listRoot: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  try {
    db.prepare('DELETE FROM waveform_cache WHERE list_root = ?').run(listRoot)
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache clear failed', error)
    return false
  }
}

export async function pruneCachesByRoots(
  keepRoots: Iterable<string> | null | undefined
): Promise<{ songCacheRemoved: number; coverIndexRemoved: number; waveformCacheRemoved: number }> {
  const db = getLibraryDb()
  if (!db) return { songCacheRemoved: 0, coverIndexRemoved: 0, waveformCacheRemoved: 0 }
  try {
    const keepSet = new Set<string>()
    if (keepRoots) {
      for (const root of keepRoots) {
        const normalized = normalizeRoot(root)
        if (normalized) keepSet.add(normalized)
      }
    }

    const pruneTable = (table: 'song_cache' | 'cover_index' | 'waveform_cache'): number => {
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
    const waveformCacheRemoved = pruneTable('waveform_cache')
    return { songCacheRemoved, coverIndexRemoved, waveformCacheRemoved }
  } catch (error) {
    log.error('[sqlite] cache prune failed', error)
    return { songCacheRemoved: 0, coverIndexRemoved: 0, waveformCacheRemoved: 0 }
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
