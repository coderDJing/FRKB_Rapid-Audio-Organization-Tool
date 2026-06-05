import { deflateSync, inflateSync } from 'node:zlib'
import {
  COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
  COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
  type CompactVisualWaveformData
} from '../../shared/compactVisualWaveform'
import { getLibraryDb, isSqliteRow, type SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput,
  toNumber
} from './pathResolvers'
import { removeWaveformCacheEntry } from './waveformCache'

type CompactVisualWaveformMeta = {
  size: number
  mtimeMs: number
  cacheVersion: number
  parameterVersion: number
  duration: number
  detailRate: number
  overviewRate: number
  frameCount: number
}

type CompactVisualWaveformRow = {
  list_root?: string
  file_path?: string
  size?: unknown
  mtime_ms?: unknown
  cache_version?: unknown
  parameter_version?: unknown
  duration?: unknown
  detail_rate?: unknown
  overview_rate?: unknown
  frame_count?: unknown
  payload?: unknown
}

const TABLE = 'compact_visual_waveform_cache'
const MAGIC = 'CVW1'

const normalizeMeta = (row: unknown): CompactVisualWaveformMeta | null => {
  if (!isSqliteRow(row)) return null
  const size = toNumber(row.size)
  const mtimeMs = toNumber(row.mtime_ms)
  const cacheVersion = toNumber(row.cache_version)
  const parameterVersion = toNumber(row.parameter_version)
  const duration = toNumber(row.duration)
  const detailRate = toNumber(row.detail_rate)
  const overviewRate = toNumber(row.overview_rate)
  const frameCount = toNumber(row.frame_count)
  if (
    size === null ||
    mtimeMs === null ||
    cacheVersion === null ||
    parameterVersion === null ||
    duration === null ||
    detailRate === null ||
    overviewRate === null ||
    frameCount === null
  ) {
    return null
  }
  return {
    size,
    mtimeMs,
    cacheVersion,
    parameterVersion,
    duration,
    detailRate,
    overviewRate,
    frameCount
  }
}

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return null
}

const writeHeader = (payload: Buffer, header: Record<string, unknown>) => {
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(8)
  prefix.write(MAGIC, 0, 4, 'ascii')
  prefix.writeUInt32LE(headerBuffer.byteLength, 4)
  return deflateSync(Buffer.concat([prefix, headerBuffer, payload]))
}

const readPayload = (compressed: Buffer) => {
  const decoded = inflateSync(compressed)
  if (decoded.byteLength < 8 || decoded.subarray(0, 4).toString('ascii') !== MAGIC) return null
  const headerLength = decoded.readUInt32LE(4)
  const headerStart = 8
  const payloadStart = headerStart + headerLength
  if (headerLength <= 0 || payloadStart > decoded.byteLength) return null
  const header = JSON.parse(decoded.subarray(headerStart, payloadStart).toString('utf8')) as {
    sampleRate?: number
    bodyRateDivisor?: number
    colorRateDivisor?: number
    detailPeakTopLength?: number
    detailPeakBottomLength?: number
    detailBodyLength?: number
    colorIndexLength?: number
    colorLowLength?: number
    colorMidLength?: number
    colorHighLength?: number
    colorRedLength?: number
    colorGreenLength?: number
    colorBlueLength?: number
    overviewTopLength?: number
    overviewBottomLength?: number
  }
  let offset = payloadStart
  const readBytes = (length: unknown) => {
    const count = Math.max(0, Math.floor(Number(length) || 0))
    if (offset + count > decoded.byteLength) return null
    const result = new Uint8Array(decoded.subarray(offset, offset + count))
    offset += count
    return result
  }
  return { header, readBytes }
}

