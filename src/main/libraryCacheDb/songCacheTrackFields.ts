import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import { ensureSongCacheMigrated, getLooseSongCacheRoots } from './songCache'
import { readSongCacheTrackFieldsOffMainThread } from '../services/songCacheReadWorker'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { normalizePlaylistTrackNumber } from '../services/playlistTrackNumbers'
import {
  resolveAbsoluteFilePath,
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput
} from './pathResolvers'
import type { SongCacheTrackFieldRow } from './songCacheRead'

export type SongCacheTrackFields = {
  trackNumber: number | null
  addedAtMs: number | null
}

const toFields = (row: SongCacheTrackFieldRow): SongCacheTrackFields => ({
  trackNumber: normalizePlaylistTrackNumber(row.track_number) ?? null,
  addedAtMs: normalizeAddedAtMs(row.added_at_ms) ?? null
})

/**
 * 精选库对账只需要曲序和加入时间。按歌单读这两个字段。
 * 当前根目录没有行时，只对大小写或斜杠不同的旧根目录再读一次这两个字段，不再整份解析歌曲 JSON。
 */
export async function loadSongCacheTrackFields(
  listRoot: string
): Promise<Map<string, SongCacheTrackFields> | null> {
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
  await ensureSongCacheMigrated(db, listRoot)
  if (getLibraryDb() !== db) return null
  const loaded = new Map<string, SongCacheTrackFields>()
  const append = (rows: SongCacheTrackFieldRow[], rootKey: string, legacyRelRoot?: string) => {
    for (const row of rows) {
      if (!row?.file_path) continue
      let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
      if (legacyRelRoot) {
        const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
        if (resolvedLegacy?.isRelativeKey) {
          absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
        }
      }
      if (!absFilePath) continue
      loaded.set(absFilePath, toFields(row))
    }
  }
  let rows: SongCacheTrackFieldRow[] = []
  let legacyRows: SongCacheTrackFieldRow[] = []
  try {
    const loadedRows = await readSongCacheTrackFieldsOffMainThread(
      db,
      legacyListRoot ? [listRootKey, legacyListRoot] : [listRootKey]
    )
    rows = loadedRows[0] || []
    legacyRows = loadedRows[1] || []
  } catch (error) {
    log.error('[sqlite] song cache track fields failed', error)
    return null
  }
  if (getLibraryDb() !== db) return null
  append(rows, listRootKey)
  if (legacyRows.length > 0 && legacyListRoot && listRootAbs) {
    append(legacyRows, legacyListRoot, legacyListRoot)
  }
  if (rows.length > 0 || legacyRows.length > 0 || !listRootAbs) return loaded
  // getLooseSongCacheRoots 会记住这次全表扫描。空歌单之后的对账只命中内存，不再每次重扫。
  const looseRoots = getLooseSongCacheRoots(
    db,
    [listRoot, listRootAbs, listRootKey],
    listRootKey
  ).filter((root) => root !== listRootKey && root !== legacyListRoot)
  if (looseRoots.length === 0 || getLibraryDb() !== db) return loaded
  try {
    const extraBatches = await readSongCacheTrackFieldsOffMainThread(db, looseRoots)
    if (getLibraryDb() !== db) return null
    for (const [index, root] of looseRoots.entries()) {
      const extraRows = extraBatches[index]
      if (extraRows && extraRows.length > 0) append(extraRows, root, listRootAbs)
    }
  } catch (error) {
    log.error('[sqlite] song cache track fields failed', error)
  }
  return loaded
}
