import path = require('path')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  decodeMixxxWaveformData,
  encodeMixxxWaveformData,
  MIXXX_WAVEFORM_CACHE_VERSION,
  type MixxxWaveformData
} from '../waveformCache'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  normalizeRoot
} from './pathResolvers'

type WaveformCacheMeta = {
  size: number
  mtimeMs: number
  version: number
  sampleRate: number
  step: number
  duration: number
  frames: number
}

const looseWaveformRootCache = new Map<string, string[]>()

function toLooseCompareExpr(column: string): string {
  return `REPLACE(LOWER(${column}), '/', '\\\\') = REPLACE(LOWER(?), '/', '\\\\')`
}

function toLooseCompareExprRaw(expr: string): string {
  return `REPLACE(LOWER(${expr}), '/', '\\\\') = REPLACE(LOWER(?), '/', '\\\\')`
}

function getLooseWaveformRoots(
  db: any,
  candidates: Array<string | null | undefined>,
  listRootKey: string
): string[] {
  const key = `${listRootKey}::${candidates.filter(Boolean).join('|')}`
  const cached = looseWaveformRootCache.get(key)
  if (cached) return cached
  const roots: string[] = []
  const seen = new Set<string>()
  const stmt = db.prepare(
    `SELECT DISTINCT list_root FROM waveform_cache WHERE ${toLooseCompareExpr('list_root')} LIMIT 20`
  )
  for (const candidate of candidates) {
    const value = candidate ? String(candidate) : ''
    if (!value) continue
    let rows: any[] = []
    try {
      rows = stmt.all(value)
    } catch {
      rows = []
    }
    for (const row of rows) {
      const root = row?.list_root ? String(row.list_root) : ''
      if (!root || seen.has(root)) continue
      seen.add(root)
      roots.push(root)
    }
  }
  looseWaveformRootCache.set(key, roots)
  return roots
}

function getWaveformRowLoose(
  db: any,
  listRootCandidates: string[],
  filePathCandidates: string[]
): { row: any; hitListRoot: string; hitFilePath: string } | null {
  if (!db || listRootCandidates.length === 0 || filePathCandidates.length === 0) return null
  const stmt = db.prepare(
    `SELECT list_root, file_path, size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE ${toLooseCompareExpr(
      'list_root'
    )} AND ${toLooseCompareExpr('file_path')} LIMIT 1`
  )
  for (const listRoot of listRootCandidates) {
    for (const filePath of filePathCandidates) {
      let row: any = null
      try {
        row = stmt.get(listRoot, filePath)
      } catch {
        row = null
      }
      if (row && row.data !== undefined) {
        return {
          row,
          hitListRoot: String(row.list_root || listRoot),
          hitFilePath: String(row.file_path || filePath)
        }
      }
    }
  }
  return null
}

