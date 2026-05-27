type PlaybackSourceRuntime = {
  mainWindowBrowseMode: string
  playingData: {
    playingSongListUUID: string
  }
  horizontalBrowseDecks: {
    topSongListUUID?: string
    bottomSongListUUID?: string
  }
}

const normalizeSongListUUID = (value: unknown) => String(value || '').trim()

export const resolveActivePlaybackSongListUUIDs = (runtime: PlaybackSourceRuntime): string[] => {
  const uuids =
    runtime.mainWindowBrowseMode === 'browser'
      ? [runtime.playingData.playingSongListUUID]
      : [
          runtime.horizontalBrowseDecks.topSongListUUID,
          runtime.horizontalBrowseDecks.bottomSongListUUID
        ]

  return Array.from(new Set(uuids.map(normalizeSongListUUID).filter(Boolean)))
}
