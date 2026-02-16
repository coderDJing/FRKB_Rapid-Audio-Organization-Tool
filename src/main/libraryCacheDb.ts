export type { SongCacheEntry, CoverIndexEntry, LegacyCacheRoots } from './libraryCacheDb/types'

export { resolveCacheListRootAbs, resolveCacheFilePath } from './libraryCacheDb/pathResolvers'

export {
  loadSongCache,
  loadSongCacheEntry,
  updateSongCacheKey,
  updateSongCacheBpm,
  replaceSongCache,
  upsertSongCacheEntry,
  clearSongCache,
  removeSongCacheEntry
} from './libraryCacheDb/songCache'

export {
  loadCoverIndexEntry,
  upsertCoverIndexEntry,
  removeCoverIndexEntry,
  loadCoverIndexEntries,
  removeCoverIndexEntries,
  clearCoverIndex,
  countCoverIndexByHash
} from './libraryCacheDb/coverIndex'

export {
  loadWaveformCacheData,
  hasWaveformCacheEntry,
  hasWaveformCacheEntryByMeta,
  upsertWaveformCacheEntry,
  moveWaveformCacheEntry,
  updateWaveformCacheStat,
  removeWaveformCacheEntry,
  clearWaveformCache
} from './libraryCacheDb/waveformCache'

export {
  loadMixtapeWaveformCacheData,
  upsertMixtapeWaveformCacheEntry,
  removeMixtapeWaveformCacheEntry,
  clearMixtapeWaveformCache
} from './libraryCacheDb/mixtapeWaveformCache'

export {
  loadMixtapeRawWaveformCacheData,
  upsertMixtapeRawWaveformCacheEntry,
  removeMixtapeRawWaveformCacheEntry,
  clearMixtapeRawWaveformCache
} from './libraryCacheDb/mixtapeRawWaveformCache'

export {
  loadMixtapeWaveformHiresCacheData,
  upsertMixtapeWaveformHiresCacheEntry,
  removeMixtapeWaveformHiresCacheEntry,
  clearMixtapeWaveformHiresCache
} from './libraryCacheDb/mixtapeWaveformHiresCache'

export {
  renameCacheRoot,
  pruneCachesByRoots,
  migrateCacheKeysToRelativeIfNeeded,
  scheduleCacheKeyMigration,
  migrateLegacyCachesInLibrary,
  scanLegacyCacheRoots
} from './libraryCacheDb/maintenance'
