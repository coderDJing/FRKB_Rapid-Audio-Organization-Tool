import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'
import type { HorizontalBrowseDeckTransportStateOverride } from '@renderer/components/useHorizontalBrowseTransportMutations'
import type { HorizontalBrowseDeckAssignTransportOptions } from '@renderer/components/horizontalBrowseDeckAssignment'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import type { HorizontalBrowseViewMode } from '@renderer/components/horizontalBrowseModeShellTypes'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  clonePlaybackHandoffSong,
  clonePlaybackHandoffSongList,
  isMainWindowPlaybackSnapshotRequest,
  normalizePlaybackHandoffSeconds,
  type MainWindowBrowseMode,
  type MainWindowPlaybackHandoff,
  type MainWindowPlaybackSnapshot
} from '@renderer/utils/mainWindowPlaybackHandoff'

type DeckKey = HorizontalBrowseDeckKey
type RuntimeStore = ReturnType<typeof useRuntimeStore>

type DeckSyncState = {
  leaderDeck?: string | null
}

type FaderPanelRef = Ref<{
  syncCrossfaderValue?: (value: number) => void
} | null>

type UseHorizontalBrowseModePlaybackHandoffParams = {
  runtime: RuntimeStore
  horizontalBrowseViewMode: Ref<HorizontalBrowseViewMode>
  deckSyncState: DeckSyncState
  faderPanelRef: FaderPanelRef
  clearAllDeckCueMonitor: () => void
  stopAllDeckCuePreview: () => void
  resetAllDeckTempoNudgePlaybackRates: (playbackRate?: number) => Promise<void>
  deactivateDualTransportSync: () => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    setPlaybackRate: (deck: DeckKey, playbackRate: number) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  setDeckSong: (deck: DeckKey, song: ISongInfo | null) => void
  assignSongToDeck: (
    deck: DeckKey,
    song: ISongInfo,
    sourceOptions?: { sourceSongListUUID?: string; sourceSongListData?: ISongInfo[] },
    transportOptions?: HorizontalBrowseDeckAssignTransportOptions
  ) => Promise<void>
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  commitDeckStateToNative: (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => Promise<unknown>
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  handleDeckPlayPauseToggle: (deck: DeckKey) => void
}

export const useHorizontalBrowseModePlaybackHandoff = (
  params: UseHorizontalBrowseModePlaybackHandoffParams
) => {
  const playbackHandoffReady = ref(false)
  const editModeTransitionPending = ref(false)
  const suppressEditWaveformLoadingPauseForHandoff = ref(false)
  const isEditMode = computed(() => params.horizontalBrowseViewMode.value === 'edit')
  let applyingPlaybackHandoffId = 0
  let suppressEditWaveformLoadingPauseTimer: number | null = null

  const resolveCurrentShellBrowseMode = (): MainWindowBrowseMode =>
    params.horizontalBrowseViewMode.value === 'edit' ? 'edit' : 'horizontal'

  const clearEditWaveformLoadingPauseSuppression = () => {
    suppressEditWaveformLoadingPauseForHandoff.value = false
    if (suppressEditWaveformLoadingPauseTimer !== null) {
      window.clearTimeout(suppressEditWaveformLoadingPauseTimer)
      suppressEditWaveformLoadingPauseTimer = null
    }
  }

  const suppressNextEditWaveformLoadingPauseForHandoff = () => {
    clearEditWaveformLoadingPauseSuppression()
    suppressEditWaveformLoadingPauseForHandoff.value = true
    suppressEditWaveformLoadingPauseTimer = window.setTimeout(() => {
      suppressEditWaveformLoadingPauseForHandoff.value = false
      suppressEditWaveformLoadingPauseTimer = null
    }, 5000)
  }

  const enterEditMode = async () => {
    params.stopAllDeckCuePreview()
    params.faderPanelRef.value?.syncCrossfaderValue?.(0)
    if (params.resolveDeckPlaying('top')) await params.nativeTransport.setPlaying('top', false)
    params.setDeckSong('bottom', null)
    await params.commitDeckStateToNative('bottom', {
      currentSec: 0,
      durationSec: 0,
      playing: false,
      playbackRate: 1
    })
    if (params.deckSyncState.leaderDeck === 'bottom') {
      await params.nativeTransport.setLeader(params.resolveDeckSong('top') ? 'top' : null)
    }
    params.syncDeckRenderState({ force: 'all' })
  }

  const handleEditWaveformLoadingChange = (loading: boolean) => {
    if (!loading) {
      clearEditWaveformLoadingPauseSuppression()
      return
    }
    if (suppressEditWaveformLoadingPauseForHandoff.value) return
    if (!isEditMode.value || !params.resolveDeckPlaying('top')) return
    void params.nativeTransport
      .setPlaying('top', false)
      .catch((error) =>
        console.error('[horizontal-browse] pause edit waveform loading failed', error)
      )
      .finally(() => params.syncDeckRenderState({ force: 'top' }))
  }

  const resolvePlaybackHandoffSourceDeck = (): DeckKey | null => {
    const leaderDeck =
      params.deckSyncState.leaderDeck === 'top' || params.deckSyncState.leaderDeck === 'bottom'
        ? params.deckSyncState.leaderDeck
        : null
    if (leaderDeck === 'bottom' && params.resolveDeckSong('bottom')) return 'bottom'
    if (leaderDeck === 'top' && params.resolveDeckSong('top')) return 'top'
    if (params.resolveDeckPlaying('top') && params.resolveDeckSong('top')) return 'top'
    if (params.resolveDeckPlaying('bottom') && params.resolveDeckSong('bottom')) return 'bottom'
    if (params.resolveDeckSong('top')) return 'top'
    if (params.resolveDeckSong('bottom')) return 'bottom'
    return null
  }

  const buildDeckPlaybackSnapshot = (): MainWindowPlaybackSnapshot | null => {
    const sourceMode = resolveCurrentShellBrowseMode()
    const sourceDeck = resolvePlaybackHandoffSourceDeck()
    if (!sourceDeck) return null
    const song = params.resolveDeckSong(sourceDeck)
    if (!song) return null
    const durationSec = params.resolveDeckDurationSeconds(sourceDeck)
    const currentSec = params.resolveDeckPlaying(sourceDeck)
      ? params.resolveDeckRenderCurrentSeconds(sourceDeck)
      : params.resolveDeckCurrentSeconds(sourceDeck)
    const songListUUID =
      sourceDeck === 'top'
        ? params.runtime.horizontalBrowseDecks.topSongListUUID
        : params.runtime.horizontalBrowseDecks.bottomSongListUUID
    const songListData =
      sourceDeck === 'top'
        ? params.runtime.horizontalBrowseDecks.topSongListData
        : params.runtime.horizontalBrowseDecks.bottomSongListData
    return {
      sourceMode,
      song: clonePlaybackHandoffSong(song),
      songListUUID: String(songListUUID || '').trim(),
      songListData: clonePlaybackHandoffSongList(songListData),
      currentSec: normalizePlaybackHandoffSeconds(currentSec, durationSec),
      shouldPlay: params.resolveDeckPlaying(sourceDeck)
    }
  }

  const handleMainWindowPlaybackSnapshotRequest = (payload: unknown) => {
    if (!isMainWindowPlaybackSnapshotRequest(payload)) return
    if (payload.sourceMode === 'browser') return
    if (payload.sourceMode !== resolveCurrentShellBrowseMode()) return
    if (params.runtime.mainWindowBrowseMode !== payload.sourceMode) return
    payload.respond(buildDeckPlaybackSnapshot())
  }

  const resetTransportPlaybackStateForHandoff = async (currentSec: number) => {
    params.deactivateDualTransportSync()
    await Promise.all([
      params.nativeTransport.setSyncEnabled('top', false),
      params.nativeTransport.setSyncEnabled('bottom', false)
    ])
    await params.nativeTransport.setLeader(null)
    await params.resetAllDeckTempoNudgePlaybackRates(1)
    await params.nativeTransport.setPlaybackRate('top', 1)
    await params.commitDeckStateToNative('top', {
      currentSec,
      lastObservedAtMs: performance.now(),
      playing: false,
      playbackRate: 1
    })
    await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
  }

  const applyPlaybackHandoffToTopDeck = async (handoff: MainWindowPlaybackHandoff) => {
    if (applyingPlaybackHandoffId === handoff.id) return
    applyingPlaybackHandoffId = handoff.id
    params.runtime.mainWindowPlaybackHandoff = null
    try {
      const currentSec = normalizePlaybackHandoffSeconds(
        handoff.currentSec,
        parseHorizontalBrowseDurationToSeconds(handoff.song.duration)
      )
      await params.assignSongToDeck(
        'top',
        clonePlaybackHandoffSong(handoff.song),
        {
          sourceSongListUUID: handoff.songListUUID,
          sourceSongListData: clonePlaybackHandoffSongList(handoff.songListData)
        },
        {
          initialCurrentSec: currentSec,
          waitForHydration: false,
          applyHydratedCue: false
        }
      )
      await resetTransportPlaybackStateForHandoff(currentSec)
      params.notifyDeckSeekIntent('top', currentSec)
      params.syncDeckRenderState({ force: 'top' })
      if (handoff.shouldPlay) {
        suppressNextEditWaveformLoadingPauseForHandoff()
        params.handleDeckPlayPauseToggle('top')
      }
    } catch (error) {
      throw error
    } finally {
      applyingPlaybackHandoffId = 0
    }
  }

  watch(isEditMode, (editMode) => {
    if (!editMode) return
    params.clearAllDeckCueMonitor()
    editModeTransitionPending.value = true
    void enterEditMode()
      .catch((error) => {
        console.error('[horizontal-browse] enter edit mode failed', error)
      })
      .finally(() => {
        editModeTransitionPending.value = false
      })
  })

  watch(
    () =>
      [
        params.runtime.mainWindowPlaybackHandoff?.id ?? 0,
        params.runtime.mainWindowPlaybackHandoff?.targetMode ?? 'browser',
        params.horizontalBrowseViewMode.value,
        playbackHandoffReady.value,
        editModeTransitionPending.value
      ] as const,
    () => {
      if (!playbackHandoffReady.value) return
      if (editModeTransitionPending.value) return
      const handoff = params.runtime.mainWindowPlaybackHandoff
      if (!handoff) return
      if (handoff.targetMode === 'browser') return
      if (handoff.targetMode !== resolveCurrentShellBrowseMode()) return
      void applyPlaybackHandoffToTopDeck(handoff).catch((error) => {
        console.error('[horizontal-browse] apply playback handoff failed', error)
      })
    },
    { immediate: true }
  )

  const markPlaybackHandoffReady = () => {
    playbackHandoffReady.value = true
  }

  const clearPlaybackHandoffRuntimeState = () => {
    clearEditWaveformLoadingPauseSuppression()
    playbackHandoffReady.value = false
  }

  const syncDeckDataToPlayingData = () => {
    const playbackHandoff = params.runtime.mainWindowPlaybackHandoff
    if (playbackHandoff?.targetMode === 'browser') {
      params.runtime.playingData.playingSong = clonePlaybackHandoffSong(playbackHandoff.song)
      params.runtime.playingData.playingSongListUUID = String(
        playbackHandoff.songListUUID || ''
      ).trim()
      params.runtime.playingData.playingSongListData = clonePlaybackHandoffSongList(
        playbackHandoff.songListData
      )
      return
    }

    const sourceDeck = params.deckSyncState.leaderDeck === 'bottom' ? 'bottom' : 'top'
    const song = params.resolveDeckSong(sourceDeck)
    if (!song) return

    params.runtime.playingData.playingSong = clonePlaybackHandoffSong(song)
    const songListUUID =
      sourceDeck === 'top'
        ? params.runtime.horizontalBrowseDecks.topSongListUUID
        : params.runtime.horizontalBrowseDecks.bottomSongListUUID
    const songListData =
      sourceDeck === 'top'
        ? params.runtime.horizontalBrowseDecks.topSongListData
        : params.runtime.horizontalBrowseDecks.bottomSongListData
    if (songListUUID) {
      params.runtime.playingData.playingSongListUUID = songListUUID
    }
    if (songListData.length > 0) {
      params.runtime.playingData.playingSongListData = clonePlaybackHandoffSongList(songListData)
    }
  }

  onScopeDispose(clearPlaybackHandoffRuntimeState)

  return {
    handleEditWaveformLoadingChange,
    handleMainWindowPlaybackSnapshotRequest,
    markPlaybackHandoffReady,
    clearPlaybackHandoffRuntimeState,
    syncDeckDataToPlayingData
  }
}