export function encodeCompactVisualWaveformData(data: CompactVisualWaveformData): Buffer | null {
  if (!data || data.version !== COMPACT_VISUAL_WAVEFORM_CACHE_VERSION) return null
  if (data.parameterVersion !== COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION) return null
  if (!data.detailPeakTop?.length || !data.detailPeakBottom?.length) return null
  if (!data.colorRed?.length || !data.colorGreen?.length || !data.colorBlue?.length) return null
  const payload = Buffer.concat([
    Buffer.from(data.detailPeakTop),
    Buffer.from(data.detailPeakBottom),
    Buffer.from(data.detailBody),
    Buffer.from(data.colorIndex),
    Buffer.from(data.colorLow),
    Buffer.from(data.colorMid),
    Buffer.from(data.colorHigh),
    Buffer.from(data.colorRed),
    Buffer.from(data.colorGreen),
    Buffer.from(data.colorBlue),
    Buffer.from(data.overviewTop),
    Buffer.from(data.overviewBottom)
  ])
  return writeHeader(payload, {
    sampleRate: data.sampleRate,
    bodyRateDivisor: data.bodyRateDivisor,
    colorRateDivisor: data.colorRateDivisor,
    detailPeakTopLength: data.detailPeakTop.length,
    detailPeakBottomLength: data.detailPeakBottom.length,
    detailBodyLength: data.detailBody.length,
    colorIndexLength: data.colorIndex.length,
    colorLowLength: data.colorLow.length,
    colorMidLength: data.colorMid.length,
    colorHighLength: data.colorHigh.length,
    colorRedLength: data.colorRed.length,
    colorGreenLength: data.colorGreen.length,
    colorBlueLength: data.colorBlue.length,
    overviewTopLength: data.overviewTop.length,
    overviewBottomLength: data.overviewBottom.length
  })
}

export function decodeCompactVisualWaveformData(
  meta: CompactVisualWaveformMeta,
  payload: Buffer
): CompactVisualWaveformData | null {
  if (!meta || !payload) return null
  if (
    meta.cacheVersion !== COMPACT_VISUAL_WAVEFORM_CACHE_VERSION ||
    meta.parameterVersion !== COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION
  ) {
    return null
  }
  const decoded = readPayload(payload)
  if (!decoded) return null
  const detailPeakTop = decoded.readBytes(decoded.header.detailPeakTopLength)
  const detailPeakBottom = decoded.readBytes(decoded.header.detailPeakBottomLength)
  const detailBody = decoded.readBytes(decoded.header.detailBodyLength)
  const colorIndex = decoded.readBytes(decoded.header.colorIndexLength)
  const colorLow = decoded.readBytes(
    decoded.header.colorLowLength ?? decoded.header.colorIndexLength
  )
  const colorMid = decoded.readBytes(
    decoded.header.colorMidLength ?? decoded.header.colorIndexLength
  )
  const colorHigh = decoded.readBytes(
    decoded.header.colorHighLength ?? decoded.header.colorIndexLength
  )
  const colorRed = decoded.readBytes(
    decoded.header.colorRedLength ?? decoded.header.colorIndexLength
  )
  const colorGreen = decoded.readBytes(
    decoded.header.colorGreenLength ?? decoded.header.colorIndexLength
  )
  const colorBlue = decoded.readBytes(
    decoded.header.colorBlueLength ?? decoded.header.colorIndexLength
  )
  const overviewTop = decoded.readBytes(decoded.header.overviewTopLength)
  const overviewBottom = decoded.readBytes(decoded.header.overviewBottomLength)
  if (
    !detailPeakTop ||
    !detailPeakBottom ||
    !detailBody ||
    !colorIndex ||
    !colorLow ||
    !colorMid ||
    !colorHigh ||
    !colorRed ||
    !colorGreen ||
    !colorBlue ||
    !overviewTop ||
    !overviewBottom
  ) {
    return null
  }
  return {
    version: meta.cacheVersion,
    parameterVersion: meta.parameterVersion,
    duration: meta.duration,
    sampleRate: Math.max(0, Number(decoded.header.sampleRate) || 0),
    detailRate: meta.detailRate,
    overviewRate: meta.overviewRate,
    bodyRateDivisor: Math.max(1, Number(decoded.header.bodyRateDivisor) || 1),
    colorRateDivisor: Math.max(1, Number(decoded.header.colorRateDivisor) || 1),
    detailPeakTop,
    detailPeakBottom,
    detailBody,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    overviewTop,
    overviewBottom
  }
}

