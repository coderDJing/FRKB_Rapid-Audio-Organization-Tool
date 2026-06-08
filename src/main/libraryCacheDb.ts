export type { SongCacheEntry, CoverIndexEntry, LegacyCacheRoots } from './libraryCacheDb/types'

export { resolveCacheListRootAbs, resolveCacheFilePath } from './libraryCacheDb/pathResolvers'

export {
  loadSongCache,
  loadSongCacheEntry,
  updateSongCacheKey,
  updateSongCacheBpm,
  clearSongCacheAnalysisFields,
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

export { removeCompactVisualWaveformCacheEntry } from './libraryCacheDb/compactVisualWaveformCache'

export {
  loadUnifiedDisplayWaveformCacheData,
  hasUnifiedDisplayWaveformCacheEntryByMeta,
  upsertUnifiedDisplayWaveformCacheEntry,
  updateUnifiedDisplayWaveformCacheStat,
  moveUnifiedDisplayWaveformCacheEntry,
  removeUnifiedDisplayWaveformCacheEntry,
  migrateUnifiedDisplayWaveformCacheRows
} from './libraryCacheDb/unifiedDisplayWaveformCache'

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
  loadMixtapeStemWaveformCacheData,
  upsertMixtapeStemWaveformCacheEntry,
  removeMixtapeStemWaveformCacheEntry,
  removeMixtapeStemWaveformCacheByFilePath,
  clearMixtapeStemWaveformCache
} from './libraryCacheDb/mixtapeStemWaveformCache'

export {
  loadPioneerPreviewWaveformCacheEntry,
  upsertPioneerPreviewWaveformCacheEntry,
  clearPioneerPreviewWaveformCache
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
  loadExternalAnalysisWaveformCacheData,
  loadExternalAnalysisWaveformCacheDataByFilePath,
  upsertExternalAnalysisWaveformCacheEntry,
  removeExternalAnalysisWaveformCacheEntry,
  removeExternalAnalysisCacheEntry,
  clearExternalAnalysisCacheForSource,
  type ExternalAnalysisContext,
  type ExternalAnalysisSourceKind,
  type ExternalAnalysisCacheEntry
} from './libraryCacheDb/externalAnalysisCache'

export {
  renameCacheRoot,
  pruneCachesByRoots,
  migrateCacheKeysToRelativeIfNeeded,
  scheduleCacheKeyMigration,
  migrateLegacyCachesInLibrary,
  scanLegacyCacheRoots
} from './libraryCacheDb/maintenance'
