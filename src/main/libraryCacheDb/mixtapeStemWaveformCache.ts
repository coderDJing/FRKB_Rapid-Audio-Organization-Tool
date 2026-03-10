import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  decodeStemWaveformData,
  encodeStemWaveformData,
  STEM_WAVEFORM_CACHE_VERSION,
  type StemWaveformData
} from '../stemWaveformCache'
import type { MixtapeStemMode } from '../mixtapeDb'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput
} from './pathResolvers'

const MIXTAPE_STEM_WAVEFORM_TABLE = 'mixtape_stem_waveform_cache'
const DEFAULT_TARGET_RATE = 441

const normalizeText = (value: unknown, maxLen = 128): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE

const normalizeTargetRate = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TARGET_RATE
  return Math.max(1, Math.round(parsed))
}

const normalizeSourceSignature = (value: unknown): string => normalizeText(value, 200)

type CacheKey = {
  listRoot: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  stemVersion: string
  targetRate?: number
}

type CacheLoadKey = CacheKey & {
  sourceSignature: string
}

const resolveNormalizedKey = (input: CacheKey | null | undefined) => {
  const resolvedRoot = resolveListRootInput(input?.listRoot || '')
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, input?.filePath || '')
  if (!resolvedFile) return null
  const stemMode = normalizeStemMode(input?.stemMode)
  const model = normalizeText(input?.model || 'htdemucs') || 'htdemucs'
  const stemVersion = normalizeText(input?.stemVersion || 'unknown') || 'unknown'
  const targetRate = normalizeTargetRate(input?.targetRate)
  return {
    listRootKey,
    filePathKey: resolvedFile.key,
    stemMode,
    model,
    stemVersion,
    targetRate
  }
}

export async function loadMixtapeStemWaveformCacheData(
  key: CacheLoadKey
): Promise<StemWaveformData | null | undefined> {
  const db = getLibraryDb()
  if (!db) return undefined
  const resolvedKey = resolveNormalizedKey(key)
  if (!resolvedKey) return undefined
  const sourceSignature = normalizeSourceSignature(key?.sourceSignature)
  if (!sourceSignature) return undefined
  try {
    const row = db
      .prepare(
        `SELECT cache_version, source_signature, meta_json, data
         FROM ${MIXTAPE_STEM_WAVEFORM_TABLE}
         WHERE list_root = ? AND file_path = ? AND stem_mode = ? AND model = ? AND stem_version = ? AND target_rate = ?`
      )
      .get(
        resolvedKey.listRootKey,
        resolvedKey.filePathKey,
        resolvedKey.stemMode,
        resolvedKey.model,
        resolvedKey.stemVersion,
        resolvedKey.targetRate
      )
    if (!row) return null
    const cacheVersion = Number(row?.cache_version)
    const rowSignature = normalizeSourceSignature(row?.source_signature)
    if (cacheVersion !== STEM_WAVEFORM_CACHE_VERSION || rowSignature !== sourceSignature) {
      await removeMixtapeStemWaveformCacheEntry(key)
      return null
    }
    const metaJson = typeof row?.meta_json === 'string' ? row.meta_json : ''
    const payload = Buffer.isBuffer(row?.data)
      ? row.data
      : row?.data instanceof Uint8Array
        ? Buffer.from(row.data)
        : null
    if (!metaJson || !payload || !payload.length) {
      await removeMixtapeStemWaveformCacheEntry(key)
      return null
    }
    const decoded = decodeStemWaveformData(metaJson, payload)
    if (!decoded) {
      await removeMixtapeStemWaveformCacheEntry(key)
      return null
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] mixtape stem waveform cache load failed', error)
    return undefined
  }
}

export async function upsertMixtapeStemWaveformCacheEntry(
  key: CacheLoadKey,
  data: StemWaveformData
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db) return false
  const resolvedKey = resolveNormalizedKey(key)
  if (!resolvedKey) return false
  const sourceSignature = normalizeSourceSignature(key?.sourceSignature)
  if (!sourceSignature) return false
  const encoded = encodeStemWaveformData(data)
  if (!encoded) return false
  try {
    db.prepare(
      `INSERT INTO ${MIXTAPE_STEM_WAVEFORM_TABLE}
       (list_root, file_path, stem_mode, model, stem_version, target_rate, source_signature, cache_version, updated_at_ms, meta_json, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(list_root, file_path, stem_mode, model, stem_version, target_rate) DO UPDATE SET
         source_signature = excluded.source_signature,
         cache_version = excluded.cache_version,
         updated_at_ms = excluded.updated_at_ms,
         meta_json = excluded.meta_json,
         data = excluded.data`
    ).run(
      resolvedKey.listRootKey,
      resolvedKey.filePathKey,
      resolvedKey.stemMode,
      resolvedKey.model,
      resolvedKey.stemVersion,
      resolvedKey.targetRate,
      sourceSignature,
      STEM_WAVEFORM_CACHE_VERSION,
      Date.now(),
      encoded.metaJson,
      encoded.payload
    )
    return true
  } catch (error) {
    log.error('[sqlite] mixtape stem waveform cache upsert failed', error)
    return false
  }
}

export async function removeMixtapeStemWaveformCacheEntry(key: CacheKey): Promise<boolean> {
  const db = getLibraryDb()
  if (!db) return false
  const resolvedKey = resolveNormalizedKey(key)
  if (!resolvedKey) return false
  try {
    db.prepare(
      `DELETE FROM ${MIXTAPE_STEM_WAVEFORM_TABLE}
       WHERE list_root = ? AND file_path = ? AND stem_mode = ? AND model = ? AND stem_version = ? AND target_rate = ?`
    ).run(
      resolvedKey.listRootKey,
      resolvedKey.filePathKey,
      resolvedKey.stemMode,
      resolvedKey.model,
      resolvedKey.stemVersion,
      resolvedKey.targetRate
    )
    return true
  } catch (error) {
    log.error('[sqlite] mixtape stem waveform cache delete failed', error)
    return false
  }
}

export async function removeMixtapeStemWaveformCacheByFilePath(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  try {
    db.prepare(
      `DELETE FROM ${MIXTAPE_STEM_WAVEFORM_TABLE} WHERE list_root = ? AND file_path = ?`
    ).run(listRootKey, resolvedFile.key)
    return true
  } catch (error) {
    log.error('[sqlite] mixtape stem waveform cache delete by file path failed', error)
    return false
  }
}

export async function clearMixtapeStemWaveformCache(listRoot: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  try {
    db.prepare(`DELETE FROM ${MIXTAPE_STEM_WAVEFORM_TABLE} WHERE list_root = ?`).run(
      resolvedRoot.key
    )
    return true
  } catch (error) {
    log.error('[sqlite] mixtape stem waveform cache clear failed', error)
    return false
  }
}
