#!/bin/bash

# 移除renderer目录中未使用的export关键字

# src/renderer/src/components/MixtapeBeatAlignDialog.constants.ts
sed -i 's/^export const PREVIEW_BPM_INTERNAL_DECIMALS/const PREVIEW_BPM_INTERNAL_DECIMALS/' src/renderer/src/components/MixtapeBeatAlignDialog.constants.ts

# src/renderer/src/components/beatGridRawCurveWaveformRenderer.ts
sed -i 's/^export type RawCurveWaveformColumn/type RawCurveWaveformColumn/' src/renderer/src/components/beatGridRawCurveWaveformRenderer.ts
sed -i 's/^export type RawCurveWaveformLayout/type RawCurveWaveformLayout/' src/renderer/src/components/beatGridRawCurveWaveformRenderer.ts
sed -i 's/^export type RawCurveCanvasContext/type RawCurveCanvasContext/' src/renderer/src/components/beatGridRawCurveWaveformRenderer.ts

# src/renderer/src/components/horizontalBrowseCompactVisualWaveform.ts
sed -i 's/^export const unifiedDisplayWaveformToCompactVisualOverviewData/const unifiedDisplayWaveformToCompactVisualOverviewData/' src/renderer/src/components/horizontalBrowseCompactVisualWaveform.ts

# src/renderer/src/components/horizontalBrowsePendingPlayDiagnostics.ts
sed -i 's/^export const HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS/const HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS/' src/renderer/src/components/horizontalBrowsePendingPlayDiagnostics.ts
sed -i 's/^export const HORIZONTAL_BROWSE_PENDING_PLAY_EXTENDED_DIAGNOSTIC_MS/const HORIZONTAL_BROWSE_PENDING_PLAY_EXTENDED_DIAGNOSTIC_MS/' src/renderer/src/components/horizontalBrowsePendingPlayDiagnostics.ts

# src/renderer/src/components/horizontalBrowseRawWaveformCoverage.ts
sed -i 's/^export const resolveHorizontalBrowseRawDataCoveredEndSec/const resolveHorizontalBrowseRawDataCoveredEndSec/' src/renderer/src/components/horizontalBrowseRawWaveformCoverage.ts
sed -i 's/^export const resolveHorizontalBrowseRawDataEffectiveEndSec/const resolveHorizontalBrowseRawDataEffectiveEndSec/' src/renderer/src/components/horizontalBrowseRawWaveformCoverage.ts

# src/renderer/src/components/horizontalBrowseRawWaveformStreamViewport.ts
sed -i 's/^export type HorizontalBrowseRawLoadedTimelineRange/type HorizontalBrowseRawLoadedTimelineRange/' src/renderer/src/components/horizontalBrowseRawWaveformStreamViewport.ts

# src/renderer/src/components/mixtapeBeatAlignMetronome.ts
sed -i 's/^export const resolveNextMetronomeCycleState/const resolveNextMetronomeCycleState/' src/renderer/src/components/mixtapeBeatAlignMetronome.ts

# src/renderer/src/components/rekordboxDesktopTargetDialog.ts
sed -i 's/^export type RekordboxDesktopTargetDialogResult/type RekordboxDesktopTargetDialogResult/' src/renderer/src/components/rekordboxDesktopTargetDialog.ts

# src/renderer/src/components/rekordboxXmlExportDialog.ts
sed -i 's/^export type RekordboxXmlExportDialogResult/type RekordboxXmlExportDialogResult/' src/renderer/src/components/rekordboxXmlExportDialog.ts

# src/renderer/src/components/selectSongListDialogNav.ts
sed -i 's/^export type DialogNavArea/type DialogNavArea/' src/renderer/src/components/selectSongListDialogNav.ts

# src/renderer/src/components/settingDialog/context.ts
sed -i 's/^export type SettingDialogRuntimeSetting/type SettingDialogRuntimeSetting/' src/renderer/src/components/settingDialog/context.ts

