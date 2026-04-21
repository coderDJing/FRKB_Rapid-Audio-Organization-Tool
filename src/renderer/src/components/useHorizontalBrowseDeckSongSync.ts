import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  isSameHorizontalBrowseSongFilePath,
  mergeHorizontalBrowseSongWithSharedGrid
} from '@renderer/components/horizontalBrowseShellSongs'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type HorizontalBrowseLoadSongPayload = {
  deck?: DeckKey
  song?: ISongInfo | null
}

type SharedSongGridPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
} | null

type UseHorizontalBrowseDeckSongSyncParams = {
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  syncDeckDefaultCue: (deck: DeckKey, song: ISongInfo | null, force?: boolean) => void
  commitDeckStatesToNative: () => Promise<unknown>
  assignSongToDeck: (deck: DeckKey, song: ISongInfo) => Promise<void>
}

const GRID_SYNC_COMMIT_DEBOUNCE_MS = 120

export const useHorizontalBrowseDeckSongSync = (params: UseHorizontalBrowseDeckSongSyncParams) => {
  let gridSyncCommitTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleDeckStateCommit = () => {
    if (gridSyncCommitTimer) clearTimeout(gridSyncCommitTimer)
    gridSyncCommitTimer = setTimeout(() => {
      gridSyncCommitTimer = null
      void params.commitDeckStatesToNative()
    }, GRID_SYNC_COMMIT_DEBOUNCE_MS)
  }

  const handleExternalDeckSongLoad = (payload: HorizontalBrowseLoadSongPayload) => {
    const deck = payload?.deck
    const song = payload?.song
    if (!deck || !song) return
    void params.assignSongToDeck(deck, { ...song })
  }

  const handleSongGridUpdated = (_event: unknown, payload: SharedSongGridPayload) => {
    let touched = false
    const topSong = params.topDeckSong.value
    if (topSong) {
      const nextTopSong = mergeHorizontalBrowseSongWithSharedGrid(topSong, payload)
      if (nextTopSong !== topSong) {
        params.setDeckSong('top', nextTopSong)
        params.syncDeckDefaultCue('top', nextTopSong)
        touched = true
      }
    }

    const bottomSong = params.bottomDeckSong.value
    if (bottomSong) {
      const nextBottomSong = mergeHorizontalBrowseSongWithSharedGrid(bottomSong, payload)
      if (nextBottomSong !== bottomSong) {
        params.setDeckSong('bottom', nextBottomSong)
        params.syncDeckDefaultCue('bottom', nextBottomSong)
        touched = true
      }
    }

    if (touched) {
      scheduleDeckStateCommit()
    }
  }

  const handleSongKeyUpdated = (
    _event: unknown,
    payload: { filePath?: string; keyText?: string }
  ) => {
    const filePath = String(payload?.filePath || '').trim()
    const keyText = String(payload?.keyText || '').trim()
    if (!filePath || !keyText) return

    const patchDeckSongKey = (deck: DeckKey) => {
      const currentSong = params.resolveDeckSong(deck)
      if (!currentSong) return
      if (!isSameHorizontalBrowseSongFilePath(currentSong.filePath, filePath)) return
      if (String(currentSong.key || '').trim() === keyText) return
      params.setDeckSong(deck, {
        ...currentSong,
        key: keyText
      })
    }

    patchDeckSongKey('top')
    patchDeckSongKey('bottom')
  }

  return {
    disposeSongSync() {
      if (!gridSyncCommitTimer) return
      clearTimeout(gridSyncCommitTimer)
      gridSyncCommitTimer = null
    },
    handleExternalDeckSongLoad,
    handleSongGridUpdated,
    handleSongKeyUpdated
  }
}
