export const UI_SETTING_KEYS = [
  'mainWindowBrowseMode',
  'hiddenPlayControlArea',
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
  'horizontalBrowseFaderControlsExpanded',
  'showPlaylistTrackCount',
  'recentDialogSelectedSongListMaxCount',
  'songListBubbleAlways'
] as const

export type UiSettingKey = (typeof UI_SETTING_KEYS)[number]

export const LEGACY_UI_SETTING_KEYS = ['waveformStyle'] as const

export const STRIPPED_UI_SETTING_KEYS = [...UI_SETTING_KEYS, ...LEGACY_UI_SETTING_KEYS] as const
