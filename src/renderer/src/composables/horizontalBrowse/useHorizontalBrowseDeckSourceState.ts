import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useRuntimeStore } from '@renderer/stores/runtime'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseDeckSongSourceOptions = {
  sourceSongListUUID?: string
  sourceSongListData?: ISongInfo[]
}

const cloneSongListSnapshot = (songs: ISongInfo[] | undefined): ISongInfo[] =>
  Array.isArray(songs) ? songs.map((song) => ({ ...song })) : []

export const useHorizontalBrowseDeckSourceState = () => {
  const runtime = useRuntimeStore()

  const resolveSongsAreaStateBySongListUUID = (songListUUID: string) => {
    const normalizedUUID = String(songListUUID || '').trim()
    if (!normalizedUUID) return null
    for (const pane of ['single', 'left', 'right'] as const) {
      const paneState = runtime.songsAreaPanels.panes[pane]
      if (paneState.songListUUID === normalizedUUID) return paneState
    }
    if (runtime.songsArea.songListUUID === normalizedUUID) return runtime.songsArea
    return null
  }

  const resolveSongListSnapshot = (
    songListUUID: string,
    fallbackSongs?: ISongInfo[]
  ): ISongInfo[] => {
    const fallbackSnapshot = cloneSongListSnapshot(fallbackSongs)
    if (fallbackSnapshot.length > 0) return fallbackSnapshot
    const paneSnapshot = cloneSongListSnapshot(
      resolveSongsAreaStateBySongListUUID(songListUUID)?.songInfoArr
    )
    if (paneSnapshot.length > 0) return paneSnapshot
    if (runtime.playingData.playingSongListUUID === songListUUID) {
      return cloneSongListSnapshot(runtime.playingData.playingSongListData)
    }
    return []
  }

  const resolveDeckSourceSnapshot = (deck: DeckKey) => {
    const sourceUUID =
      deck === 'top'
        ? runtime.horizontalBrowseDecks.topSongListUUID
        : runtime.horizontalBrowseDecks.bottomSongListUUID
    if (!sourceUUID) return null
    const sourceData =
      deck === 'top'
        ? runtime.horizontalBrowseDecks.topSongListData
        : runtime.horizontalBrowseDecks.bottomSongListData
    return {
      sourceUUID,
      sourceData
    }
  }

  const syncPlayingDataFromDeckSources = (preferredDeck?: DeckKey) => {
    const source =
      (preferredDeck ? resolveDeckSourceSnapshot(preferredDeck) : null) ||
      resolveDeckSourceSnapshot('top') ||
      resolveDeckSourceSnapshot('bottom')

    runtime.playingData.playingSong = null
    if (!source) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      return
    }

    runtime.playingData.playingSongListUUID = source.sourceUUID
    runtime.playingData.playingSongListData =
      source.sourceData.length > 0
        ? cloneSongListSnapshot(source.sourceData)
        : resolveSongListSnapshot(source.sourceUUID)
  }

  const setDeckSongListSource = (
    deck: DeckKey,
    sourceOptions: HorizontalBrowseDeckSongSourceOptions | undefined
  ) => {
    const sourceUUID = String(sourceOptions?.sourceSongListUUID || '').trim()
    if (!sourceUUID) return
    const sourceData = resolveSongListSnapshot(sourceUUID, sourceOptions?.sourceSongListData)
    if (deck === 'top') {
      runtime.horizontalBrowseDecks.topSongListUUID = sourceUUID
      runtime.horizontalBrowseDecks.topSongListData = sourceData
    } else {
      runtime.horizontalBrowseDecks.bottomSongListUUID = sourceUUID
      runtime.horizontalBrowseDecks.bottomSongListData = sourceData
    }
    syncPlayingDataFromDeckSources(deck)
  }

  const resolveDeckSongSourceOptions = (
    sourceOptions: HorizontalBrowseDeckSongSourceOptions | undefined
  ): HorizontalBrowseDeckSongSourceOptions => {
    const sourceSongListUUID = String(
      sourceOptions?.sourceSongListUUID || runtime.playingData.playingSongListUUID || ''
    ).trim()
    const sourceSongListData = Array.isArray(sourceOptions?.sourceSongListData)
      ? sourceOptions.sourceSongListData
      : runtime.playingData.playingSongListUUID === sourceSongListUUID
        ? runtime.playingData.playingSongListData
        : undefined
    return {
      sourceSongListUUID,
      sourceSongListData
    }
  }

  const clearDeckSongListSource = (deck: DeckKey) => {
    if (deck === 'top') {
      runtime.horizontalBrowseDecks.topSongListUUID = ''
      runtime.horizontalBrowseDecks.topSongListData = []
    } else {
      runtime.horizontalBrowseDecks.bottomSongListUUID = ''
      runtime.horizontalBrowseDecks.bottomSongListData = []
    }
    syncPlayingDataFromDeckSources()
  }

  const clearAllDeckSongListSources = () => {
    runtime.horizontalBrowseDecks.topSongListUUID = ''
    runtime.horizontalBrowseDecks.bottomSongListUUID = ''
    runtime.horizontalBrowseDecks.topSongListData = []
    runtime.horizontalBrowseDecks.bottomSongListData = []
    if (!runtime.playingData.playingSong) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
    }
  }

  return {
    resolveSongsAreaStateBySongListUUID,
    resolveSongListSnapshot,
    resolveDeckSongSourceOptions,
    setDeckSongListSource,
    clearDeckSongListSource,
    clearAllDeckSongListSources
  }
}
