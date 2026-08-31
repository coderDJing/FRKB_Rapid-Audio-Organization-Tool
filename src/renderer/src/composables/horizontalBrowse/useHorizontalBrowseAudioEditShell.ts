import { computed, type ComputedRef, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { useHorizontalBrowseAudioEditController } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseAudioEditController'
import type { HorizontalBrowseDragSessionEndPayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'
import type { DeckWaveformScrubPreviewPayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckPlaybackState'
import { resolveHorizontalBrowseAudioEditScrubPreview } from '@renderer/composables/horizontalBrowse/horizontalBrowseAudioEditScrub'

type DeckKey = HorizontalBrowseDeckKey

type NativeTransportSlice = {
  setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
  setDeckState: (
    deck: DeckKey,
    payload: {
      song: ISongInfo | null
      currentSec: number
      lastObservedAtMs: number
      durationSec: number
      playing: boolean
      playbackRate: number
      masterTempoEnabled: boolean
    }
  ) => Promise<unknown>
}

type UseHorizontalBrowseAudioEditShellParams = {
  isEditMode: ComputedRef<boolean>
  topDeckSong: Ref<ISongInfo | null>
  sourceDurationSec: ComputedRef<number>
  nativePlaying: ComputedRef<boolean>
  nativeSeconds: Ref<number> | ComputedRef<number>
  quantizeEnabled: { readonly value: boolean }
  nativePlayToggle: (deck: DeckKey) => void
  nativeSeek: (deck: DeckKey, seconds: number) => void
  nativeSeekPercent: (deck: DeckKey, percent: number) => void
  nativeSectionSeekPlay: (deck: DeckKey, seconds: number) => void
  nativeLoadEditAdjacentSong: (direction: -1 | 1) => boolean
  nativeJumpEditDeckByBeats: (direction: -1 | 1) => void
  editBeatStep: Ref<number>
  resolveDeckPlaying: (deck: DeckKey) => boolean
  assignSongToDeck: (deck: DeckKey, song: ISongInfo) => Promise<unknown>
  nativeTransport: NativeTransportSlice
  notifySeekIntent?: (seconds: number) => void
  nativeRawWaveformDragStart: (deck: DeckKey) => void
  nativeRawWaveformScrubPreview: (deck: DeckKey, payload: DeckWaveformScrubPreviewPayload) => void
  nativeRawWaveformDragEnd: (deck: DeckKey, payload: HorizontalBrowseDragSessionEndPayload) => void
  resolveCuePointSec?: () => number | null
  resolveLoopRange?: () => { startSec: number; endSec: number } | null
}

export const useHorizontalBrowseAudioEditShell = (
  params: UseHorizontalBrowseAudioEditShellParams
) => {
  const audioEdit = useHorizontalBrowseAudioEditController({
    isEditMode: params.isEditMode,
    song: params.topDeckSong,
    sourceDurationSec: params.sourceDurationSec,
    nativePlaying: params.nativePlaying,
    nativeSeconds: params.nativeSeconds,
    quantizeEnabled: params.quantizeEnabled,
    nativeSeek: (seconds) => params.nativeSeek('top', seconds),
    nativePause: async () => {
      await params.nativeTransport.setPlaying('top', false)
    },
    nativeReleaseFile: async () => {
      await params.nativeTransport.setPlaying('top', false)
      await params.nativeTransport.setDeckState('top', {
        song: null,
        currentSec: 0,
        lastObservedAtMs: performance.now(),
        durationSec: 0,
        playing: false,
        playbackRate: 1,
        masterTempoEnabled: true
      })
    },
    nativePlayToggle: () => params.nativePlayToggle('top'),
    reloadCurrentSong: async () => {
      const song = params.topDeckSong.value
      if (!song) return
      await params.assignSongToDeck('top', { ...song })
    },
    onPlayheadSeek: params.notifySeekIntent,
    resolveCuePointSec: params.resolveCuePointSec,
    resolveLoopRange: params.resolveLoopRange
  })

  let audioDragWasPlaying = false
  let audioDragPausePromise: Promise<void> | null = null

  const ownsAudioTransport = () => params.isEditMode.value && audioEdit.enabled.value
  const interactionLocked = () => params.isEditMode.value && audioEdit.saving.value

  const handleDeckPlayPauseToggle = (deck: DeckKey) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport()) {
      void audioEdit.handlePlayPause()
      return
    }
    params.nativePlayToggle(deck)
  }

  const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport()) {
      void audioEdit.handleSeek(seconds)
      return
    }
    params.nativeSeek(deck, seconds)
  }

  const handleDeckSectionSeekPlay = (deck: DeckKey, seconds: number) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport()) {
      void audioEdit.handleSeekAndPlay(seconds)
      return
    }
    params.nativeSectionSeekPlay(deck, seconds)
  }

  const handleDeckSeekPercent = (deck: DeckKey, percent: number) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport()) {
      void audioEdit.handleSeek(audioEdit.displayDuration.value * percent)
      return
    }
    params.nativeSeekPercent(deck, percent)
  }

  const loadEditAdjacentSong = (direction: -1 | 1) => {
    if (interactionLocked()) return false
    if (!params.isEditMode.value || !audioEdit.isDirty.value) {
      return params.nativeLoadEditAdjacentSong(direction)
    }
    void audioEdit.handleNavigate(direction, params.nativeLoadEditAdjacentSong)
    return false
  }

  const jumpEditDeckByBeats = (direction: -1 | 1) => {
    if (interactionLocked()) return
    if (ownsAudioTransport() && audioEdit.playback.ready.value) {
      void audioEdit.handleJumpBeats(direction, params.editBeatStep.value)
      return
    }
    params.nativeJumpEditDeckByBeats(direction)
  }

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport() && audioEdit.playback.ready.value) {
      audioDragWasPlaying = audioEdit.playback.playing.value
      audioDragPausePromise = audioDragWasPlaying ? audioEdit.playback.pause() : null
    } else {
      audioDragWasPlaying = false
      audioDragPausePromise = null
    }
    params.nativeRawWaveformDragStart(deck)
  }

  const handleDeckRawWaveformScrubPreview = (
    deck: DeckKey,
    payload: DeckWaveformScrubPreviewPayload
  ) => {
    if (deck === 'top' && interactionLocked()) return
    if (deck === 'top' && ownsAudioTransport() && audioEdit.playback.ready.value) {
      const sourcePreview = resolveHorizontalBrowseAudioEditScrubPreview(
        audioEdit.session.clips.value,
        payload
      )
      if (sourcePreview) params.nativeRawWaveformScrubPreview(deck, sourcePreview)
      return
    }
    params.nativeRawWaveformScrubPreview(deck, payload)
  }

  const handleDeckRawWaveformDragEnd = (
    deck: DeckKey,
    payload: HorizontalBrowseDragSessionEndPayload
  ) => {
    if (deck === 'top' && ownsAudioTransport() && audioEdit.playback.ready.value) {
      params.nativeRawWaveformDragEnd(deck, {
        ...payload,
        committed: false
      })
      const shouldResume = audioDragWasPlaying
      const pausePromise = audioDragPausePromise
      audioDragWasPlaying = false
      audioDragPausePromise = null
      void (async () => {
        if (pausePromise) await pausePromise
        if (payload.committed) {
          if (shouldResume) await audioEdit.handleSeekAndPlay(payload.anchorSec)
          else await audioEdit.handleSeek(payload.anchorSec)
          return
        }
        if (shouldResume) await audioEdit.playback.play()
      })()
      return
    }
    params.nativeRawWaveformDragEnd(deck, payload)
  }

  const gridEditMode = computed(() => params.isEditMode.value && audioEdit.subMode.value === 'grid')
  const topDeckVisibleCurrentSeconds = computed(() => audioEdit.displaySeconds.value)
  const topDeckVisibleDurationSeconds = computed(() => audioEdit.displayDuration.value)
  const topDeckVisiblePlaying = computed(() => audioEdit.displayPlaying.value)

  return {
    audioEdit,
    gridEditMode,
    topDeckVisibleCurrentSeconds,
    topDeckVisibleDurationSeconds,
    topDeckVisiblePlaying,
    handleDeckPlayPauseToggle,
    handleDeckPlayheadSeek,
    handleDeckSectionSeekPlay,
    handleDeckSeekPercent,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformScrubPreview,
    handleDeckRawWaveformDragEnd,
    loadEditAdjacentSong,
    jumpEditDeckByBeats
  }
}
