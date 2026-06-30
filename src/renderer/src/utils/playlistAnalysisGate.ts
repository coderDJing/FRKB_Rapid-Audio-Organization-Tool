type PlaylistAnalysisGateRuntime = {
  mainWindowBrowseMode?: string
  playingData?: {
    playingSongListUUID?: string
  }
  playlistAnalysisPromptDismissedSongListUUIDs?: string[]
}

const normalizeSongListUUID = (value: unknown) => String(value || '').trim()

export const isPlaylistAnalysisPromptDismissed = (
  runtime: PlaylistAnalysisGateRuntime,
  songListUUID?: string | null
) => {
  const uuid = normalizeSongListUUID(songListUUID)
  if (!uuid) return false
  return Array.isArray(runtime.playlistAnalysisPromptDismissedSongListUUIDs)
    ? runtime.playlistAnalysisPromptDismissedSongListUUIDs.includes(uuid)
    : false
}

export const shouldQueueBrowserMainPlayerAnalysis = (
  runtime: PlaylistAnalysisGateRuntime,
  songListUUID = runtime.playingData?.playingSongListUUID
) => {
  if (runtime.mainWindowBrowseMode !== 'browser') return true
  return !isPlaylistAnalysisPromptDismissed(runtime, songListUUID)
}
