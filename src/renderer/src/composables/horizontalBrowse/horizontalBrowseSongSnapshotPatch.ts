import type { ISongInfo } from '../../../../types/globals'

type SongListSnapshot = {
  songInfoArr: ISongInfo[]
}

export type HorizontalBrowseSongSnapshotRuntime = {
  playingData: {
    playingSong: ISongInfo | null
    playingSongListData: ISongInfo[]
  }
  horizontalBrowseDecks: {
    topSongListData: ISongInfo[]
    bottomSongListData: ISongInfo[]
  }
  externalPlaylist: {
    songs: ISongInfo[]
  }
  songsArea: SongListSnapshot
  songsAreaPanels: {
    panes: Record<'single' | 'left' | 'right', SongListSnapshot>
  }
}

const patchSongList = <Payload>(
  songs: ISongInfo[],
  payload: Payload,
  mergeSong: (song: ISongInfo, payload: Payload) => ISongInfo
) => {
  let touched = false
  const nextSongs = songs.map((song) => {
    const nextSong = mergeSong(song, payload)
    if (nextSong !== song) touched = true
    return nextSong
  })
  return touched ? nextSongs : songs
}

export const patchHorizontalBrowseRuntimeSongSnapshots = <Payload>(
  runtime: HorizontalBrowseSongSnapshotRuntime,
  payload: Payload,
  mergeSong: (song: ISongInfo, payload: Payload) => ISongInfo
) => {
  const playingSong = runtime.playingData.playingSong
  if (playingSong) {
    const nextPlayingSong = mergeSong(playingSong, payload)
    if (nextPlayingSong !== playingSong) {
      runtime.playingData.playingSong = nextPlayingSong
    }
  }
  runtime.playingData.playingSongListData = patchSongList(
    runtime.playingData.playingSongListData,
    payload,
    mergeSong
  )
  runtime.horizontalBrowseDecks.topSongListData = patchSongList(
    runtime.horizontalBrowseDecks.topSongListData,
    payload,
    mergeSong
  )
  runtime.horizontalBrowseDecks.bottomSongListData = patchSongList(
    runtime.horizontalBrowseDecks.bottomSongListData,
    payload,
    mergeSong
  )
  runtime.externalPlaylist.songs = patchSongList(runtime.externalPlaylist.songs, payload, mergeSong)
  runtime.songsArea.songInfoArr = patchSongList(runtime.songsArea.songInfoArr, payload, mergeSong)
  for (const pane of ['single', 'left', 'right'] as const) {
    const paneState = runtime.songsAreaPanels.panes[pane]
    paneState.songInfoArr = patchSongList(paneState.songInfoArr, payload, mergeSong)
  }
}