# src/renderer/src/components/useHorizontalBrowseDeckLoopController.ts
sed -i 's/^export type HorizontalBrowseStoredCueDefinition/type HorizontalBrowseStoredCueDefinition/' src/renderer/src/components/useHorizontalBrowseDeckLoopController.ts

# src/renderer/src/components/useHorizontalBrowseEditDeckNavigation.ts
sed -i 's/^export type HorizontalBrowseEditBeatStep/type HorizontalBrowseEditBeatStep/' src/renderer/src/components/useHorizontalBrowseEditDeckNavigation.ts

# src/renderer/src/components/useHorizontalBrowseRenderSync.ts
sed -i 's/^export type HorizontalBrowseRenderSyncTarget/type HorizontalBrowseRenderSyncTarget/' src/renderer/src/components/useHorizontalBrowseRenderSync.ts

# src/renderer/src/composables/mixtape/beatSyncModel.ts
sed -i 's/^export type SyncPlaybackRateDiagnostics/type SyncPlaybackRateDiagnostics/' src/renderer/src/composables/mixtape/beatSyncModel.ts
sed -i 's/^export const BEAT_SYNC_MIN_RATE/const BEAT_SYNC_MIN_RATE/' src/renderer/src/composables/mixtape/beatSyncModel.ts
sed -i 's/^export const BEAT_SYNC_MAX_RATE/const BEAT_SYNC_MAX_RATE/' src/renderer/src/composables/mixtape/beatSyncModel.ts
sed -i 's/^export const wrapPhaseDiffSec/const wrapPhaseDiffSec/' src/renderer/src/composables/mixtape/beatSyncModel.ts
sed -i 's/^export const resolvePhaseSecAtTime/const resolvePhaseSecAtTime/' src/renderer/src/composables/mixtape/beatSyncModel.ts

# src/renderer/src/composables/mixtape/constants.ts
sed -i 's/^export const MIXTAPE_TRACK_UI_SCALE/const MIXTAPE_TRACK_UI_SCALE/' src/renderer/src/composables/mixtape/constants.ts

# src/renderer/src/composables/mixtape/gainEnvelope.ts
sed -i 's/^export const MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN/const MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN/' src/renderer/src/composables/mixtape/gainEnvelope.ts

# src/renderer/src/composables/mixtape/gainEnvelopeEditorGrid.ts
sed -i 's/^export const resolveVolumeMuteStepBeats/const resolveVolumeMuteStepBeats/' src/renderer/src/composables/mixtape/gainEnvelopeEditorGrid.ts

# src/renderer/src/composables/mixtape/gainEnvelopeStemSegments.ts
sed -i 's/^export const STEM_SEGMENT_MUTE_GAIN/const STEM_SEGMENT_MUTE_GAIN/' src/renderer/src/composables/mixtape/gainEnvelopeStemSegments.ts

# src/renderer/src/composables/mixtape/mixtapeGlobalTempoState.ts
sed -i 's/^export const mixtapeGlobalTempoDurationSec/const mixtapeGlobalTempoDurationSec/' src/renderer/src/composables/mixtape/mixtapeGlobalTempoState.ts

# src/renderer/src/composables/mixtape/mixtapeMasterGrid.ts
sed -i 's/^export type MixtapeMasterGridLine/type MixtapeMasterGridLine/' src/renderer/src/composables/mixtape/mixtapeMasterGrid.ts
sed -i 's/^export const normalizeMixtapeMasterGridPhaseOffsetSec/const normalizeMixtapeMasterGridPhaseOffsetSec/' src/renderer/src/composables/mixtape/mixtapeMasterGrid.ts

