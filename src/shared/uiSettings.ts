export const UI_SETTING_KEYS = [
  'mainWindowBrowseMode',
  'hiddenPlayControlArea',
  'waveformStyle',
  'waveformMode',
  'keyDisplayStyle',
  'autoPlayNextSong',
  'startPlayPercent',
  'endPlayPercent',
  'fastForwardTime',
  'fastBackwardTime',
  'enablePlaybackRange',
  'autoScrollToCurrentSong',
  'audioOutputDeviceId',
  'showTitleAudioVisualizer',
  'mainWindowTitleAudioVisualizerMode',
  'mixtapeWindowTitleAudioVisualizerMode',
  'showPlaylistTrackCount',
  'recentDialogSelectedSongListMaxCount',
  'songListBubbleAlways'
] as const

export type UiSettingKey = (typeof UI_SETTING_KEYS)[number]
