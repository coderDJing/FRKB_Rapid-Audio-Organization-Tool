import type { ISongInfo, ISongMemoryCue } from 'src/types/globals'
import { mergeHorizontalBrowseSongWithMemoryCues } from '@renderer/components/horizontalBrowseShellSongs'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { resolveNearestHotCueGridSec } from '@shared/hotCues'

type DeckKey = HorizontalBrowseDeckKey

type SongMemoryCuePayload = {
  filePath?: string
  memoryCues?: ISongMemoryCue[]
} | null

type UseHorizontalBrowseDeckMemoryCuesParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckGridBpm: (deck: DeckKey) => number
}

export const useHorizontalBrowseDeckMemoryCues = (
  params: UseHorizontalBrowseDeckMemoryCuesParams
) => {
  const resolveDeckMemoryCueAnchorSeconds = (deck: DeckKey) =>
    params.resolveDeckPlaying(deck)
      ? params.resolveDeckRenderCurrentSeconds(deck)
      : params.resolveDeckCurrentSeconds(deck)

  const patchDeckSongMemoryCues = (deck: DeckKey, memoryCues: ISongMemoryCue[]) => {
    const currentSong = params.resolveDeckSong(deck)
    if (!currentSong) return
    params.setDeckSong(deck, {
      ...currentSong,
      memoryCues
    })
  }

  const handleDeckMemoryCueCreate = async (deck: DeckKey) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const snappedSec = resolveNearestHotCueGridSec({
      currentSec: resolveDeckMemoryCueAnchorSeconds(deck),
      durationSec: params.resolveDeckDurationSeconds(deck),
      bpm: params.resolveDeckGridBpm(deck),
      firstBeatMs: song.firstBeatMs
    })
    if (snappedSec === null) return
    const result = (await window.electron.ipcRenderer.invoke('song:add-memory-cue', {
      filePath: song.filePath,
      sec: snappedSec,
      durationSec: params.resolveDeckDurationSeconds(deck)
    })) as { memoryCues?: ISongMemoryCue[] } | null
    patchDeckSongMemoryCues(deck, Array.isArray(result?.memoryCues) ? result.memoryCues : [])
  }

  const handleDeckMemoryCueDelete = async (deck: DeckKey, sec: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const result = (await window.electron.ipcRenderer.invoke('song:delete-memory-cue', {
      filePath: song.filePath,
      sec,
      durationSec: params.resolveDeckDurationSeconds(deck)
    })) as { memoryCues?: ISongMemoryCue[] } | null
    patchDeckSongMemoryCues(deck, Array.isArray(result?.memoryCues) ? result.memoryCues : [])
  }

  const handleSongMemoryCuesUpdated = (_event: unknown, payload: SongMemoryCuePayload) => {
    const topSong = params.resolveDeckSong('top')
    if (topSong) {
      const nextTopSong = mergeHorizontalBrowseSongWithMemoryCues(topSong, payload)
      if (nextTopSong !== topSong) {
        params.setDeckSong('top', nextTopSong)
      }
    }

    const bottomSong = params.resolveDeckSong('bottom')
    if (bottomSong) {
      const nextBottomSong = mergeHorizontalBrowseSongWithMemoryCues(bottomSong, payload)
      if (nextBottomSong !== bottomSong) {
        params.setDeckSong('bottom', nextBottomSong)
      }
    }
  }

  return {
    handleDeckMemoryCueCreate,
    handleDeckMemoryCueDelete,
    handleSongMemoryCuesUpdated
  }
}
