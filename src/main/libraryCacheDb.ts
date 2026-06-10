export type { SongCacheEntry, CoverIndexEntry, LegacyCacheRoots } from './libraryCacheDb/types'

export { resolveCacheListRootAbs, resolveCacheFilePath } from './libraryCacheDb/pathResolvers'

export {
  loadSongCache,
  loadSongCacheEntry,
  updateSongCacheKey,
  clearSongCacheAnalysisFields,
  replaceSongCache,
  upsertSongCacheEntry,
  removeSongCacheEntry
} from './libraryCacheDb/songCache'

export {
  loadCoverIndexEntry,
  upsertCoverIndexEntry,
  removeCoverIndexEntry,
  loadCoverIndexEntries,
  removeCoverIndexEntries,
  countCoverIndexByHash
} from './libraryCacheDb/coverIndex'

export { updateWaveformCacheStat, removeWaveformCacheEntry } from './libraryCacheDb/waveformCache'

export { removeCompactVisualWaveformCacheEntry } from './libraryCacheDb/compactVisualWaveformCache'

export {
  loadUnifiedDisplayWaveformCacheData,
  hasUnifiedDisplayWaveformCacheEntryByMeta,
  upsertUnifiedDisplayWaveformCacheEntry,
  updateUnifiedDisplayWaveformCacheStat,
  moveUnifiedDisplayWaveformCacheEntry,
  removeUnifiedDisplayWaveformCacheEntry
} from './libraryCacheDb/unifiedDisplayWaveformCache'

export {
  loadWaveformListPreviewCacheData,
  loadWaveformGlobalOverviewCacheData,
  hasWaveformSurfaceCacheEntryByMeta,
  upsertWaveformSurfaceCacheEntry,
  updateWaveformSurfaceCacheStat,
  moveWaveformSurfaceCacheEntry,
  removeWaveformSurfaceCacheEntry
} from './libraryCacheDb/waveformSurfaceCache'

export {
  loadMixtapeWaveformCacheData,
  upsertMixtapeWaveformCacheEntry,
  removeMixtapeWaveformCacheEntry
} from './libraryCacheDb/mixtapeWaveformCache'

export {
  loadMixtapeRawWaveformCacheData,
  upsertMixtapeRawWaveformCacheEntry,
  removeMixtapeRawWaveformCacheEntry
} from './libraryCacheDb/mixtapeRawWaveformCache'

export {
  loadMixtapeStemWaveformCacheData,
  upsertMixtapeStemWaveformCacheEntry,
  removeMixtapeStemWaveformCacheByFilePath
} from './libraryCacheDb/mixtapeStemWaveformCache'

export {
  loadPioneerPreviewWaveformCacheEntry,
  upsertPioneerPreviewWaveformCacheEntry
} from './libraryCacheDb/pioneerPreviewWaveformCache'

export {
  registerExternalAnalysisContext,
  resolveExternalAnalysisContext,
  unregisterExternalAnalysisContexts,
  touchExternalAnalysisDevice,
  pruneStaleExternalAnalysisDevices,
  pruneStaleExternalAnalysisCacheEntries,
  loadExternalAnalysisCacheEntry,
  loadExternalAnalysisCacheEntryByFilePath,
  touchExternalAnalysisCacheEntrySeen,
  upsertExternalAnalysisCacheEntry,
  upsertExternalAnalysisWaveformCacheEntry,
  removeExternalAnalysisCacheEntry,
  type ExternalAnalysisContext,
  type ExternalAnalysisSourceKind,
  type ExternalAnalysisCacheEntry
} from './libraryCacheDb/externalAnalysisCache'

export {
  renameCacheRoot,
  pruneCachesByRoots,
  scheduleCacheKeyMigration,
  migrateLegacyCachesInLibrary,
  scanLegacyCacheRoots
} from './libraryCacheDb/maintenance'
