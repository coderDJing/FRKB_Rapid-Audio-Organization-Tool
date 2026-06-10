#!/bin/bash

# 移除未使用的export关键字的脚本

# src/main/curatedArtistLibrary.ts
sed -i 's/^export type CuratedArtistFavoriteEntry/type CuratedArtistFavoriteEntry/' src/main/curatedArtistLibrary.ts

# src/main/databaseManifest.ts
sed -i 's/^export interface FrkbManifest/interface FrkbManifest/' src/main/databaseManifest.ts

# src/main/devInstance.ts
sed -i 's/^export const getDevInstanceId/const getDevInstanceId/' src/main/devInstance.ts

# src/main/ipc/horizontalBrowseTransportBridge.ts
sed -i 's/^export type HorizontalBrowseTransportDecodeDiagnostic/type HorizontalBrowseTransportDecodeDiagnostic/' src/main/ipc/horizontalBrowseTransportBridge.ts

# src/main/layoutConfig.ts
sed -i 's/^export function normalizeLayoutConfig/function normalizeLayoutConfig/' src/main/layoutConfig.ts

# src/main/libraryCacheDb/pioneerPreviewWaveformCache.ts
sed -i 's/^export type PioneerPreviewWaveformCacheEntry/type PioneerPreviewWaveformCacheEntry/' src/main/libraryCacheDb/pioneerPreviewWaveformCache.ts

# src/main/libraryCacheDb/waveformSurfaceCache.ts
sed -i 's/^export function encodeWaveformSurfacePayload/function encodeWaveformSurfacePayload/' src/main/libraryCacheDb/waveformSurfaceCache.ts
sed -i 's/^export function decodeWaveformSurfacePayload/function decodeWaveformSurfacePayload/' src/main/libraryCacheDb/waveformSurfaceCache.ts

# src/main/libraryDb.ts
sed -i 's/^export type SqliteRow/type SqliteRow/' src/main/libraryDb.ts
sed -i 's/^export function closeLibraryDb/function closeLibraryDb/' src/main/libraryDb.ts

# src/main/libraryTreeDbHelpers.ts
sed -i 's/^export function isNodeType/function isNodeType/' src/main/libraryTreeDbHelpers.ts

# src/main/log.ts
sed -i 's/^export function ensureLogConfigured/function ensureLogConfigured/' src/main/log.ts

# src/main/mixtapeDb.ts
sed -i 's/^export type MixtapeProjectStemConfig/type MixtapeProjectStemConfig/' src/main/mixtapeDb.ts

# src/main/mixtapeProjectTempoDb.ts
sed -i 's/^export type MixtapeProjectBpmPoint/type MixtapeProjectBpmPoint/' src/main/mixtapeProjectTempoDb.ts

# src/main/mixtapeStemDb.ts
sed -i 's/^export type MixtapeStemAssetRecord/type MixtapeStemAssetRecord/' src/main/mixtapeStemDb.ts

# src/main/platform/windowsContextMenu.ts
sed -i 's/^export async function ensureWindowsContextMenu/async function ensureWindowsContextMenu/' src/main/platform/windowsContextMenu.ts

# src/main/recordingLibraryService.ts
sed -i 's/^export async function ensureRecordingLibraryRoot/async function ensureRecordingLibraryRoot/' src/main/recordingLibraryService.ts
sed -i 's/^export async function listRecordingFiles/async function listRecordingFiles/' src/main/recordingLibraryService.ts

# src/main/recycleBinService.ts
sed -i 's/^export type RecycleBinSourceType/type RecycleBinSourceType/' src/main/recycleBinService.ts
sed -i 's/^export type RecycleBinMoveOptions/type RecycleBinMoveOptions/' src/main/recycleBinService.ts
sed -i 's/^export type RecycleBinRestoreResult/type RecycleBinRestoreResult/' src/main/recycleBinService.ts
sed -i 's/^export type MixtapeMissingResolveResult/type MixtapeMissingResolveResult/' src/main/recycleBinService.ts
sed -i 's/^export async function resolveOriginalPlaylistPathForFile/async function resolveOriginalPlaylistPathForFile/' src/main/recycleBinService.ts

# src/main/services/analysisRuntimeDownload.ts
sed -i 's/^export type AnalysisRuntimeDownloadInfo/type AnalysisRuntimeDownloadInfo/' src/main/services/analysisRuntimeDownload.ts

# src/main/services/audioDecodePool.ts
sed -i 's/^export type DecodeAudioMetrics/type DecodeAudioMetrics/' src/main/services/audioDecodePool.ts

# src/main/services/backgroundIdleGate.ts
sed -i 's/^export type BackgroundIdleSnapshot/type BackgroundIdleSnapshot/' src/main/services/backgroundIdleGate.ts

# src/main/services/backgroundOrchestrator.ts
sed -i 's/^export type BackgroundTaskCategory/type BackgroundTaskCategory/' src/main/services/backgroundOrchestrator.ts

# src/main/services/globalSongSearch.ts
sed -i 's/^export type GlobalSongSearchResultItem/type GlobalSongSearchResultItem/' src/main/services/globalSongSearch.ts
sed -i 's/^export type GlobalSongSearchQueryResult/type GlobalSongSearchQueryResult/' src/main/services/globalSongSearch.ts
sed -i 's/^export type PlaylistFastLoadResult/type PlaylistFastLoadResult/' src/main/services/globalSongSearch.ts