# src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts
sed -i 's/^export type MixtapeTrackLoopSectionKind/type MixtapeTrackLoopSectionKind/' src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts
sed -i 's/^export const buildMixtapeTrackLoopSegmentKey/const buildMixtapeTrackLoopSegmentKey/' src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts
sed -i 's/^export const resolveMixtapeTrackLoopLength/const resolveMixtapeTrackLoopLength/' src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts
sed -i 's/^export const resolveMixtapeTrackLoopExtraDuration/const resolveMixtapeTrackLoopExtraDuration/' src/renderer/src/composables/mixtape/mixtapeTrackLoop.ts

# src/renderer/src/composables/mixtape/timelinePixelMath.ts
sed -i 's/^export const resolveRoundedTimelineOffsetPx/const resolveRoundedTimelineOffsetPx/' src/renderer/src/composables/mixtape/timelinePixelMath.ts

# src/renderer/src/composables/mixtape/timelineTransportPlayableSource.ts
sed -i 's/^export const estimateTransportSoundTouchLatencySec/const estimateTransportSoundTouchLatencySec/' src/renderer/src/composables/mixtape/timelineTransportPlayableSource.ts
sed -i 's/^export type TransportPlaybackRateControl/type TransportPlaybackRateControl/' src/renderer/src/composables/mixtape/timelineTransportPlayableSource.ts

# src/renderer/src/composables/mixtape/timelineTransportPlaybackSequence.ts
sed -i 's/^export type TransportPlaybackSequenceSegment/type TransportPlaybackSequenceSegment/' src/renderer/src/composables/mixtape/timelineTransportPlaybackSequence.ts

# src/renderer/src/composables/mixtape/timelineTransportSync.ts
sed -i 's/^export type ApplyTransportSyncResult/type ApplyTransportSyncResult/' src/renderer/src/composables/mixtape/timelineTransportSync.ts
sed -i 's/^export type TransportSyncDiagnostic/type TransportSyncDiagnostic/' src/renderer/src/composables/mixtape/timelineTransportSync.ts
sed -i 's/^export type TransportSyncEntry/type TransportSyncEntry/' src/renderer/src/composables/mixtape/timelineTransportSync.ts

# src/renderer/src/composables/mixtape/trackGridSnap.ts
sed -i 's/^export const findNearestSortedGridValues/const findNearestSortedGridValues/' src/renderer/src/composables/mixtape/trackGridSnap.ts

# src/renderer/src/composables/mixtape/trackRuntimeTempoSnapshot.ts
sed -i 's/^export const buildTrackTimeMapSignature/const buildTrackTimeMapSignature/' src/renderer/src/composables/mixtape/trackRuntimeTempoSnapshot.ts

# src/renderer/src/composables/mixtape/trackTempoModel.ts
sed -i 's/^export type TrackTempoModelPoint/type TrackTempoModelPoint/' src/renderer/src/composables/mixtape/trackTempoModel.ts

# src/renderer/src/composables/mixtape/trackTimeMapCore.ts
sed -i 's/^export type TrackTimeMapEntry/type TrackTimeMapEntry/' src/renderer/src/composables/mixtape/trackTimeMapCore.ts
sed -i 's/^export const normalizeTrackTimeMap/const normalizeTrackTimeMap/' src/renderer/src/composables/mixtape/trackTimeMapCore.ts

# src/renderer/src/composables/mixtape/useMixtapeEnvelopePreview.ts
sed -i 's/^export type TrackEnvelopePreviewLegendItem/type TrackEnvelopePreviewLegendItem/' src/renderer/src/composables/mixtape/useMixtapeEnvelopePreview.ts

# src/renderer/src/composables/mixtape/useMixtapeMixParamUi.ts
sed -i 's/^export type MixtapeMixParamUiState/type MixtapeMixParamUiState/' src/renderer/src/composables/mixtape/useMixtapeMixParamUi.ts

# src/renderer/src/composables/mixtape/useMixtapeStemPlaceholderState.ts
sed -i 's/^export type TrackStemPlaceholderState/type TrackStemPlaceholderState/' src/renderer/src/composables/mixtape/useMixtapeStemPlaceholderState.ts

