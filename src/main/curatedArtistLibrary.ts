import store from './store'
import { getLibraryDb, initLibraryDb, getMetaValue, isSqliteRow, setMetaValue } from './libraryDb'
import mainWindow from './window/mainWindow'
import { getSongsAnalyseResult } from './utils'
import { scanSongList } from './services/scanSongs'
import type { SqliteDatabase } from './libraryDb'
import { normalizeArtistName, splitArtistNames } from '../shared/artistNames'
import path = require('path')
import crypto = require('crypto')
import fs = require('fs-extra')

const META_KEY = 'curated_artist_library_v1'
const FINGERPRINT_REGEX = /^[a-f0-9]{64}$/i

type CuratedArtistFavoriteEntry = {
  name: string
  count: number
  fingerprints: string[]
}

export type CuratedArtistLibrarySnapshot = {
  artists: string[]
  items: CuratedArtistFavoriteEntry[]
  count: number
  totalCount: number
  fingerprintCount: number
  hash: string
}

function sanitizeArtistName(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function resolveArtistNames(value: unknown): string[] {
  return Array.from(new Set(splitArtistNames(value).map(sanitizeArtistName).filter(Boolean)))
}

function sanitizeArtistCount(value: unknown, fallback = 1): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.max(1, Math.round(numeric))
}

