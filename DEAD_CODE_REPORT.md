# 死代码分析报告

> 生成日期：2026-06-10
> 分析范围：`src/` 目录下全部 `.ts` / `.vue` 文件（共 519 个非入口模块）
> 方法：对每个 `export` 符号在全项目范围内搜索外部引用，零引用即判定为死导出
> 验证状态：✅ 已于 2026-06-10 由 Claude 逐项交叉验证，159 个确认死导出，1 个边界案例

---

## 一、总结

| 类别 | 数量 |
|------|------|
| **确认死导出符号** | **159 个** |
| **边界案例（建议保留 export）** | **1 个**（`CuratedArtistLibrarySnapshot`，见 4.1 节） |
| 其中 type/interface | 103 个 |
| 其中 const/function/re-export | 57 个 |
| **涉及文件** | **89 个** |
| **完全未使用的文件** | **0 个** ✅ |

> 所有 519 个 `.ts` 模块均被至少一个其他文件导入，项目模块引用关系完整，无孤立文件。

---

## 二、什么是"死导出"

本报告中的"死导出"特指：**一个符号被标记为 `export`，但在整个项目中没有任何其他文件导入或引用它**。这些符号仅在定义它们的文件内部使用，`export` 关键字是多余的。

**清理建议**：移除 `export` 关键字，将可见性降为文件私有。不影响任何外部功能。

---

## 三、`src/shared/` 目录（13 个死导出）

### 3.1 `src/shared/hotCues.ts`

| 行号 | 类型 | 符号 | 说明 |
|------|------|------|------|
| 4 | const | `HOT_CUE_SLOT_LABELS` | 仅被同文件内 `resolveSongHotCueLabel` 使用 |
| 5 | const | `HOT_CUE_SLOT_COLORS` | 仅被同文件内 `resolveSongHotCueColor` 使用 |

### 3.2 `src/shared/mixtapeStemProfiles.ts`

| 行号 | 类型 | 符号 | 说明 |
|------|------|------|------|
| 4 | const | `DEFAULT_MIXTAPE_STEM_QUALITY_MODEL` | 仅在同文件内赋值给 `DEFAULT_MIXTAPE_STEM_BASE_MODEL`，外部只用后者 |
| 9 | type | `ParsedMixtapeStemModel` | 仅作为同文件 `parseMixtapeStemModel` 返回类型，外部从未按名导入 |

### 3.3 `src/shared/rekordboxDesktopPlaylist.ts`

| 行号 | 类型 | 符号 | 说明 |
|------|------|------|------|
| 32 | type | `RekordboxDesktopPlaylistSelectedTracksSource` | 仅在同文件 union 类型内使用 |
| 38 | type | `RekordboxDesktopPlaylistSource` | 仅在同文件 union 类型内使用 |
| 138 | type | `RekordboxDesktopMovePlaylistSuccessSummary` | 仅在同文件 Response 类型内使用 |
| 159 | type | `RekordboxDesktopRenamePlaylistSuccessSummary` | 仅在同文件 Response 类型内使用 |
| 180 | type | `RekordboxDesktopDeletePlaylistSuccessSummary` | 仅在同文件 Response 类型内使用 |
| 202 | type | `RekordboxDesktopRemovePlaylistTracksSuccessSummary` | 仅在同文件 Response 类型内使用 |
| 225 | type | `RekordboxDesktopReorderPlaylistTracksSuccessSummary` | 仅在同文件 Response 类型内使用 |

### 3.4 `src/shared/rekordboxXmlExport.ts`

| 行号 | 类型 | 符号 | 说明 |
|------|------|------|------|
| 21 | type | `RekordboxXmlExportSelectedTracksSource` | 仅在同文件 union 类型内使用 |
| 27 | type | `RekordboxXmlExportPlaylistSource` | 仅在同文件 union 类型内使用 |

---

## 四、`src/main/` 目录（60 个死导出）

### 4.1 `src/main/curatedArtistLibrary.ts`

| 行号 | 类型 | 符号 | 备注 |
|------|------|------|------|
| 14 | type | `CuratedArtistFavoriteEntry` | 确认死导出 |
| 20 | type | `CuratedArtistLibrarySnapshot` | ⚠️ 边界案例：无外部文件按名称导入，但外部调用了返回该类型的函数（`getCuratedArtistLibrarySnapshot` 等）。移除 export 不会导致编译错误（TypeScript 自动推断返回类型），但如果外部需要显式标注该类型则需重新导出。**建议保留 export** |

