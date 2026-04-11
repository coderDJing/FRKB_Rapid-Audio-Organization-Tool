import store from './store'
import { getLibraryDb, initLibraryDb, getMetaValue, isSqliteRow, setMetaValue } from './libraryDb'
import mainWindow from './window/mainWindow'
import { scanSongList } from './services/scanSongs'
import type { SqliteDatabase } from './libraryDb'

const META_KEY = 'curated_artist_library_v1'

export type CuratedArtistFavoriteEntry = {
  name: string
  count: number
}

export type CuratedArtistLibrarySnapshot = {
  artists: string[]
  items: CuratedArtistFavoriteEntry[]
  count: number
}

function normalizeArtistName(value: unknown): string {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
  return text ? text.toLocaleLowerCase() : ''
}

function sanitizeArtistName(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function sanitizeArtistCount(value: unknown, fallback = 1): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.max(1, Math.round(numeric))
}

function normalizeFavoriteEntries(values: unknown[]): CuratedArtistFavoriteEntry[] {
  const map = new Map<string, CuratedArtistFavoriteEntry>()
  for (const value of values) {
    const record = isSqliteRow(value) ? value : null
    const rawName =
      typeof value === 'string' ? value : typeof record?.name === 'string' ? record.name : ''
    const name = sanitizeArtistName(rawName)
    const normalized = normalizeArtistName(name)
    if (!normalized) continue
    const nextCount = sanitizeArtistCount(record?.count)
    const existing = map.get(normalized)
    if (existing) {
      existing.count += nextCount
      continue
    }
    map.set(normalized, { name, count: nextCount })
  }
  return [...map.values()]
}

function countArtistOccurrences(values: unknown[]): CuratedArtistFavoriteEntry[] {
  const map = new Map<string, CuratedArtistFavoriteEntry>()
  for (const value of values) {
    const name = sanitizeArtistName(value)
    const normalized = normalizeArtistName(name)
    if (!normalized) continue
    const existing = map.get(normalized)
    if (existing) {
      existing.count += 1
      continue
    }
    map.set(normalized, { name, count: 1 })
  }
  return [...map.values()]
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
      continue
    }
    merged.set(normalized, { ...entry })
  }
  return [...merged.values()]
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
    count: normalized.length
  }
}

function isSameSnapshot(
  left: CuratedArtistLibrarySnapshot,
  right: CuratedArtistLibrarySnapshot
): boolean {
  if (left.items.length !== right.items.length) return false
  return left.items.every((item, index) => {
    const next = right.items[index]
    return next && item.name === next.name && item.count === next.count
  })
}

function broadcastSnapshot(snapshot: CuratedArtistLibrarySnapshot): void {
  try {
    mainWindow.instance?.webContents.send('curated-artists-updated', snapshot)
  } catch {}
}

async function collectArtistCountsFromTargetPaths(
  targetPaths: string[]
): Promise<CuratedArtistFavoriteEntry[]> {
  const validPaths = Array.from(
    new Set(targetPaths.map((item) => String(item || '').trim()).filter((item) => item.length > 0))
  )
  if (!validPaths.length) return []
  try {
    const result = await scanSongList(
      validPaths,
      Array.isArray(store.settingConfig?.audioExt) ? store.settingConfig.audioExt : [],
      '',
      { enablePostScanTasks: false }
    )
    return countArtistOccurrences(result.scanData.map((song) => song.artist))
  } catch {
    return []
  }
}

export function getCuratedArtistLibrarySnapshot(): CuratedArtistLibrarySnapshot {
  return createSnapshot(readCurrentArtists())
}

export async function rememberCuratedArtistsForAddedTracks(payload: {
  artistNames?: unknown[]
  targetPaths?: string[]
}): Promise<CuratedArtistLibrarySnapshot> {
  if (store.settingConfig?.enableCuratedArtistTracking === false) {
    return getCuratedArtistLibrarySnapshot()
  }

  const current = readCurrentArtists()
  const hintedArtists = countArtistOccurrences(
    Array.isArray(payload.artistNames) ? payload.artistNames : []
  )
  const scannedArtists = await collectArtistCountsFromTargetPaths(payload.targetPaths || [])
  const snapshot = createSnapshot(
    mergeFavoriteEntries(current, [...hintedArtists, ...scannedArtists])
  )
  const previous = createSnapshot(current)
  if (isSameSnapshot(snapshot, previous)) return previous
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return snapshot
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
  const snapshot = createSnapshot(normalizeFavoriteEntries(Array.isArray(artists) ? artists : []))
  writeCurrentArtists(snapshot.items)
  broadcastSnapshot(snapshot)
  return snapshot
}