# src/renderer/src/composables/rekordboxDesktop/usePioneerCopyToLibrary.ts
sed -i 's/^export type PioneerCopyTargetLibrary/type PioneerCopyTargetLibrary/' src/renderer/src/composables/rekordboxDesktop/usePioneerCopyToLibrary.ts

# src/renderer/src/composables/rekordboxDesktop/useRekordboxTreeUtils.ts
sed -i 's/^export const findNodeLocation/const findNodeLocation/' src/renderer/src/composables/rekordboxDesktop/useRekordboxTreeUtils.ts

# src/renderer/src/composables/useAnalysisRuntimeDownload.ts
sed -i 's/^export type AnalysisRuntimePromptResult/type AnalysisRuntimePromptResult/' src/renderer/src/composables/useAnalysisRuntimeDownload.ts
sed -i 's/^export type AnalysisRuntimePromptSource/type AnalysisRuntimePromptSource/' src/renderer/src/composables/useAnalysisRuntimeDownload.ts

# src/renderer/src/i18n/index.ts
sed -i 's/^export const SUPPORTED_LOCALES/const SUPPORTED_LOCALES/' src/renderer/src/i18n/index.ts

# src/renderer/src/pages/modules/songsArea/composables/scrollCarrier.ts
sed -i 's/^export interface SongsAreaScrollCarrierInfo/interface SongsAreaScrollCarrierInfo/' src/renderer/src/pages/modules/songsArea/composables/scrollCarrier.ts

# src/renderer/src/pages/modules/songsArea/composables/useDragSongs.ts
sed -i 's/^export interface DragSongData/interface DragSongData/' src/renderer/src/pages/modules/songsArea/composables/useDragSongs.ts

# src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts
sed -i 's/^export interface MetadataBatchUpdatedAction/interface MetadataBatchUpdatedAction/' src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts
sed -i 's/^export interface MetadataUpdatedAction/interface MetadataUpdatedAction/' src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts
sed -i 's/^export interface OpenDialogAction/interface OpenDialogAction/' src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts
sed -i 's/^export interface SongsRemovedAction/interface SongsRemovedAction/' src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts

# src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts
sed -i 's/^export const buildSongsAreaBaseColumns/const buildSongsAreaBaseColumns/' src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts
sed -i 's/^export const SONGS_AREA_DEFAULT_STORAGE_KEY/const SONGS_AREA_DEFAULT_STORAGE_KEY/' src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts
sed -i 's/^export const SONGS_AREA_RECORDING_STORAGE_KEY/const SONGS_AREA_RECORDING_STORAGE_KEY/' src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts
sed -i 's/^export const SONGS_AREA_RECYCLE_STORAGE_KEY/const SONGS_AREA_RECYCLE_STORAGE_KEY/' src/renderer/src/pages/modules/songsArea/composables/useSongsAreaColumns.ts

# src/renderer/src/pages/modules/songsArea/SongListRows/waveformPreviewIpcSubscriptions.ts
sed -i 's/^export type ManualKeyAnalysisBatchStartHandler/type ManualKeyAnalysisBatchStartHandler/' src/renderer/src/pages/modules/songsArea/SongListRows/waveformPreviewIpcSubscriptions.ts
sed -i 's/^export type PioneerPreviewWaveformDonePayload/type PioneerPreviewWaveformDonePayload/' src/renderer/src/pages/modules/songsArea/SongListRows/waveformPreviewIpcSubscriptions.ts
sed -i 's/^export type PioneerPreviewWaveformItemPayload/type PioneerPreviewWaveformItemPayload/' src/renderer/src/pages/modules/songsArea/SongListRows/waveformPreviewIpcSubscriptions.ts

# src/renderer/src/stores/runtime.ts
sed -i 's/^export interface ISongsAreaState/interface ISongsAreaState/' src/renderer/src/stores/runtime.ts

