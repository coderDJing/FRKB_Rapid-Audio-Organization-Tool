import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  decodeMixxxWaveformData,
  encodeMixxxWaveformData,
  MIXXX_MIXTAPE_WAVEFORM_CACHE_VERSION,
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

const MIXTAPE_WAVEFORM_TABLE = 'mixtape_waveform_cache'

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

export async function loadMixtapeWaveformCacheData(
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
        `SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          `SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
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
          `SELECT size, mtime_ms, version, sample_rate, step, duration, frames, data FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row || row.data === undefined) {
      return null
    }
    const meta = normalizeWaveformMeta(row)
    if (!meta || meta.version !== MIXXX_MIXTAPE_WAVEFORM_CACHE_VERSION) {
      await removeMixtapeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    if (meta.size !== stat.size || Math.abs(meta.mtimeMs - stat.mtimeMs) > 1) {
      await removeMixtapeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const payload = Buffer.isBuffer(row.data)
      ? row.data
      : row.data instanceof Uint8Array
        ? Buffer.from(row.data)
        : null
    if (!payload) {
      await removeMixtapeWaveformCacheEntry(listRoot, filePath)
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
      await removeMixtapeWaveformCacheEntry(listRoot, filePath)
      return null
    }
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const sameRoot = normalizeRoot(hitListRoot) === normalizeRoot(listRootKey)
        if (sameRoot) {
          const del = db.prepare(
            `DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
          )
          const update = db.prepare(
            `UPDATE ${MIXTAPE_WAVEFORM_TABLE} SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?`
          )
          del.run(listRootKey, fileKey)
          update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
        } else {
          await upsertMixtapeWaveformCacheEntry(listRoot, filePath, stat, decoded)
        }
      } catch {}
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] mixtape waveform cache load failed', error)
    return undefined
  }
}

export async function upsertMixtapeWaveformCacheEntry(
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
      `INSERT INTO ${MIXTAPE_WAVEFORM_TABLE} (list_root, file_path, size, mtime_ms, version, sample_rate, step, duration, frames, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, version = excluded.version, sample_rate = excluded.sample_rate, step = excluded.step, duration = excluded.duration, frames = excluded.frames, data = excluded.data`
    ).run(
      listRootKey,
      resolvedFile.key,
      stat.size,
      stat.mtimeMs,
      MIXXX_MIXTAPE_WAVEFORM_CACHE_VERSION,
      data.sampleRate,
      data.step,
      data.duration,
      encoded.frames,
      encoded.payload
    )
    if (resolvedFile.keyRaw && resolvedFile.keyRaw !== resolvedFile.key) {
      db.prepare(`DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`).run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare(`DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`).run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape waveform cache upsert failed', error)
    return false
  }
}

export async function removeMixtapeWaveformCacheEntry(
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
    const del = db.prepare(
      `DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
    )
    del.run(listRootKey, resolvedFile.key)
    if (resolvedFile.keyRaw) del.run(listRootKey, resolvedFile.keyRaw)
    if (legacyListRoot && resolvedFile.legacyAbs) {
      del.run(legacyListRoot, resolvedFile.legacyAbs)
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape waveform cache delete failed', error)
    return false
  }
}

export async function clearMixtapeWaveformCache(listRoot: string): Promise<boolean> {
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
    db.prepare(`DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ?`).run(listRootKey)
    if (legacyListRoot) {
      db.prepare(`DELETE FROM ${MIXTAPE_WAVEFORM_TABLE} WHERE list_root = ?`).run(legacyListRoot)
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape waveform cache clear failed', error)
    return false
  }
}
