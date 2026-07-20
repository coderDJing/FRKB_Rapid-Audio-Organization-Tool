import type { IPlayerGlobalShortcuts, ISettingConfig } from 'src/types/globals'
import { normalizeAnalysisBpmRangeId } from '@shared/analysisBpmRange'

export const AUDIO_OUTPUT_FOLLOW_SYSTEM_ID = ''

type SettingDialogRuntime = {
  setting: ISettingConfig & {
    songListBubbleAlways?: boolean
  }
}

export const ensurePlayerGlobalShortcuts = (
  runtime: SettingDialogRuntime
): IPlayerGlobalShortcuts => {
  if (!runtime?.setting?.playerGlobalShortcuts) {
    runtime.setting.playerGlobalShortcuts = {
      fastForward: 'Shift+Alt+Right',
      fastBackward: 'Shift+Alt+Left',
      nextSong: 'Shift+Alt+Down',
      previousSong: 'Shift+Alt+Up'
    }
  }
  return runtime.setting.playerGlobalShortcuts
}

export const ensureSettingDialogRuntimeDefaults = (runtime: SettingDialogRuntime) => {
  runtime.setting.analysisBpmRange = normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange)
  if (runtime.setting.enablePlaybackRange === undefined) {
    runtime.setting.enablePlaybackRange = false
  }
  if (runtime.setting.startPlayPercent === undefined) {
    runtime.setting.startPlayPercent = 0
  }
  if (runtime.setting.endPlayPercent === undefined) {
    runtime.setting.endPlayPercent = 100
  }
  if (runtime.setting.playbackRangeMode === undefined) {
    runtime.setting.playbackRangeMode = 'custom'
  }
  if (runtime.setting.playbackRangeSectionKinds === undefined) {
    runtime.setting.playbackRangeSectionKinds = ['drop']
  }
  if (runtime.setting.playbackRangeSectionMatchMode === undefined) {
    runtime.setting.playbackRangeSectionMatchMode = 'all'
  }
  if (runtime.setting.showIdleAnalysisStatus === undefined) {
    runtime.setting.showIdleAnalysisStatus = false
  }
  if (runtime.setting.recentDialogSelectedSongListMaxCount === undefined) {
    runtime.setting.recentDialogSelectedSongListMaxCount = 10
  }
  if (runtime.setting.enableErrorReport === undefined) {
    runtime.setting.enableErrorReport = true
  }
  if (runtime.setting.errorReportUsageMsSinceLastSuccess === undefined) {
    runtime.setting.errorReportUsageMsSinceLastSuccess = 0
  }
  if (runtime.setting.errorReportRetryMsSinceLastFailure === undefined) {
    runtime.setting.errorReportRetryMsSinceLastFailure = -1
  }
  if (runtime.setting.persistSongFilters === undefined) {
    runtime.setting.persistSongFilters = false
  }
  if (runtime.setting.enableCuratedArtistTracking === undefined) {
    runtime.setting.enableCuratedArtistTracking = true
  }
  if (runtime.setting.enableExplorerContextMenu === undefined) {
    runtime.setting.enableExplorerContextMenu = runtime.setting.platform === 'win32'
  }
  if (runtime.setting.rekordboxDesktopTrackStorageDir === undefined) {
    runtime.setting.rekordboxDesktopTrackStorageDir = ''
  }
  if (runtime.setting.songListBubbleAlways === undefined) {
    runtime.setting.songListBubbleAlways = false
  }
  if (runtime.setting.acoustIdClientKey === undefined) {
    runtime.setting.acoustIdClientKey = ''
  }
  if (runtime.setting.autoFillSkipCompleted === undefined) {
    runtime.setting.autoFillSkipCompleted = true
  }
  if (runtime.setting.analysisRuntimeStartupPromptShownVersion === undefined) {
    runtime.setting.analysisRuntimeStartupPromptShownVersion = ''
  }
  if (runtime.setting.audioOutputDeviceId === undefined) {
    runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
  }
  if (runtime.setting.waveformMode === undefined) {
    runtime.setting.waveformMode = 'half'
  }
  if (runtime.setting.keyDisplayStyle === undefined) {
    runtime.setting.keyDisplayStyle = 'Classic'
  }
  ensurePlayerGlobalShortcuts(runtime)
}