# src/renderer/src/utils/audioConvertActions.ts
sed -i 's/^export const collectSourceExts/const collectSourceExts/' src/renderer/src/utils/audioConvertActions.ts
sed -i 's/^export const filterFilesByTargetFormat/const filterFilesByTargetFormat/' src/renderer/src/utils/audioConvertActions.ts

# src/renderer/src/utils/mixtapeDragSession.ts
sed -i 's/^export const buildMixtapeSongSnapshot/const buildMixtapeSongSnapshot/' src/renderer/src/utils/mixtapeDragSession.ts

# src/renderer/src/utils/neteaseSearch.ts
sed -i 's/^export const buildNeteaseSearchUrl/const buildNeteaseSearchUrl/' src/renderer/src/utils/neteaseSearch.ts

# src/renderer/src/utils/rekordboxDesktopPlaylist.ts
sed -i 's/^export type RekordboxDesktopPlaylistWriteResult/type RekordboxDesktopPlaylistWriteResult/' src/renderer/src/utils/rekordboxDesktopPlaylist.ts

# src/renderer/src/utils/rekordboxExternalSource.ts
sed -i 's/^export const normalizeRekordboxSourceKind/const normalizeRekordboxSourceKind/' src/renderer/src/utils/rekordboxExternalSource.ts

# src/renderer/src/utils/songCueTransfer.ts
sed -i 's/^export type SongCueSource/type SongCueSource/' src/renderer/src/utils/songCueTransfer.ts

# src/renderer/src/utils/translate.ts
sed -i 's/^export const LIBRARY_NAME_TO_I18N_KEY/const LIBRARY_NAME_TO_I18N_KEY/' src/renderer/src/utils/translate.ts

# src/renderer/src/utils/uiSettingsStorage.ts
sed -i 's/^export const pickUiSettings/const pickUiSettings/' src/renderer/src/utils/uiSettingsStorage.ts
sed -i 's/^export const writeUiSettings/const writeUiSettings/' src/renderer/src/utils/uiSettingsStorage.ts

# src/renderer/src/utils/windowVolume.ts
sed -i 's/^export const DEFAULT_WINDOW_VOLUME/const DEFAULT_WINDOW_VOLUME/' src/renderer/src/utils/windowVolume.ts

# src/renderer/src/workers/horizontalBrowseDetailLiveCanvas.types.ts
sed -i 's/^export type HorizontalBrowseDetailLiveCanvasDirection/type HorizontalBrowseDetailLiveCanvasDirection/' src/renderer/src/workers/horizontalBrowseDetailLiveCanvas.types.ts
sed -i 's/^export type HorizontalBrowseDetailLiveCanvasRawSlot/type HorizontalBrowseDetailLiveCanvasRawSlot/' src/renderer/src/workers/horizontalBrowseDetailLiveCanvas.types.ts
sed -i 's/^export type HorizontalBrowseDetailLiveCanvasWaveformRenderStyle/type HorizontalBrowseDetailLiveCanvasWaveformRenderStyle/' src/renderer/src/workers/horizontalBrowseDetailLiveCanvas.types.ts

# src/renderer/src/workers/horizontalBrowseDetailLiveCanvasPlayback.ts
sed -i 's/^export const clampPlaybackRangeStart/const clampPlaybackRangeStart/' src/renderer/src/workers/horizontalBrowseDetailLiveCanvasPlayback.ts
sed -i 's/^export const PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS/const PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS/' src/renderer/src/workers/horizontalBrowseDetailLiveCanvasPlayback.ts

# src/renderer/src/workers/mixtapeWaveformRender.types.ts
sed -i 's/^export type RenderFrameTrack/type RenderFrameTrack/' src/renderer/src/workers/mixtapeWaveformRender.types.ts

# src/renderer/src/workers/songListWaveformPreview.shared.ts
sed -i 's/^export type SongListWaveformCanvasContext/type SongListWaveformCanvasContext/' src/renderer/src/workers/songListWaveformPreview.shared.ts

echo "Done applying export removals for src/renderer/"
