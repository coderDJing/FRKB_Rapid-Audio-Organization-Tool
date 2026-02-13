import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  normalizeRoot
} from './pathResolvers'

type RawWaveformCacheMeta = {
  size: number
  mtimeMs: number
  version: number
  sampleRate: number
  rate: number
  duration: number
  frames: number
}

export type MixtapeRawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
}

const MIXTAPE_RAW_WAVEFORM_TABLE = 'mixtape_raw_waveform_cache'
const MIXTAPE_RAW_WAVEFORM_CACHE_VERSION = 1

function normalizeRawWaveformMeta(row: any): RawWaveformCacheMeta | null {
  if (!row) return null
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const version = toNumber(row.version)
  const sampleRate = toNumber(row.sample_rate)
  const rate = toNumber(row.rate)
  const duration = toNumber(row.duration)
  const frames = toNumber(row.frames)
  if (
    size === null ||
    mtimeMs === null ||
    version === null ||
    sampleRate === null ||
    rate === null ||
    duration === null ||
    frames === null
  ) {
    return null
  }
  if (frames <= 0) return null
  return { size, mtimeMs, version, sampleRate, rate, duration, frames }
}

const normalizeBlob = (value: unknown): Buffer | null => {
  if (!value) return null
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

export async function loadMixtapeRawWaveformCacheData(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<MixtapeRawWaveformData | null | undefined> {
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
        `SELECT size, mtime_ms, version, sample_rate, rate, duration, frames, min_left, max_left, min_right, max_right FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
      )
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare(
          `SELECT size, mtime_ms, version, sample_rate, rate, duration, frames, min_left, max_left, min_right, max_right FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
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
          `SELECT size, mtime_ms, version, sample_rate, rate, duration, frames, min_left, max_left, min_right, max_right FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
        )
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row) {
      return null
    }
    const meta = normalizeRawWaveformMeta(row)
    if (!meta || meta.version !== MIXTAPE_RAW_WAVEFORM_CACHE_VERSION) {
      await removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
      return null
    }
    if (meta.size !== stat.size || Math.abs(meta.mtimeMs - stat.mtimeMs) > 1) {
      await removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
      return null
    }

    const minLeft = normalizeBlob(row.min_left)
    const maxLeft = normalizeBlob(row.max_left)
    const minRight = normalizeBlob(row.min_right)
    const maxRight = normalizeBlob(row.max_right)
    if (!minLeft || !maxLeft || !minRight || !maxRight) {
      await removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
      return null
    }

    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const sameRoot = normalizeRoot(hitListRoot) === normalizeRoot(listRootKey)
        if (sameRoot) {
          const del = db.prepare(
            `DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
          )
          const update = db.prepare(
            `UPDATE ${MIXTAPE_RAW_WAVEFORM_TABLE} SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?`
          )
          del.run(listRootKey, fileKey)
          update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
        } else {
          await upsertMixtapeRawWaveformCacheEntry(listRoot, filePath, stat, {
            duration: meta.duration,
            sampleRate: meta.sampleRate,
            rate: meta.rate,
            frames: meta.frames,
            minLeft,
            maxLeft,
            minRight,
            maxRight
          })
        }
      } catch {}
    }

    return {
      duration: meta.duration,
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: meta.frames,
      minLeft,
      maxLeft,
      minRight,
      maxRight
    }
  } catch (error) {
    log.error('[sqlite] mixtape raw waveform cache load failed', error)
    return undefined
  }
}

export async function upsertMixtapeRawWaveformCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: MixtapeRawWaveformData
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
  if (!Number.isFinite(data?.rate) || data.rate <= 0) return false
  if (!Number.isFinite(data?.duration) || data.duration <= 0) return false
  if (!Number.isFinite(data?.frames) || data.frames <= 0) return false

  const minLeft = normalizeBlob(data.minLeft)
  const maxLeft = normalizeBlob(data.maxLeft)
  const minRight = normalizeBlob(data.minRight)
  const maxRight = normalizeBlob(data.maxRight)
  if (!minLeft || !maxLeft || !minRight || !maxRight) return false

  try {
    db.prepare(
      `INSERT INTO ${MIXTAPE_RAW_WAVEFORM_TABLE} (list_root, file_path, size, mtime_ms, version, sample_rate, rate, duration, frames, min_left, max_left, min_right, max_right) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, version = excluded.version, sample_rate = excluded.sample_rate, rate = excluded.rate, duration = excluded.duration, frames = excluded.frames, min_left = excluded.min_left, max_left = excluded.max_left, min_right = excluded.min_right, max_right = excluded.max_right`
    ).run(
      listRootKey,
      resolvedFile.key,
      stat.size,
      stat.mtimeMs,
      MIXTAPE_RAW_WAVEFORM_CACHE_VERSION,
      data.sampleRate,
      data.rate,
      data.duration,
      data.frames,
      minLeft,
      maxLeft,
      minRight,
      maxRight
    )
    if (resolvedFile.keyRaw && resolvedFile.keyRaw !== resolvedFile.key) {
      db.prepare(
        `DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
      ).run(listRootKey, resolvedFile.keyRaw)
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare(
        `DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
      ).run(legacyListRoot, resolvedFile.legacyAbs)
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape raw waveform cache upsert failed', error)
    return false
  }
}

export async function removeMixtapeRawWaveformCacheEntry(
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
      `DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
    )
    del.run(listRootKey, resolvedFile.key)
    if (resolvedFile.keyRaw) del.run(listRootKey, resolvedFile.keyRaw)
    if (legacyListRoot && resolvedFile.legacyAbs) {
      del.run(legacyListRoot, resolvedFile.legacyAbs)
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape raw waveform cache delete failed', error)
    return false
  }
}

export async function clearMixtapeRawWaveformCache(listRoot: string): Promise<boolean> {
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
    db.prepare(`DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ?`).run(listRootKey)
    if (legacyListRoot) {
      db.prepare(`DELETE FROM ${MIXTAPE_RAW_WAVEFORM_TABLE} WHERE list_root = ?`).run(
        legacyListRoot
      )
    }
    return true
  } catch (error) {
    log.error('[sqlite] mixtape raw waveform cache clear failed', error)
    return false
  }
}