function getWaveformRowBySongAbsPath(
  db: any,
  absPathCandidates: string[]
): { row: any; hitListRoot: string; hitFilePath: string } | null {
  if (!db || absPathCandidates.length === 0) return null
  try {
    const expr = "json_extract(s.info_json, '$.filePath')"
    const stmt = db.prepare(
      `SELECT w.list_root, w.file_path, w.size, w.mtime_ms, w.version, w.sample_rate, w.step, w.duration, w.frames, w.data
       FROM waveform_cache w
       JOIN song_cache s ON s.list_root = w.list_root AND s.file_path = w.file_path
       WHERE ${toLooseCompareExprRaw(expr)} LIMIT 1`
    )
    for (const absPath of absPathCandidates) {
      let row: any = null
      try {
        row = stmt.get(absPath)
      } catch {
        row = null
      }
      if (row && row.data !== undefined) {
        return {
          row,
          hitListRoot: String(row.list_root || ''),
          hitFilePath: String(row.file_path || '')
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export function migrateWaveformCacheRows(
  db: any,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare(
        'SELECT file_path, size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ?'
      )
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const newFileKey = resolvedFile.key
        del.run(newListRootKey, newFileKey)
        const result = update.run(newListRootKey, newFileKey, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
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

export async function loadWaveformCacheData(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<MixxxWaveformData | null | undefined> {
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
    let row = db
      .prepare(
        'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
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
          'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row || row.data === undefined) {
      const looseRoots = getLooseWaveformRoots(
        db,
        [listRoot, listRootAbs, listRootKey],
        listRootKey
      )
      const loose = getWaveformRowLoose(
        db,
        looseRoots,
        [fileKey, fileKeyRaw, legacyFilePath, filePath].filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      )
      if (loose) {
        row = loose.row
        hitListRoot = loose.hitListRoot
        hitFilePath = loose.hitFilePath
        legacyHit = true
      }
    }
    if (!row || row.data === undefined) {
      const absCandidates = [resolvedFile.abs, filePath, legacyFilePath].filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
      )
      if (absCandidates.length > 0) {
        const byAbs = getWaveformRowBySongAbsPath(db, absCandidates)
        if (byAbs) {
          row = byAbs.row
          hitListRoot = byAbs.hitListRoot
          hitFilePath = byAbs.hitFilePath
          legacyHit = true
        }
      }
    }
    if (!row || row.data === undefined) {
      return null
    }
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
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const sameRoot = normalizeRoot(hitListRoot) === normalizeRoot(listRootKey)
        if (sameRoot) {
          const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
          const update = db.prepare(
            'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
          )
          del.run(listRootKey, fileKey)
          update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
        } else {
          await upsertWaveformCacheEntry(listRoot, filePath, stat, decoded)
        }
      } catch {}
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
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  try {
    let row = db
      .prepare(
        'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
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
          'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row) {
      const looseRoots = getLooseWaveformRoots(
        db,
        [listRoot, listRootAbs, listRootKey],
        listRootKey
      )
      const loose = getWaveformRowLoose(
        db,
        looseRoots,
        [fileKey, fileKeyRaw, legacyFilePath, filePath].filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      )
      if (loose) {
        row = loose.row
        hitListRoot = loose.hitListRoot
        hitFilePath = loose.hitFilePath
        legacyHit = true
      }
    }
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
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
        const update = db.prepare(
          'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
        )
        del.run(listRootKey, fileKey)
        update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
      } catch {}
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
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  const sizeNum = toNumber(size)
  const mtimeNum = toNumber(mtimeMs)
  if (sizeNum === null || mtimeNum === null) return false
  try {
    let row = db
      .prepare(
        'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
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
          'SELECT size, mtime_ms, version, frames FROM waveform_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row) {
      const looseRoots = getLooseWaveformRoots(
        db,
        [listRoot, listRootAbs, listRootKey],
        listRootKey
      )
      const loose = getWaveformRowLoose(
        db,
        looseRoots,
        [fileKey, fileKeyRaw, legacyFilePath, filePath].filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        )
      )
      if (loose) {
        row = loose.row
        hitListRoot = loose.hitListRoot
        hitFilePath = loose.hitFilePath
        legacyHit = true
      }
    }
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
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
        const update = db.prepare(
          'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
        )
        del.run(listRootKey, fileKey)
        update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
      } catch {}
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
      listRootKey,
      resolvedFile.key,
      stat.size,
      stat.mtimeMs,
      MIXXX_WAVEFORM_CACHE_VERSION,
      data.sampleRate,
      data.step,
      data.duration,
      encoded.frames,
      encoded.payload
    )
    if (resolvedFile.keyRaw && resolvedFile.keyRaw !== resolvedFile.key) {
      db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?').run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
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
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedOld = resolveFilePathInput(listRootAbs, oldFilePath)
  const resolvedNew = resolveFilePathInput(listRootAbs, newFilePath)
  if (!resolvedOld || !resolvedNew) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  if (oldFilePath === newFilePath) return true
  try {
    let row = db
      .prepare(
        'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
      )
      .get(listRootKey, resolvedOld.key)
    let hitListRoot = listRootKey
    let hitFilePath = resolvedOld.key
    let legacyHit = false
    if (!row && resolvedOld.keyRaw) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(listRootKey, resolvedOld.keyRaw)
      if (row) {
        hitListRoot = listRootKey
        hitFilePath = resolvedOld.keyRaw
        legacyHit = true
      }
    }
    if (!row && legacyListRoot && resolvedOld.legacyAbs) {
      row = db
        .prepare(
          'SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM waveform_cache WHERE list_root = ? AND file_path = ?'
        )
        .get(legacyListRoot, resolvedOld.legacyAbs)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = resolvedOld.legacyAbs
        legacyHit = true
      }
    }
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
      listRootKey,
      resolvedNew.key,
      nextSize,
      nextMtime,
      meta.version,
      meta.sampleRate,
      meta.step,
      meta.duration,
      meta.frames,
      payload
    )
    const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
    del.run(hitListRoot, hitFilePath)
    if (resolvedNew.keyRaw) del.run(listRootKey, resolvedNew.keyRaw)
    if (legacyListRoot && resolvedNew.legacyAbs) del.run(legacyListRoot, resolvedNew.legacyAbs)
    if (legacyHit && resolvedRoot.isRelativeKey) {
      del.run(listRootKey, resolvedOld.key)
    }
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
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  try {
    const update = db.prepare(
      'UPDATE waveform_cache SET size = ?, mtime_ms = ? WHERE list_root = ? AND file_path = ?'
    )
    const run = db.transaction(() => {
      update.run(stat.size, stat.mtimeMs, listRootKey, resolvedFile.key)
      if (resolvedFile.keyRaw) {
        update.run(stat.size, stat.mtimeMs, listRootKey, resolvedFile.keyRaw)
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        update.run(stat.size, stat.mtimeMs, legacyListRoot, resolvedFile.legacyAbs)
      }
    })
    run()
    return true
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
    const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
    del.run(listRootKey, resolvedFile.key)
    if (resolvedFile.keyRaw) del.run(listRootKey, resolvedFile.keyRaw)
    if (legacyListRoot && resolvedFile.legacyAbs) del.run(legacyListRoot, resolvedFile.legacyAbs)
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache delete failed', error)
    return false
  }
}

export async function clearWaveformCache(listRoot: string): Promise<boolean> {
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
    db.prepare('DELETE FROM waveform_cache WHERE list_root = ?').run(listRootKey)
    if (legacyListRoot) {
      db.prepare('DELETE FROM waveform_cache WHERE list_root = ?').run(legacyListRoot)
    }
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache clear failed', error)
    return false
  }
}
