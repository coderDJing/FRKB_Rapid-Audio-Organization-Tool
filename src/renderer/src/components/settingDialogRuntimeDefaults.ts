import type { IPlayerGlobalShortcuts, ISettingConfig } from 'src/types/globals'

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
  if (runtime.setting.enablePlaybackRange === undefined) {
    runtime.setting.enablePlaybackRange = false
  }
  if (runtime.setting.startPlayPercent === undefined) {
    runtime.setting.startPlayPercent = 0
  }
  if (runtime.setting.endPlayPercent === undefined) {
    runtime.setting.endPlayPercent = 100
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
  if (runtime.setting.waveformStyle === undefined) {
    runtime.setting.waveformStyle = 'RGB'
  }
  if (runtime.setting.waveformMode === undefined) {
    runtime.setting.waveformMode = 'half'
  }
  if (runtime.setting.keyDisplayStyle === undefined) {
    runtime.setting.keyDisplayStyle = 'Classic'
  }
  if (runtime.setting.beatGridAnalyzerProvider === undefined) {
    runtime.setting.beatGridAnalyzerProvider = 'beatthis'
  }
  ensurePlayerGlobalShortcuts(runtime)
}
