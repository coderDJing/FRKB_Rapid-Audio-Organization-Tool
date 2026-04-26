import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import {
  isSameHorizontalBrowseSongFilePath,
  mergeHorizontalBrowseSongWithSharedGrid
} from '@renderer/components/horizontalBrowseShellSongs'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBeatGridInput
} from '@renderer/components/horizontalBrowseNativeTransport'

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
  timeBasisOffsetMs?: number
} | null

type UseHorizontalBrowseDeckSongSyncParams = {
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  syncDeckDefaultCue: (deck: DeckKey, song: ISongInfo | null, force?: boolean) => void
  setDeckBeatGridToNative: (
    deck: DeckKey,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => Promise<unknown>
  assignSongToDeck: (deck: DeckKey, song: ISongInfo) => Promise<void>
}

export const useHorizontalBrowseDeckSongSync = (params: UseHorizontalBrowseDeckSongSyncParams) => {
  const patchDeckSongSharedGrid = (song: ISongInfo, payload: SharedSongGridPayload) => {
    const nextSong = mergeHorizontalBrowseSongWithSharedGrid(song, payload)
    if (nextSong === song) return false
    song.bpm = nextSong.bpm
    song.firstBeatMs = nextSong.firstBeatMs
    song.barBeatOffset = nextSong.barBeatOffset
    song.timeBasisOffsetMs = nextSong.timeBasisOffsetMs
    return true
  }

  const buildNativeGridPayload = (
    payload: SharedSongGridPayload
  ): HorizontalBrowseTransportBeatGridInput | null => {
    const filePath = String(payload?.filePath || '').trim()
    const bpm = Number(payload?.bpm)
    const firstBeatMs = Number(payload?.firstBeatMs)
    const timeBasisOffsetMs = Number(payload?.timeBasisOffsetMs)
    const hasBpm = Number.isFinite(bpm) && bpm > 0
    const hasFirstBeatMs = Number.isFinite(firstBeatMs)
    const hasTimeBasisOffsetMs = Number.isFinite(timeBasisOffsetMs) && timeBasisOffsetMs >= 0
    if (!filePath || (!hasBpm && !hasFirstBeatMs && !hasTimeBasisOffsetMs)) return null
    return {
      filePath,
      bpm: hasBpm ? bpm : undefined,
      firstBeatMs: hasFirstBeatMs ? firstBeatMs : undefined,
      timeBasisOffsetMs: hasTimeBasisOffsetMs ? timeBasisOffsetMs : undefined
    }
  }

  const handleExternalDeckSongLoad = (payload: HorizontalBrowseLoadSongPayload) => {
    const deck = payload?.deck
    const song = payload?.song
    if (!deck || !song) return
    void params.assignSongToDeck(deck, { ...song })
  }

  const handleSongGridUpdated = (_event: unknown, payload: SharedSongGridPayload) => {
    const nativeGridPayload = buildNativeGridPayload(payload)
    const nativeUpdates: Promise<unknown>[] = []
    let touched = false
    const topSong = params.topDeckSong.value
    if (topSong) {
      if (patchDeckSongSharedGrid(topSong, payload)) {
        params.setDeckSong('top', topSong)
        params.syncDeckDefaultCue('top', topSong)
        if (nativeGridPayload) {
          nativeUpdates.push(params.setDeckBeatGridToNative('top', nativeGridPayload))
        }
        touched = true
      }
    }

    const bottomSong = params.bottomDeckSong.value
    if (bottomSong) {
      if (patchDeckSongSharedGrid(bottomSong, payload)) {
        params.setDeckSong('bottom', bottomSong)
        params.syncDeckDefaultCue('bottom', bottomSong)
        if (nativeGridPayload) {
          nativeUpdates.push(params.setDeckBeatGridToNative('bottom', nativeGridPayload))
        }
        touched = true
      }
    }

    if (!touched || nativeUpdates.length === 0) {
      return
    }
    void Promise.allSettled(nativeUpdates)
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
    disposeSongSync() {},
    handleExternalDeckSongLoad,
    handleSongGridUpdated,
    handleSongKeyUpdated
  }
}