const resolveCacheKeys = (listRoot: string, filePath: string) => {
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return null
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  return {
    listRootKey,
    fileKey: resolvedFile.key,
    fileKeyRaw: resolvedFile.keyRaw,
    legacyListRoot,
    legacyFilePath: resolvedFile.legacyAbs
  }
}

const loadRow = (
  listRoot: string,
  filePath: string
): { row: CompactVisualWaveformRow; hitListRoot: string; hitFilePath: string } | null => {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return null
  const stmt = db.prepare<CompactVisualWaveformRow>(
    `SELECT list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
            detail_rate, overview_rate, frame_count, payload
       FROM ${TABLE} WHERE list_root = ? AND file_path = ? LIMIT 1`
  )
  const candidates: Array<[string, string | undefined]> = [
    [keys.listRootKey, keys.fileKey],
    [keys.listRootKey, keys.fileKeyRaw],
    [keys.legacyListRoot || '', keys.legacyFilePath]
  ]
  for (const [root, file] of candidates) {
    if (!root || !file) continue
    const row = stmt.get(root, file)
    if (row?.payload !== undefined) {
      return { row, hitListRoot: root, hitFilePath: file }
    }
  }
  return null
}

export function migrateCompactVisualWaveformCacheRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<CompactVisualWaveformRow>(`SELECT file_path FROM ${TABLE} WHERE list_root = ?`)
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    const update = db.prepare(
      `UPDATE ${TABLE} SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?`
    )
    const deleteLegacyWaveform = db.prepare(
      'DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?'
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
        deleteLegacyWaveform.run(newListRootKey, newFileKey)
        deleteLegacyWaveform.run(oldListRoot, filePath)
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
}