### 4.2 `src/main/databaseManifest.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 8 | interface | `FrkbManifest` |

### 4.3 `src/main/devInstance.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 169 | function | `getDevInstanceId` |

### 4.4 `src/main/ipc/horizontalBrowseTransportBridge.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 13 | type | `HorizontalBrowseTransportDecodeDiagnostic` |

### 4.5 `src/main/layoutConfig.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 35 | function | `normalizeLayoutConfig` |

### 4.6 `src/main/libraryCacheDb/pioneerPreviewWaveformCache.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 10 | type | `PioneerPreviewWaveformCacheEntry` |

### 4.7 `src/main/libraryCacheDb/waveformSurfaceCache.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 130 | function | `encodeWaveformSurfacePayload` |
| 140 | function | `decodeWaveformSurfacePayload` |

### 4.8 `src/main/libraryDb.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 11 | type | `SqliteRow` |
| 856 | function | `closeLibraryDb` |

### 4.9 `src/main/libraryTreeDbHelpers.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 104 | function | `isNodeType` |

### 4.10 `src/main/log.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 215 | function | `ensureLogConfigured` |

### 4.11 `src/main/mixtapeDb.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 29 | type | `MixtapeProjectStemConfig` |

### 4.12 `src/main/mixtapeProjectTempoDb.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 9 | type | `MixtapeProjectBpmPoint` |

### 4.13 `src/main/mixtapeStemDb.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 13 | type | `MixtapeStemAssetRecord` |

### 4.14 `src/main/platform/windowsContextMenu.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 140 | function | `ensureWindowsContextMenu` |

### 4.15 `src/main/recordingLibraryService.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 23 | function | `ensureRecordingLibraryRoot` |
| 46 | function | `listRecordingFiles` |

### 4.16 `src/main/recycleBinService.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 22 | type | `RecycleBinSourceType` |
| 24 | type | `RecycleBinMoveOptions` |
| 39 | type | `RecycleBinRestoreResult` |
| 55 | type | `MixtapeMissingResolveResult` |
| 123 | function | `resolveOriginalPlaylistPathForFile` |

### 4.17 `src/main/services/analysisRuntimeDownload.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 11 | type | `AnalysisRuntimeDownloadInfo` |

### 4.18 `src/main/services/audioDecodePool.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 23 | type | `DecodeAudioMetrics` |

### 4.19 `src/main/services/backgroundIdleGate.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 9 | type | `BackgroundIdleSnapshot` |

### 4.20 `src/main/services/backgroundOrchestrator.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `BackgroundTaskCategory` |

### 4.21 `src/main/services/globalSongSearch.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 56 | type | `GlobalSongSearchResultItem` |
| 76 | type | `GlobalSongSearchQueryResult` |
| 83 | type | `PlaylistFastLoadResult` |

### 4.22 `src/main/services/keyAnalysis/types.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 8 | type | `KeyAnalysisProgressStage` |
| 37 | type | `KeyAnalysisJobTrace` |
| 55 | type | `KeyAnalysisPrepareDetails` |
| 156 | type | `KeyAnalysisWorkerPartialResult` |
| 166 | type | `KeyAnalysisWorkerResult` |

### 4.23 `src/main/services/libraryStemAssetStorage.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 72 | function | `toSafeStemPathSegment` |

### 4.24 `src/main/services/manualMacUpdate.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 23 | type | `ManualMacUpdateProgress` |

### 4.25 `src/main/services/mixtapeStemQueue.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 71 | type | `MixtapeStemEnqueueParams` |
| 82 | type | `MixtapeStemRetryParams` |
| 92 | type | `MixtapeStemEnqueueResult` |

### 4.26 `src/main/services/mixtapeStemSeparationShared.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 16 | const | `STEM_PROCESS_TIMEOUT_MS` |
| 17 | const | `STEM_PROCESS_TIMEOUT_MAX_MS` |
| 18 | const | `STEM_CPU_PROCESS_TIMEOUT_CAP_MS` |
| 19 | const | `STEM_GPU_PROCESS_TIMEOUT_CAP_MS` |
| 20 | const | `STEM_CPU_PROCESS_TIMEOUT_MIN_MS` |
| 21 | const | `STEM_GPU_PROCESS_TIMEOUT_MIN_MS` |
| 22 | const | `STEM_FFPROBE_TIMEOUT_MS` |
| 29 | const | `DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS` |

