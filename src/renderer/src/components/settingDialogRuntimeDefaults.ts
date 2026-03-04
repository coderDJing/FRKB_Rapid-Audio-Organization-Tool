export const AUDIO_OUTPUT_FOLLOW_SYSTEM_ID = ''

export const ensurePlayerGlobalShortcuts = (runtime: any) => {
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

export const ensureSettingDialogRuntimeDefaults = (runtime: any) => {
  if (runtime.setting.enablePlaybackRange === undefined) {
    runtime.setting.enablePlaybackRange = false
  }
  if (runtime.setting.startPlayPercent === undefined) {
    runtime.setting.startPlayPercent = 0
  }
  if (runtime.setting.endPlayPercent === undefined) {
    runtime.setting.endPlayPercent = 100
  }
  if ((runtime as any).setting.showIdleAnalysisStatus === undefined) {
    ;(runtime as any).setting.showIdleAnalysisStatus = false
  }
  if (runtime.setting.recentDialogSelectedSongListMaxCount === undefined) {
    runtime.setting.recentDialogSelectedSongListMaxCount = 10
  }
  if ((runtime as any).setting.enableErrorReport === undefined) {
    ;(runtime as any).setting.enableErrorReport = true
  }
  if ((runtime as any).setting.errorReportUsageMsSinceLastSuccess === undefined) {
    ;(runtime as any).setting.errorReportUsageMsSinceLastSuccess = 0
  }
  if ((runtime as any).setting.errorReportRetryMsSinceLastFailure === undefined) {
    ;(runtime as any).setting.errorReportRetryMsSinceLastFailure = -1
  }
  if ((runtime as any).setting.persistSongFilters === undefined) {
    ;(runtime as any).setting.persistSongFilters = false
  }
  if ((runtime as any).setting.enableExplorerContextMenu === undefined) {
    ;(runtime as any).setting.enableExplorerContextMenu = runtime.setting.platform === 'win32'
  }
  if ((runtime as any).setting.songListBubbleAlways === undefined) {
    ;(runtime as any).setting.songListBubbleAlways = false
  }
  if ((runtime as any).setting.acoustIdClientKey === undefined) {
    ;(runtime as any).setting.acoustIdClientKey = ''
  }
  if ((runtime as any).setting.autoFillSkipCompleted === undefined) {
    ;(runtime as any).setting.autoFillSkipCompleted = true
  }
  if (runtime.setting.audioOutputDeviceId === undefined) {
    runtime.setting.audioOutputDeviceId = AUDIO_OUTPUT_FOLLOW_SYSTEM_ID
  }
  if ((runtime as any).setting.waveformStyle === undefined) {
    ;(runtime as any).setting.waveformStyle = 'SoundCloud'
  }
  if ((runtime as any).setting.waveformMode === undefined) {
    ;(runtime as any).setting.waveformMode = 'half'
  }
  if ((runtime as any).setting.keyDisplayStyle === undefined) {
    ;(runtime as any).setting.keyDisplayStyle = 'Classic'
  }
  ensurePlayerGlobalShortcuts(runtime)
}
