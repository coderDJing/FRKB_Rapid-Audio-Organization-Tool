import type { ISongInfo } from 'src/types/globals'

export type AudioEditSongListRefreshRuntime = {
  playingData: {
    playingSongListUUID: string
    playingSongListData: ISongInfo[]
  }
  horizontalBrowseDecks: {
    topSongListUUID: string
    topSongListData: ISongInfo[]
    bottomSongListUUID: string
    bottomSongListData: ISongInfo[]
  }
}

const cloneSongList = (songs: ISongInfo[]) => songs.map((song) => ({ ...song }))

export const applyAudioEditSongListSnapshot = (
  runtime: AudioEditSongListRefreshRuntime,
  songListUUID: string,
  songs: ISongInfo[]
) => {
  const uuid = String(songListUUID || '').trim()
  if (!uuid || !Array.isArray(songs)) return
  const snapshot = cloneSongList(songs)
  if (runtime.horizontalBrowseDecks.topSongListUUID === uuid) {
    runtime.horizontalBrowseDecks.topSongListData = cloneSongList(snapshot)
  }
  if (runtime.horizontalBrowseDecks.bottomSongListUUID === uuid) {
    runtime.horizontalBrowseDecks.bottomSongListData = cloneSongList(snapshot)
  }
  if (runtime.playingData.playingSongListUUID === uuid) {
    runtime.playingData.playingSongListData = cloneSongList(snapshot)
  }
}