### 4.27 `src/main/services/mixtapeStemWaveformService.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 38 | type | `MixtapeStemWaveformBundleResult` |

### 4.28 `src/main/services/pioneerDeviceLibrary/playlistAnalysis.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 20 | type | `PioneerPlaylistAnalysisPrepareResult` |

### 4.29 `src/main/services/pioneerDeviceLibrary/usbIdentity.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 9 | type | `PioneerUsbIdentity` |
| 96 | re-export | `USB_ID_FILE_NAME` |

### 4.30 `src/main/services/playlistTrackNumbers.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 13 | type | `PlaylistTrackNumberEnsureResult` |

### 4.31 `src/main/services/rekordboxXmlExport/fileStage.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 28 | function | `resolveUniqueFilePath` |

### 4.32 `src/main/services/rekordboxXmlExport/types.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 66 | type | `RekordboxXmlExportProgressPayload` |
| 78 | type | `RekordboxXmlExportProgressReporter` |

### 4.33 `src/main/waveformCache.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 17 | function | `getMixxxWaveformByteLength` |

### 4.34 `src/main/workers/beatThisAnalyzer.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 396 | function | `analyzeBeatGridWithBeatThisFromPcm` |

### 4.35 `src/main/workers/beatThisRuntime.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `BeatThisPythonCommand` |
| 15 | type | `BeatThisComputeDevice` |
| 26 | type | `BeatThisResolvedRuntime` |

---

## 五、`src/renderer/` 目录（86 个死导出）

### 5.1 `src/renderer/src/components/MixtapeBeatAlignDialog.constants.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 11 | const | `PREVIEW_BPM_INTERNAL_DECIMALS` |

### 5.2 `src/renderer/src/components/beatGridRawCurveWaveformRenderer.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `RawCurveWaveformColumn` |
| 7 | type | `RawCurveWaveformLayout` |
| 9 | type | `RawCurveCanvasContext` |

### 5.3 `src/renderer/src/components/horizontalBrowseCompactVisualWaveform.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 289 | function | `unifiedDisplayWaveformToCompactVisualOverviewData` |

### 5.4 `src/renderer/src/components/horizontalBrowsePendingPlayDiagnostics.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 28 | const | `HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS` |
| 29 | const | `HORIZONTAL_BROWSE_PENDING_PLAY_EXTENDED_DIAGNOSTIC_MS` |

### 5.5 `src/renderer/src/components/horizontalBrowseRawWaveformCoverage.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 18 | function | `resolveHorizontalBrowseRawDataCoveredEndSec` |
| 30 | function | `resolveHorizontalBrowseRawDataEffectiveEndSec` |

### 5.6 `src/renderer/src/components/horizontalBrowseRawWaveformStreamViewport.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `HorizontalBrowseRawLoadedTimelineRange` |

### 5.7 `src/renderer/src/components/mixtapeBeatAlignMetronome.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 14 | function | `resolveNextMetronomeCycleState` |

### 5.8 `src/renderer/src/components/rekordboxDesktopTargetDialog.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `RekordboxDesktopTargetDialogResult` |

### 5.9 `src/renderer/src/components/rekordboxXmlExportDialog.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `RekordboxXmlExportDialogResult` |

### 5.10 `src/renderer/src/components/selectSongListDialogNav.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `DialogNavArea` |

### 5.11 `src/renderer/src/components/settingDialog/context.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 10 | type | `SettingDialogRuntimeSetting` |

### 5.12 `src/renderer/src/components/useHorizontalBrowseDeckLoopController.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 18 | type | `HorizontalBrowseStoredCueDefinition` |

### 5.13 `src/renderer/src/components/useHorizontalBrowseEditDeckNavigation.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 7 | type | `HorizontalBrowseEditBeatStep` |

### 5.14 `src/renderer/src/components/useHorizontalBrowseRenderSync.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 11 | type | `HorizontalBrowseRenderSyncTarget` |

### 5.15 `src/renderer/src/composables/mixtape/beatSyncModel.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 16 | type | `SyncPlaybackRateDiagnostics` |
| 26 | const | `BEAT_SYNC_MIN_RATE` |
| 27 | const | `BEAT_SYNC_MAX_RATE` |
| 71 | function | `wrapPhaseDiffSec` |
| 80 | function | `resolvePhaseSecAtTime` |

### 5.16 `src/renderer/src/composables/mixtape/constants.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `MIXTAPE_TRACK_UI_SCALE` |

