import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import type { HorizontalBrowseDeckTransportStateOverride } from '@renderer/components/useHorizontalBrowseTransportMutations'
import {
  mergeHorizontalBrowseSongWithHotCues,
  mergeHorizontalBrowseSongWithMemoryCues,
  mergeHorizontalBrowseSongWithSharedGrid
} from '@renderer/components/horizontalBrowseShellSongs'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { resolveHorizontalBrowseInteractionElapsedMs } from '@renderer/components/horizontalBrowseInteractionTimeline'

type DeckKey = HorizontalBrowseDeckKey

type SharedSongGridPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
} | null

type CreateHorizontalBrowseDeckAssignerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  syncDeckDefaultCue: (deck: DeckKey, song: ISongInfo | null, force?: boolean) => void
  commitDeckStateToNative: (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => Promise<unknown>
}

export const createHorizontalBrowseDeckAssigner = (
  params: CreateHorizontalBrowseDeckAssignerParams
) => {
  const queueDeckSongPriorityAnalysis = (deck: DeckKey, song: ISongInfo | null | undefined) => {
    const filePath = String(song?.filePath || '').trim()
    if (!filePath) return
    window.electron.ipcRenderer.send('key-analysis:queue-playing', {
      filePath,
      focusSlot: `horizontal-browse-${deck}`
    })
  }

  const resolveDeckSongWithSharedGrid = async (song: ISongInfo) => {
    const filePath = String(song.filePath || '').trim()
    if (!filePath) return { ...song }
    const startedAt = performance.now()
    sendHorizontalBrowseInteractionTrace('resolve-deck-song:start', { filePath })
    try {
      const [payload, hotCuePayload, memoryCuePayload] = await Promise.all([
        window.electron.ipcRenderer.invoke('song:get-shared-grid-definition', { filePath }),
        window.electron.ipcRenderer.invoke('song:get-hot-cues', { filePath }),
        window.electron.ipcRenderer.invoke('song:get-memory-cues', { filePath })
      ])
      const resolvedHotCuePayload =
        Array.isArray(hotCuePayload) && hotCuePayload.length > 0
          ? { filePath, hotCues: hotCuePayload as ISongHotCue[] }
          : Array.isArray(song.hotCues) && song.hotCues.length > 0
            ? { filePath, hotCues: song.hotCues }
            : null
      const resolvedMemoryCuePayload =
        Array.isArray(memoryCuePayload) && memoryCuePayload.length > 0
          ? { filePath, memoryCues: memoryCuePayload as ISongMemoryCue[] }
          : Array.isArray(song.memoryCues) && song.memoryCues.length > 0
            ? { filePath, memoryCues: song.memoryCues }
            : null
      const merged = mergeHorizontalBrowseSongWithMemoryCues(
        mergeHorizontalBrowseSongWithHotCues(
          mergeHorizontalBrowseSongWithSharedGrid({ ...song }, payload as SharedSongGridPayload),
          resolvedHotCuePayload
        ),
        resolvedMemoryCuePayload
      )
      sendHorizontalBrowseInteractionTrace('resolve-deck-song:done', {
        filePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        hasGrid: Boolean(payload),
        hotCueCount: Array.isArray(hotCuePayload) ? hotCuePayload.length : 0,
        memoryCueCount: Array.isArray(memoryCuePayload) ? memoryCuePayload.length : 0
      })
      return merged
    } catch {
      sendHorizontalBrowseInteractionTrace('resolve-deck-song:error', {
        filePath,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1))
      })
      return { ...song }
    }
  }

  const assignSongToDeck = async (deck: DeckKey, song: ISongInfo) => {
    const startedAt = performance.now()
    const filePath = String(song.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace('assign-song:start', {
      deck,
      filePath,
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, filePath)
    })
    params.touchDeckInteraction(deck)
    const nextSong = await resolveDeckSongWithSharedGrid(song)
    const nextFilePath = String(nextSong.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace('assign-song:hydrated', {
      deck,
      filePath: nextFilePath,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, nextFilePath)
    })
    params.setDeckSong(deck, nextSong)
    queueDeckSongPriorityAnalysis(deck, nextSong)
    params.syncDeckDefaultCue(deck, nextSong, true)
    const nowMs = performance.now()
    await params.commitDeckStateToNative(deck, {
      currentSec: 0,
      lastObservedAtMs: nowMs,
      durationSec: parseHorizontalBrowseDurationToSeconds(nextSong.duration),
      playing: false,
      playbackRate: 1
    })
    sendHorizontalBrowseInteractionTrace('assign-song:done', {
      deck,
      filePath: nextFilePath,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, nextFilePath)
    })
  }

  return {
    assignSongToDeck
  }
}