# src/main/services/keyAnalysis/types.ts
sed -i 's/^export type KeyAnalysisProgressStage/type KeyAnalysisProgressStage/' src/main/services/keyAnalysis/types.ts
sed -i 's/^export type KeyAnalysisJobTrace/type KeyAnalysisJobTrace/' src/main/services/keyAnalysis/types.ts
sed -i 's/^export type KeyAnalysisPrepareDetails/type KeyAnalysisPrepareDetails/' src/main/services/keyAnalysis/types.ts
sed -i 's/^export type KeyAnalysisWorkerPartialResult/type KeyAnalysisWorkerPartialResult/' src/main/services/keyAnalysis/types.ts
sed -i 's/^export type KeyAnalysisWorkerResult/type KeyAnalysisWorkerResult/' src/main/services/keyAnalysis/types.ts

# src/main/services/libraryStemAssetStorage.ts
sed -i 's/^export function toSafeStemPathSegment/function toSafeStemPathSegment/' src/main/services/libraryStemAssetStorage.ts

# src/main/services/manualMacUpdate.ts
sed -i 's/^export type ManualMacUpdateProgress/type ManualMacUpdateProgress/' src/main/services/manualMacUpdate.ts

# src/main/services/mixtapeStemQueue.ts
sed -i 's/^export type MixtapeStemEnqueueParams/type MixtapeStemEnqueueParams/' src/main/services/mixtapeStemQueue.ts
sed -i 's/^export type MixtapeStemRetryParams/type MixtapeStemRetryParams/' src/main/services/mixtapeStemQueue.ts
sed -i 's/^export type MixtapeStemEnqueueResult/type MixtapeStemEnqueueResult/' src/main/services/mixtapeStemQueue.ts

# src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_PROCESS_TIMEOUT_MS/const STEM_PROCESS_TIMEOUT_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_PROCESS_TIMEOUT_MAX_MS/const STEM_PROCESS_TIMEOUT_MAX_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_CPU_PROCESS_TIMEOUT_CAP_MS/const STEM_CPU_PROCESS_TIMEOUT_CAP_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_GPU_PROCESS_TIMEOUT_CAP_MS/const STEM_GPU_PROCESS_TIMEOUT_CAP_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_CPU_PROCESS_TIMEOUT_MIN_MS/const STEM_CPU_PROCESS_TIMEOUT_MIN_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_GPU_PROCESS_TIMEOUT_MIN_MS/const STEM_GPU_PROCESS_TIMEOUT_MIN_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const STEM_FFPROBE_TIMEOUT_MS/const STEM_FFPROBE_TIMEOUT_MS/' src/main/services/mixtapeStemSeparationShared.ts
sed -i 's/^export const DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS/const DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS/' src/main/services/mixtapeStemSeparationShared.ts

# src/main/services/mixtapeStemWaveformService.ts
sed -i 's/^export type MixtapeStemWaveformBundleResult/type MixtapeStemWaveformBundleResult/' src/main/services/mixtapeStemWaveformService.ts

# src/main/services/pioneerDeviceLibrary/playlistAnalysis.ts
sed -i 's/^export type PioneerPlaylistAnalysisPrepareResult/type PioneerPlaylistAnalysisPrepareResult/' src/main/services/pioneerDeviceLibrary/playlistAnalysis.ts

# src/main/services/pioneerDeviceLibrary/usbIdentity.ts
sed -i 's/^export type PioneerUsbIdentity/type PioneerUsbIdentity/' src/main/services/pioneerDeviceLibrary/usbIdentity.ts
# 移除重导出
sed -i '/^export { USB_ID_FILE_NAME }/d' src/main/services/pioneerDeviceLibrary/usbIdentity.ts

# src/main/services/playlistTrackNumbers.ts
sed -i 's/^export type PlaylistTrackNumberEnsureResult/type PlaylistTrackNumberEnsureResult/' src/main/services/playlistTrackNumbers.ts

# src/main/services/rekordboxXmlExport/fileStage.ts
sed -i 's/^export const resolveUniqueFilePath/const resolveUniqueFilePath/' src/main/services/rekordboxXmlExport/fileStage.ts

# src/main/services/rekordboxXmlExport/types.ts
sed -i 's/^export type RekordboxXmlExportProgressPayload/type RekordboxXmlExportProgressPayload/' src/main/services/rekordboxXmlExport/types.ts
sed -i 's/^export type RekordboxXmlExportProgressReporter/type RekordboxXmlExportProgressReporter/' src/main/services/rekordboxXmlExport/types.ts

# src/main/waveformCache.ts
sed -i 's/^export function getMixxxWaveformByteLength/function getMixxxWaveformByteLength/' src/main/waveformCache.ts

# src/main/workers/beatThisAnalyzer.ts
sed -i 's/^export const analyzeBeatGridWithBeatThisFromPcm/const analyzeBeatGridWithBeatThisFromPcm/' src/main/workers/beatThisAnalyzer.ts

# src/main/workers/beatThisRuntime.ts
sed -i 's/^export type BeatThisPythonCommand/type BeatThisPythonCommand/' src/main/workers/beatThisRuntime.ts
sed -i 's/^export type BeatThisComputeDevice/type BeatThisComputeDevice/' src/main/workers/beatThisRuntime.ts
sed -i 's/^export type BeatThisResolvedRuntime/type BeatThisResolvedRuntime/' src/main/workers/beatThisRuntime.ts

echo "Done applying export removals for src/main/"