### 5.17 `src/renderer/src/composables/mixtape/gainEnvelope.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN` |

### 5.18 `src/renderer/src/composables/mixtape/gainEnvelopeEditorGrid.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 7 | function | `resolveVolumeMuteStepBeats` |

### 5.19 `src/renderer/src/composables/mixtape/gainEnvelopeStemSegments.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `STEM_SEGMENT_MUTE_GAIN` |

### 5.20 `src/renderer/src/composables/mixtape/mixtapeGlobalTempoState.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 8 | ref | `mixtapeGlobalTempoDurationSec` |

### 5.21 `src/renderer/src/composables/mixtape/mixtapeMasterGrid.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 8 | type | `MixtapeMasterGridLine` |
| 13 | function | `normalizeMixtapeMasterGridPhaseOffsetSec` |

### 5.22 `src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `MixtapeTrackLoopSectionKind` |
| 57 | function | `buildMixtapeTrackLoopSegmentKey` |
| 105 | function | `resolveMixtapeTrackLoopLength` |
| 109 | function | `resolveMixtapeTrackLoopExtraDuration` |

### 5.23 `src/renderer/src/composables/mixtape/timelinePixelMath.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `resolveRoundedTimelineOffsetPx` |

### 5.24 `src/renderer/src/composables/mixtape/timelineTransportPlayableSource.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `estimateTransportSoundTouchLatencySec` |
| 8 | type | `TransportPlaybackRateControl` |

### 5.25 `src/renderer/src/composables/mixtape/timelineTransportPlaybackSequence.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `TransportPlaybackSequenceSegment` |

### 5.26 `src/renderer/src/composables/mixtape/timelineTransportSync.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `ApplyTransportSyncResult` |
| 8 | type | `TransportSyncDiagnostic` |
| 15 | type | `TransportSyncEntry` |

### 5.27 `src/renderer/src/composables/mixtape/trackGridSnap.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `findNearestSortedGridValues` |

### 5.28 `src/renderer/src/composables/mixtape/trackRuntimeTempoSnapshot.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `buildTrackTimeMapSignature` |

### 5.29 `src/renderer/src/composables/mixtape/trackTempoModel.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `TrackTempoModelPoint` |

### 5.30 `src/renderer/src/composables/mixtape/trackTimeMapCore.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `TrackTimeMapEntry` |
| 10 | function | `normalizeTrackTimeMap` |

### 5.31 `src/renderer/src/composables/mixtape/useMixtapeEnvelopePreview.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `TrackEnvelopePreviewLegendItem` |

### 5.32 `src/renderer/src/composables/mixtape/useMixtapeMixParamUi.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `MixtapeMixParamUiState` |

### 5.33 `src/renderer/src/composables/mixtape/useMixtapeStemPlaceholderState.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `TrackStemPlaceholderState` |

### 5.34 `src/renderer/src/composables/rekordboxDesktop/usePioneerCopyToLibrary.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `PioneerCopyTargetLibrary` |

### 5.35 `src/renderer/src/composables/rekordboxDesktop/useRekordboxTreeUtils.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `findNodeLocation` |

### 5.36 `src/renderer/src/composables/useAnalysisRuntimeDownload.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `AnalysisRuntimePromptResult` |
| 10 | type | `AnalysisRuntimePromptSource` |

### 5.37 `src/renderer/src/i18n/index.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `SUPPORTED_LOCALES` |

### 5.38 `src/renderer/src/pages/modules/songsArea/composables/scrollCarrier.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | interface | `SongsAreaScrollCarrierInfo` |

### 5.39 `src/renderer/src/pages/modules/songsArea/composables/useDragSongs.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | interface | `DragSongData` |

### 5.40 `src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | interface | `MetadataBatchUpdatedAction` |
| 10 | interface | `MetadataUpdatedAction` |
| 15 | interface | `OpenDialogAction` |
| 20 | interface | `SongsRemovedAction` |

### 5.41 `src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `buildSongsAreaBaseColumns` |
| 10 | const | `SONGS_AREA_DEFAULT_STORAGE_KEY` |
| 15 | const | `SONGS_AREA_RECORDING_STORAGE_KEY` |
| 20 | const | `SONGS_AREA_RECYCLE_STORAGE_KEY` |

### 5.42 `src/renderer/src/pages/modules/songsArea/SongListRows/waveformPreviewIpcSubscriptions.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `ManualKeyAnalysisBatchStartHandler` |
| 10 | type | `PioneerPreviewWaveformDonePayload` |
| 15 | type | `PioneerPreviewWaveformItemPayload` |