function sanitizeFingerprintList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set<string>()
  const fingerprints: string[] = []
  for (const item of value) {
    const fingerprint = String(item || '')
      .trim()
      .toLowerCase()
    if (!FINGERPRINT_REGEX.test(fingerprint) || seen.has(fingerprint)) continue
    seen.add(fingerprint)
    fingerprints.push(fingerprint)
  }
  fingerprints.sort()
  return fingerprints
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function calculateSnapshotHash(items: CuratedArtistFavoriteEntry[]): string {
  const canonical: Array<[string, number, string[]]> = items
    .map((item): [string, number, string[]] => [
      normalizeArtistName(item.name),
      Math.max(1, Math.round(Number(item.count) || 1)),
      sanitizeFingerprintList(item.fingerprints)
    ])
    .sort((left, right) => compareStableText(left[0], right[0]))
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

function normalizePathKey(value: unknown): string {
  const resolved = path.resolve(String(value || '').trim())
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizeFavoriteEntries(
  values: unknown[],
  options: { preserveFingerprintsFrom?: Map<string, string[]> } = {}
): CuratedArtistFavoriteEntry[] {
  const map = new Map<string, CuratedArtistFavoriteEntry>()

  for (const value of values) {
    const record = isSqliteRow(value) ? value : null
    const rawName =
      typeof value === 'string' ? value : typeof record?.name === 'string' ? record.name : ''
    const artistNames = resolveArtistNames(rawName)
    const rawFingerprints = record?.fingerprints
    const nextCount = sanitizeArtistCount(record?.count)

    for (const name of artistNames) {
      const normalized = normalizeArtistName(name)
      if (!normalized) continue

      const preserveFingerprints = options.preserveFingerprintsFrom?.get(normalized) || []
      const nextFingerprints = sanitizeFingerprintList(
        rawFingerprints,
        Array.isArray(rawFingerprints) ? [] : preserveFingerprints
      )
      const normalizedCount = Math.max(
        sanitizeArtistCount(nextCount, Math.max(nextFingerprints.length, 1)),
        nextFingerprints.length,
        1
      )
      const existing = map.get(normalized)

      if (existing) {
        existing.count += normalizedCount
        existing.fingerprints = Array.from(
          new Set([...existing.fingerprints, ...nextFingerprints])
        ).sort()
        existing.count = Math.max(existing.count, existing.fingerprints.length, 1)
        continue
      }

      map.set(normalized, {
        name,
        count: normalizedCount,
        fingerprints: nextFingerprints
      })
    }
  }

  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function countArtistOccurrences(values: unknown[]): CuratedArtistFavoriteEntry[] {
  const map = new Map<string, CuratedArtistFavoriteEntry>()
  for (const value of values) {
    for (const name of resolveArtistNames(value)) {
      const normalized = normalizeArtistName(name)
      if (!normalized) continue
      const existing = map.get(normalized)
      if (existing) {
        existing.count += 1
        continue
      }
      map.set(normalized, { name, count: 1, fingerprints: [] })
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function mergeFavoriteEntries(
  base: CuratedArtistFavoriteEntry[],
  incoming: CuratedArtistFavoriteEntry[]
): CuratedArtistFavoriteEntry[] {
  const merged = new Map<string, CuratedArtistFavoriteEntry>()
  for (const entry of normalizeFavoriteEntries(base)) {
    merged.set(normalizeArtistName(entry.name), { ...entry })
  }
  for (const entry of normalizeFavoriteEntries(incoming)) {
    const normalized = normalizeArtistName(entry.name)
    const existing = merged.get(normalized)
    if (existing) {
      existing.count += entry.count
      existing.fingerprints = Array.from(
        new Set([...existing.fingerprints, ...entry.fingerprints])
      ).sort()
      existing.count = Math.max(
        existing.count,
        existing.fingerprints.length,
        entry.fingerprints.length
      )
      continue
    }
    merged.set(normalized, { ...entry })
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function parseStoredArtists(raw: string | null | undefined): CuratedArtistFavoriteEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return normalizeFavoriteEntries(parsed)
    }
  } catch {}
  return countArtistOccurrences(String(raw).split('\n'))
}

function getDbForCurrentLibrary(): SqliteDatabase | null {
  const root = store.databaseDir
  if (!root) return getLibraryDb()
  return initLibraryDb(root)
}

function readCurrentArtists(db?: SqliteDatabase | null): CuratedArtistFavoriteEntry[] {
  const database = db || getDbForCurrentLibrary()
  if (!database) return []
  try {
    return parseStoredArtists(getMetaValue(database, META_KEY))
  } catch {
    return []
  }
}

function writeCurrentArtists(
  artists: CuratedArtistFavoriteEntry[],
  db?: SqliteDatabase | null
): void {
  const database = db || getDbForCurrentLibrary()
  if (!database) return
  setMetaValue(database, META_KEY, JSON.stringify(normalizeFavoriteEntries(artists)))
}

function createSnapshot(artists: CuratedArtistFavoriteEntry[]): CuratedArtistLibrarySnapshot {
  const normalized = normalizeFavoriteEntries(artists)
  return {
    artists: normalized.map((item) => item.name),
    items: normalized,
    count: normalized.length,
    totalCount: normalized.reduce((sum, item) => sum + item.count, 0),
    fingerprintCount: normalized.reduce((sum, item) => sum + item.fingerprints.length, 0),
    hash: calculateSnapshotHash(normalized)
  }
}

function isSameSnapshot(
  left: CuratedArtistLibrarySnapshot,
  right: CuratedArtistLibrarySnapshot
): boolean {
  return left.count === right.count && left.hash === right.hash
}

function broadcastSnapshot(snapshot: CuratedArtistLibrarySnapshot): void {
  try {
    mainWindow.instance?.webContents.send('curated-artists-updated', snapshot)
  } catch {}
}

async function collectArtistCountsFromTargetPaths(
  targetPaths: string[],
  options: { onAnalyseProgress?: (processed: number, total: number) => void } = {}
): Promise<Map<string, CuratedArtistFavoriteEntry[]>> {
  const validPaths = Array.from(
    new Set(targetPaths.map((item) => String(item || '').trim()).filter((item) => item.length > 0))
  )
  if (!validPaths.length) return new Map()

  try {
    const reportAnalyseProgress =
      typeof options.onAnalyseProgress === 'function'
        ? (processed: unknown) => {
            const done = Number(processed)
            if (Number.isFinite(done)) {
              options.onAnalyseProgress?.(Math.max(0, done), validPaths.length)
            }
          }
        : () => {}
    const [scanResult, analyseResult] = await Promise.all([
      scanSongList(
        validPaths,
        Array.isArray(store.settingConfig?.audioExt) ? store.settingConfig.audioExt : [],
        '',
        { enablePostScanTasks: false }
      ),
      getSongsAnalyseResult(validPaths, reportAnalyseProgress)
    ])

    const fingerprintMap = new Map<string, string>()
    for (const item of analyseResult.songsAnalyseResult || []) {
      const fingerprint = String(item?.sha256_Hash || '')
        .trim()
        .toLowerCase()
      const filePath = String(item?.file_path || '').trim()
      if (!filePath || !FINGERPRINT_REGEX.test(fingerprint)) continue
      fingerprintMap.set(normalizePathKey(filePath), fingerprint)
    }

    const artistMap = new Map<string, CuratedArtistFavoriteEntry[]>()
    for (const song of scanResult.scanData || []) {
      const filePath = String(song?.filePath || '').trim()
      const artistNames = resolveArtistNames(song?.artist)
      if (!filePath || artistNames.length === 0) continue

      const fingerprint = fingerprintMap.get(normalizePathKey(filePath))
      artistMap.set(
        normalizePathKey(filePath),
        artistNames.map((name) => ({
          name,
          count: 1,
          fingerprints: fingerprint ? [fingerprint] : []
        }))
      )
    }

    return artistMap
  } catch {
    return new Map()
  }
}

export function getCuratedArtistLibrarySnapshot(): CuratedArtistLibrarySnapshot {
  return createSnapshot(readCurrentArtists())
}

export type CuratedArtistImportProgress = {
  stage: 'scan' | 'fingerprint'
  processed: number
  total: number
}

export type CuratedArtistImportResult = CuratedArtistLibrarySnapshot & {
  importedTrackCount: number
  fingerprintedTrackCount: number
  artistOnlyTrackCount: number
}

type ApplyCuratedTracksOptions = {
  onProgress?: (progress: CuratedArtistImportProgress) => void
}

function reportCuratedImportProgress(
  options: { onProgress?: (progress: CuratedArtistImportProgress) => void },
  progress: CuratedArtistImportProgress
): void {
  if (typeof options.onProgress !== 'function') return
  if (progress.total <= 0 || progress.processed <= 0 || progress.processed >= progress.total) {
    options.onProgress(progress)
    return
  }
  if (progress.processed % 25 === 0) {
    options.onProgress(progress)
  }
}

// 共享内部实现：被 rememberCuratedArtistsForAddedTracks（复制到精选库时的被动追踪）
// 与 importCuratedArtistsFromTracks（主动从外部库导入）共用。
// 注意：tracks[].targetPath 是内部约定字段——表示"用于扫描算指纹的本机路径"。
// 被动追踪场景它是复制后的目标路径；导入场景由 importCuratedArtistsFromTracks
// 从对外的 filePath 转换而来（且仅传入文件确实存在的路径）。
async function applyCuratedTracksInternal(
  payload: {
    artistNames?: unknown[]
    targetPaths?: string[]
    tracks?: Array<{
      artistName?: unknown
      targetPath?: unknown
    }>
  },
  options: ApplyCuratedTracksOptions = {}
): Promise<{
  snapshot: CuratedArtistLibrarySnapshot
  changed: boolean
  scannedArtistsByPath: Map<string, CuratedArtistFavoriteEntry[]>
}> {
  const current = readCurrentArtists()
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  const explicitTargetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths : []
  const trackTargetPaths = tracks
    .map((item) => String(item?.targetPath || '').trim())
    .filter((item) => item.length > 0)
  const scannedArtistsByPath = await collectArtistCountsFromTargetPaths(
    [...explicitTargetPaths, ...trackTargetPaths],
    {
      onAnalyseProgress: options.onProgress
        ? (processed, total) => options.onProgress?.({ stage: 'fingerprint', processed, total })
        : undefined
    }
  )
  const incomingEntries: CuratedArtistFavoriteEntry[] = []

  if (tracks.length > 0) {
    const consumedPaths = new Set<string>()
    for (const track of tracks) {
      const targetPath = String(track?.targetPath || '').trim()
      const pathKey = targetPath ? normalizePathKey(targetPath) : ''
      const scannedEntries = pathKey ? scannedArtistsByPath.get(pathKey) : null
      if (Array.isArray(scannedEntries) && scannedEntries.length > 0) {
        incomingEntries.push(...scannedEntries)
        consumedPaths.add(pathKey)
        continue
      }

      incomingEntries.push(
        ...countArtistOccurrences([track?.artistName]).map((item) => ({
          ...item,
          fingerprints: []
        }))
      )
    }

    for (const [pathKey, entries] of scannedArtistsByPath.entries()) {
      if (consumedPaths.has(pathKey)) continue
      incomingEntries.push(...entries)
    }
  } else {
    const hintedArtists = countArtistOccurrences(
      Array.isArray(payload.artistNames) ? payload.artistNames : []
    )
    incomingEntries.push(...hintedArtists)
    for (const entries of scannedArtistsByPath.values()) {
      incomingEntries.push(...entries)
    }
  }

  const snapshot = createSnapshot(mergeFavoriteEntries(current, incomingEntries))
  const previous = createSnapshot(current)
  if (isSameSnapshot(snapshot, previous)) {
    return { snapshot: previous, changed: false, scannedArtistsByPath }
  }
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return { snapshot, changed: true, scannedArtistsByPath }
}

export async function rememberCuratedArtistsForAddedTracks(payload: {
  artistNames?: unknown[]
  targetPaths?: string[]
  tracks?: Array<{
    artistName?: unknown
    targetPath?: unknown
  }>
}): Promise<CuratedArtistLibrarySnapshot> {
  if (store.settingConfig?.enableCuratedArtistTracking === false) {
    return getCuratedArtistLibrarySnapshot()
  }

  const { snapshot } = await applyCuratedTracksInternal(payload)
  return snapshot
}

export async function importCuratedArtistsFromTracks(
  payload: {
    tracks?: Array<{
      artistName?: unknown
      filePath?: unknown
    }>
  },
  options: { onProgress?: (progress: CuratedArtistImportProgress) => void } = {}
): Promise<CuratedArtistImportResult> {
  const rawTracks = Array.isArray(payload?.tracks) ? payload.tracks : []

  // 1. 把 filePath 映射为内部 targetPath，并按规范化路径去重
  //    （同一首歌跨多个播放列表只算一次，避免遍历叶子歌单导致的重复计数）
  const dedupedByPath = new Map<string, { artistName?: unknown; filePath: string }>()
  const pathlessTracks: Array<{ artistName?: unknown; targetPath: string }> = []
  for (const track of rawTracks) {
    const filePath = String(track?.filePath || '').trim()
    if (!filePath) {
      // 没有路径但有艺人名的轨道仍计入（纯元数据来源）
      if (resolveArtistNames(track?.artistName).length > 0) {
        pathlessTracks.push({ artistName: track?.artistName, targetPath: '' })
      }
      continue
    }
    const pathKey = normalizePathKey(filePath)
    if (dedupedByPath.has(pathKey)) continue
    dedupedByPath.set(pathKey, { artistName: track?.artistName, filePath })
  }

  // 2. 预先检查文件是否存在（指纹策略 A）：
  //    存在 → 保留 targetPath 交给扫描算 SHA256；不存在 → 清空 targetPath 仅记艺人名。
  //    这一步也保护底层 scanSongList——它对不存在路径会 fs.stat 抛错，
  //    一个坏路径会让整批扫描结果丢失，因此必须在传入前过滤掉。
  const dedupedEntries = [...dedupedByPath.values()]
  let checkedPathCount = 0
  if (dedupedEntries.length > 0) {
    reportCuratedImportProgress(options, {
      stage: 'scan',
      processed: 0,
      total: dedupedEntries.length
    })
  }
  const existsFlags = await Promise.all(
    dedupedEntries.map(async ({ filePath }) => {
      try {
        return await fs.pathExists(filePath)
      } catch {
        return false
      } finally {
        checkedPathCount += 1
        reportCuratedImportProgress(options, {
          stage: 'scan',
          processed: checkedPathCount,
          total: dedupedEntries.length
        })
      }
    })
  )

  const reachableTracks: Array<{ artistName?: unknown; targetPath: string }> = []
  const reachablePathKeys = new Set<string>()
  const unreachableTracks: Array<{ artistName?: unknown; targetPath: string }> = []
  dedupedEntries.forEach((entry, index) => {
    if (existsFlags[index]) {
      reachableTracks.push({ artistName: entry.artistName, targetPath: entry.filePath })
      reachablePathKeys.add(normalizePathKey(entry.filePath))
    } else {
      unreachableTracks.push({ artistName: entry.artistName, targetPath: '' })
    }
  })

  const tracks = [...reachableTracks, ...unreachableTracks, ...pathlessTracks]
  const importedTrackCount = tracks.length

  const { snapshot, scannedArtistsByPath } = await applyCuratedTracksInternal(
    { tracks },
    { onProgress: options.onProgress }
  )

  // 3. 统计指纹覆盖：在"文件可达"的轨道里，真正算出了 sha256 的数量
  //    （文件存在但元数据无艺人/解析失败的，不计入指纹数）
  let fingerprintedTrackCount = 0
  for (const pathKey of reachablePathKeys) {
    const entries = scannedArtistsByPath.get(pathKey)
    if (Array.isArray(entries) && entries.some((entry) => entry.fingerprints.length > 0)) {
      fingerprintedTrackCount += 1
    }
  }

  return {
    ...snapshot,
    importedTrackCount,
    fingerprintedTrackCount,
    artistOnlyTrackCount: Math.max(0, importedTrackCount - fingerprintedTrackCount)
  }
}

export function removeCuratedArtist(artistName: unknown): CuratedArtistLibrarySnapshot {
  const normalizedTarget = normalizeArtistName(artistName)
  const current = readCurrentArtists()
  const next = normalizedTarget
    ? current.filter((item) => normalizeArtistName(item.name) !== normalizedTarget)
    : current
  const snapshot = createSnapshot(next)
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return snapshot
}

export function clearCuratedArtistLibrary(): CuratedArtistLibrarySnapshot {
  const snapshot = createSnapshot([])
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return snapshot
}

export function replaceCuratedArtistLibrary(artists: unknown[]): CuratedArtistLibrarySnapshot {
  const current = readCurrentArtists()
  const preserveFingerprintsFrom = new Map(
    current.map((item) => [normalizeArtistName(item.name), item.fingerprints])
  )
  const snapshot = createSnapshot(
    normalizeFavoriteEntries(Array.isArray(artists) ? artists : [], {
      preserveFingerprintsFrom
    })
  )
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return snapshot
}