export async function loadCompactVisualWaveformCacheData(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<CompactVisualWaveformData | null | undefined> {
  if (!listRoot || !filePath) return undefined
  try {
    const hit = loadRow(listRoot, filePath)
    if (!hit) return null
    const meta = normalizeMeta(hit.row)
    if (
      !meta ||
      meta.size !== stat.size ||
      Math.abs(meta.mtimeMs - stat.mtimeMs) > 1 ||
      meta.cacheVersion !== COMPACT_VISUAL_WAVEFORM_CACHE_VERSION ||
      meta.parameterVersion !== COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION
    ) {
      await removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const payload = toBuffer(hit.row.payload)
    if (!payload) {
      await removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      return null
    }
    const decoded = decodeCompactVisualWaveformData(meta, payload)
    if (!decoded) {
      await removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      return null
    }
    return decoded
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache load failed', error)
    return undefined
  }
}

export async function hasCompactVisualWaveformCacheEntryByMeta(
  listRoot: string,
  filePath: string,
  size: number,
  mtimeMs: number
): Promise<boolean> {
  if (!listRoot || !filePath) return false
  try {
    const hit = loadRow(listRoot, filePath)
    if (!hit) return false
    const meta = normalizeMeta(hit.row)
    if (
      !meta ||
      meta.size !== size ||
      Math.abs(meta.mtimeMs - mtimeMs) > 1 ||
      meta.cacheVersion !== COMPACT_VISUAL_WAVEFORM_CACHE_VERSION ||
      meta.parameterVersion !== COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION ||
      meta.frameCount <= 0
    ) {
      await removeCompactVisualWaveformCacheEntry(listRoot, filePath)
      return false
    }
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache check failed', error)
    return false
  }
}

export async function upsertCompactVisualWaveformCacheEntry(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number },
  data: CompactVisualWaveformData
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys || !data) return false
  const payload = encodeCompactVisualWaveformData(data)
  if (!payload) return false
  try {
    const upsertMain = db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
        detail_rate, overview_rate, frame_count, payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        parameter_version = excluded.parameter_version,
        duration = excluded.duration,
        detail_rate = excluded.detail_rate,
        overview_rate = excluded.overview_rate,
        frame_count = excluded.frame_count,
        payload = excluded.payload,
        updated_at_ms = excluded.updated_at_ms`
    )
    const deleteMain = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    db.transaction(() => {
      upsertMain.run(
        keys.listRootKey,
        keys.fileKey,
        stat.size,
        stat.mtimeMs,
        COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
        COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
        data.duration,
        data.detailRate,
        data.overviewRate,
        data.detailPeakTop.length,
        payload,
        Date.now()
      )
      if (keys.fileKeyRaw && keys.fileKeyRaw !== keys.fileKey) {
        deleteMain.run(keys.listRootKey, keys.fileKeyRaw)
      }
      if (keys.legacyListRoot && keys.legacyFilePath) {
        deleteMain.run(keys.legacyListRoot, keys.legacyFilePath)
      }
    })()
    await removeWaveformCacheEntry(listRoot, filePath)
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache upsert failed', error)
    return false
  }
}

export async function updateCompactVisualWaveformCacheStat(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return false
  try {
    const update = db.prepare(
      `UPDATE ${TABLE} SET size = ?, mtime_ms = ? WHERE list_root = ? AND file_path = ?`
    )
    update.run(stat.size, stat.mtimeMs, keys.listRootKey, keys.fileKey)
    if (keys.fileKeyRaw) update.run(stat.size, stat.mtimeMs, keys.listRootKey, keys.fileKeyRaw)
    if (keys.legacyListRoot && keys.legacyFilePath) {
      update.run(stat.size, stat.mtimeMs, keys.legacyListRoot, keys.legacyFilePath)
    }
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache stat update failed', error)
    return false
  }
}

export async function moveCompactVisualWaveformCacheEntry(
  listRoot: string,
  oldFilePath: string,
  newFilePath: string,
  stat?: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  const oldKeys = resolveCacheKeys(listRoot, oldFilePath)
  const newKeys = resolveCacheKeys(listRoot, newFilePath)
  if (!db || !oldKeys || !newKeys || oldFilePath === newFilePath) return false
  try {
    const hit = loadRow(listRoot, oldFilePath)
    if (!hit) return false
    const meta = normalizeMeta(hit.row)
    const payload = toBuffer(hit.row.payload)
    if (!meta || !payload) return false
    db.prepare(
      `INSERT INTO ${TABLE} (
        list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
        detail_rate, overview_rate, frame_count, payload, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(list_root, file_path) DO UPDATE SET
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        cache_version = excluded.cache_version,
        parameter_version = excluded.parameter_version,
        duration = excluded.duration,
        detail_rate = excluded.detail_rate,
        overview_rate = excluded.overview_rate,
        frame_count = excluded.frame_count,
        payload = excluded.payload,
        updated_at_ms = excluded.updated_at_ms`
    ).run(
      newKeys.listRootKey,
      newKeys.fileKey,
      stat?.size ?? meta.size,
      stat?.mtimeMs ?? meta.mtimeMs,
      meta.cacheVersion,
      meta.parameterVersion,
      meta.duration,
      meta.detailRate,
      meta.overviewRate,
      meta.frameCount,
      payload,
      Date.now()
    )
    db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`).run(
      hit.hitListRoot,
      hit.hitFilePath
    )
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache move failed', error)
    return false
  }
}

export async function removeCompactVisualWaveformCacheEntry(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return false
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    del.run(keys.listRootKey, keys.fileKey)
    if (keys.fileKeyRaw) {
      del.run(keys.listRootKey, keys.fileKeyRaw)
    }
    if (keys.legacyListRoot && keys.legacyFilePath) {
      del.run(keys.legacyListRoot, keys.legacyFilePath)
    }
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache delete failed', error)
    return false
  }
}