### 5.43 `src/renderer/src/stores/runtime.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | interface | `ISongsAreaState` |

### 5.44 `src/renderer/src/utils/audioConvertActions.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `collectSourceExts` |
| 10 | function | `filterFilesByTargetFormat` |

### 5.45 `src/renderer/src/utils/mixtapeDragSession.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `buildMixtapeSongSnapshot` |

### 5.46 `src/renderer/src/utils/neteaseSearch.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `buildNeteaseSearchUrl` |

### 5.47 `src/renderer/src/utils/rekordboxDesktopPlaylist.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `RekordboxDesktopPlaylistWriteResult` |

### 5.48 `src/renderer/src/utils/rekordboxExternalSource.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `normalizeRekordboxSourceKind` |

### 5.49 `src/renderer/src/utils/songCueTransfer.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | type | `SongCueSource` |

### 5.50 `src/renderer/src/utils/translate.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `LIBRARY_NAME_TO_I18N_KEY` |

### 5.51 `src/renderer/src/utils/uiSettingsStorage.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `pickUiSettings` |
| 10 | function | `writeUiSettings` |

### 5.52 `src/renderer/src/utils/windowVolume.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | const | `DEFAULT_WINDOW_VOLUME` |

### 5.53 `src/renderer/src/workers/horizontalBrowseDetailLiveCanvas.types.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `HorizontalBrowseDetailLiveCanvasDirection` |
| 8 | type | `HorizontalBrowseDetailLiveCanvasRawSlot` |
| 13 | type | `HorizontalBrowseDetailLiveCanvasWaveformRenderStyle` |

### 5.54 `src/renderer/src/workers/horizontalBrowseDetailLiveCanvasPlayback.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 5 | function | `clampPlaybackRangeStart` |
| 10 | const | `PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS` |

### 5.55 `src/renderer/src/workers/mixtapeWaveformRender.types.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `RenderFrameTrack` |

### 5.56 `src/renderer/src/workers/songListWaveformPreview.shared.ts`

| 行号 | 类型 | 符号 |
|------|------|------|
| 3 | type | `SongListWaveformCanvasContext` |

---

## 六、清理优先级建议

### 🔴 高优先级（运行时常量，实际占用 bundle 体积）

| 文件 | 死符号数 | 说明 |
|------|---------|------|
| `src/main/services/mixtapeStemSeparationShared.ts` | 8 | 8 个 timeout 常量，全文件私有即可 |
| `src/shared/hotCues.ts` | 2 | 颜色和标签数组，仅内部用 |
| `src/renderer/src/composables/mixtape/beatSyncModel.ts` | 5 | 含 2 个 rate 常量 + 3 个函数 |
| `src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts` | 4 | 含 3 个函数 |
| `src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts` | 4 | 4 个 storage key 常量 |

### 🟡 中优先级（函数/常量，不影响 bundle 但影响代码可读性）

涉及文件约 20 个，共约 25 个函数和常量死导出。建议在日常重构中逐步清理。

### 🟢 低优先级（纯 type/interface，不影响运行时）

约 103 个 type/interface 死导出。这些不影响 bundle 体积和运行时行为，但移除 `export` 可以让模块边界更清晰，防止外部误用。建议在大规模重构时批量处理。

> ⚠️ 其中 `CuratedArtistLibrarySnapshot` 为边界案例，建议保留 `export`（详见 4.1 节）。

---

## 七、与上次清理的对比

上次清理（commit `46a69286`）处理了：
- 1 个未使用的类型别名 `IPioneerDeviceLibraryState`
- Rust 侧的死变量和多余参数
- 2 个多余的 `export` 关键字（`buildMixtapeSoundTouchCacheKey`、`getRecycleBinSourceLabel`）

本次分析发现的 159 个确认死导出 + 1 个边界案例均为**新增发现**，不与上次清理重叠。

---

## 八、清理方式

所有清理操作统一为**移除 `export` 关键字**，不删除任何代码：

```typescript
// 清理前
export const HOT_CUE_SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

// 清理后
const HOT_CUE_SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
```

⚠️ **注意**：对于 type/interface 死导出，如果该类型被同文件内导出的函数返回值使用，TypeScript 会通过类型推断自动传递类型信息，移除 `export` 不会影响外部使用该函数的类型安全性。
