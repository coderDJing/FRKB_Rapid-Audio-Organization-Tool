import type { ISongHotCue, ISongInfo } from 'src/types/globals'
import { mergeHorizontalBrowseSongWithHotCues } from '@renderer/components/horizontalBrowseShellSongs'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type SongHotCuePayload = {
  filePath?: string
  hotCues?: ISongHotCue[]
} | null

type UseHorizontalBrowseDeckHotCuesParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckMarkerPlacementSec: (deck: DeckKey) => number | null
  nativeTransport: {
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
  }
  commitDeckStatesToNative: () => Promise<unknown>
  syncDeckRenderState: () => void
  isDeckLoopActive: (deck: DeckKey) => boolean
}

export const useHorizontalBrowseDeckHotCues = (params: UseHorizontalBrowseDeckHotCuesParams) => {
  const patchDeckSongHotCues = (deck: DeckKey, hotCues: ISongHotCue[]) => {
    const currentSong = params.resolveDeckSong(deck)
    if (!currentSong) return
    params.setDeckSong(deck, {
      ...currentSong,
      hotCues
    })
  }

  const triggerDeckHotCuePlayback = async (deck: DeckKey, cueSec: number) => {
    const targetSec = Math.max(0, Number(cueSec) || 0)
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const wasPlaying = Boolean(snapshot.playing)
    await params.nativeTransport.seek(deck, targetSec)
    if (!wasPlaying && snapshot.syncEnabled && !params.isDeckLoopActive(deck)) {
      await params.commitDeckStatesToNative()
      await params.nativeTransport.beatsync(deck)
    }
    if (!wasPlaying) {
      await params.nativeTransport.setPlaying(deck, true)
    }
    params.syncDeckRenderState()
  }

  const handleDeckHotCuePress = async (deck: DeckKey, slot: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const existingHotCue = Array.isArray(song.hotCues)
      ? song.hotCues.find((item) => item.slot === slot)
      : null
    if (existingHotCue && Number.isFinite(Number(existingHotCue.sec))) {
      await triggerDeckHotCuePlayback(deck, Number(existingHotCue.sec))
      return
    }

    const snappedSec = params.resolveDeckMarkerPlacementSec(deck)
    if (snappedSec === null) return

    const result = (await window.electron.ipcRenderer.invoke('song:set-hot-cue', {
      filePath: song.filePath,
      slot,
      sec: snappedSec,
      durationSec: params.resolveDeckDurationSeconds(deck)
    })) as { hotCues?: ISongHotCue[] } | null
    const nextHotCues = Array.isArray(result?.hotCues)
      ? result.hotCues
      : [{ slot, sec: snappedSec }]
    patchDeckSongHotCues(deck, nextHotCues)
  }

  const handleDeckHotCueTrigger = async (deck: DeckKey, sec: number) => {
    await triggerDeckHotCuePlayback(deck, sec)
  }

  const handleDeckHotCueDelete = async (deck: DeckKey, slot: number) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    const existingHotCue = Array.isArray(song.hotCues)
      ? song.hotCues.find((item) => item.slot === slot)
      : null
    if (!existingHotCue) return

    const result = (await window.electron.ipcRenderer.invoke('song:delete-hot-cue', {
      filePath: song.filePath,
      slot,
      durationSec: params.resolveDeckDurationSeconds(deck)
    })) as { hotCues?: ISongHotCue[] } | null
    patchDeckSongHotCues(deck, Array.isArray(result?.hotCues) ? result.hotCues : [])
    params.syncDeckRenderState()
  }

  const handleSongHotCuesUpdated = (_event: unknown, payload: SongHotCuePayload) => {
    const topSong = params.resolveDeckSong('top')
    if (topSong) {
      const nextTopSong = mergeHorizontalBrowseSongWithHotCues(topSong, payload)
      if (nextTopSong !== topSong) {
        params.setDeckSong('top', nextTopSong)
      }
    }

    const bottomSong = params.resolveDeckSong('bottom')
    if (bottomSong) {
      const nextBottomSong = mergeHorizontalBrowseSongWithHotCues(bottomSong, payload)
      if (nextBottomSong !== bottomSong) {
        params.setDeckSong('bottom', nextBottomSong)
      }
    }
  }

  return {
    handleDeckHotCuePress,
    handleDeckHotCueTrigger,
    handleDeckHotCueDelete,
    handleSongHotCuesUpdated
  }
}
