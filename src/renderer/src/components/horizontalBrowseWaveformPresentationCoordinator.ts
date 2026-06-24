import { reactive } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type {
  HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis,
  HorizontalBrowseLinkedGridVisualTransactionPlaybackClock,
  HorizontalBrowseLinkedGridVisualTransactionResult,
  HorizontalBrowseLinkedGridVisualTransactionResults
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'
type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseWaveformPresentationOwner =
  | 'idle'
  | 'playback'
  | 'seek'
  | 'drag'
  | 'linked-drag'
  | 'zoom'
  | 'linked-zoom'
  | 'sync-transaction'
  | 'linked-playback'
  | 'grid-edit'
  | 'load'
  | 'worker-ready'

export type HorizontalBrowseWaveformPresentationSurfaceMode = 'dual-detail' | 'edit-detail'

export type HorizontalBrowseWaveformPresentationState = {
  owner: HorizontalBrowseWaveformPresentationOwner
  revision: number
  sourceDeck: DeckKey | null
  affectedDecks: DeckKey[]
  anchorSec: number | null
  viewportStartSec: number | null
  visibleDurationSec: number | null
  anchorRatio: number
  zoom: number | null
  timeScale: number
  gridTimeBasis: {
    bpm: number
    firstBeatMs: number
    barBeatOffset: number
    timeBasisOffsetMs: number
  } | null
  playbackClock: {
    seconds: number
    startedAtMs: number
    playbackRate: number
  } | null
  surfaceMode: HorizontalBrowseWaveformPresentationSurfaceMode
  linked: boolean
  visualPending: boolean
  updatedAtMs: number
}

const createDefaultPresentationState = (
  surfaceMode: HorizontalBrowseWaveformPresentationSurfaceMode
): HorizontalBrowseWaveformPresentationState => ({
  owner: 'idle',
  revision: 0,
  sourceDeck: null,
  affectedDecks: [],
  anchorSec: null,
  viewportStartSec: null,
  visibleDurationSec: null,
  anchorRatio: 0.5,
  zoom: null,
  timeScale: 1,
  gridTimeBasis: null,
  playbackClock: null,
  surfaceMode,
  linked: false,
  visualPending: false,
  updatedAtMs: 0
})

type PresentationPatch = Partial<
  Omit<HorizontalBrowseWaveformPresentationState, 'revision' | 'updatedAtMs'>
>

type PresentationDeckPatch = Partial<Record<DeckKey, PresentationPatch>>
export type HorizontalBrowseClearLinkedPresentationDeckState = {
  currentSec: number
  playbackRate: number
  playing: boolean
  startedAtMs: number
}
export type HorizontalBrowseClearLinkedPresentationState = Partial<
  Record<DeckKey, HorizontalBrowseClearLinkedPresentationDeckState>
>

const buildNextPresentationState = (
  previousState: HorizontalBrowseWaveformPresentationState,
  patch: PresentationPatch,
  revision: number,
  updatedAtMs: number
): HorizontalBrowseWaveformPresentationState => ({
  ...previousState,
  ...patch,
  affectedDecks: patch.affectedDecks ? [...patch.affectedDecks] : previousState.affectedDecks,
  revision,
  updatedAtMs
})

const resolveOptionalNumber = (value: unknown) =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null

const normalizeGridTimeBasis = (
  value: HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis | null | undefined
) => {
  if (!value) return null
  return {
    bpm: Number(value.bpm) || 0,
    firstBeatMs: Number(value.firstBeatMs) || 0,
    barBeatOffset: Number(value.barBeatOffset) || 0,
    timeBasisOffsetMs: Number(value.timeBasisOffsetMs) || 0
  }
}

const normalizePlaybackClock = (
  value: HorizontalBrowseLinkedGridVisualTransactionPlaybackClock | null | undefined
) => {
  if (!value) return null
  const seconds = resolveOptionalNumber(value.seconds)
  const startedAtMs = resolveOptionalNumber(value.startedAtMs)
  if (seconds === null || startedAtMs === null) return null
  return {
    seconds,
    startedAtMs,
    playbackRate: Math.max(0.25, Number(value.playbackRate) || 1)
  }
}

const buildSyncCommitPatch = (
  result: HorizontalBrowseLinkedGridVisualTransactionResult,
  sourceDeck: DeckKey,
  affectedDecks: DeckKey[]
): PresentationPatch => ({
  owner: 'linked-playback',
  sourceDeck,
  affectedDecks,
  anchorSec: resolveOptionalNumber(result.anchorSec),
  viewportStartSec: resolveOptionalNumber(result.viewportStartSec),
  visibleDurationSec: resolveOptionalNumber(result.visibleDurationSec),
  anchorRatio: Math.max(0, Math.min(1, Number(result.anchorRatio) || 0.5)),
  timeScale: Math.max(0.25, Number(result.timeScale) || 1),
  gridTimeBasis: normalizeGridTimeBasis(result.gridTimeBasis),
  playbackClock: normalizePlaybackClock(result.playbackClock),
  surfaceMode: 'dual-detail',
  linked: true,
  visualPending: false
})

const buildClearLinkedPresentationPatch = (
  playbackState: HorizontalBrowseClearLinkedPresentationDeckState | undefined
): PresentationPatch => {
  const anchorSec = resolveOptionalNumber(playbackState?.currentSec)
  const playbackRate = Math.max(0.25, Number(playbackState?.playbackRate) || 1)
  const startedAtMs = resolveOptionalNumber(playbackState?.startedAtMs)
  const playing = playbackState?.playing === true
  return {
    owner: playing ? 'playback' : 'idle',
    sourceDeck: null,
    affectedDecks: ['top', 'bottom'],
    anchorSec,
    viewportStartSec: null,
    visibleDurationSec: null,
    zoom: null,
    timeScale: 1,
    gridTimeBasis: null,
    playbackClock:
      playing && anchorSec !== null && startedAtMs !== null
        ? {
            seconds: anchorSec,
            startedAtMs,
            playbackRate
          }
        : null,
    linked: false,
    visualPending: false,
    surfaceMode: 'dual-detail'
  }
}

export const useHorizontalBrowseWaveformPresentationCoordinator = () => {
  let revision = 0
  const state = reactive<Record<DeckKey, HorizontalBrowseWaveformPresentationState>>({
    top: createDefaultPresentationState('dual-detail'),
    bottom: createDefaultPresentationState('dual-detail')
  })

  const commitDeck = (deck: DeckKey, patch: PresentationPatch) => {
    const nextRevision = (revision += 1)
    const nextState = buildNextPresentationState(
      state[deck],
      patch,
      nextRevision,
      performance.now()
    )
    state[deck] = nextState
  }

  const commitDecks = (decks: DeckKey[], patch: PresentationPatch) => {
    const nextRevision = (revision += 1)
    const updatedAtMs = performance.now()
    decks.forEach((deck) => {
      const nextState = buildNextPresentationState(state[deck], patch, nextRevision, updatedAtMs)
      state[deck] = nextState
    })
  }

  const commitDeckPatches = (patches: PresentationDeckPatch) => {
    const nextRevision = (revision += 1)
    const updatedAtMs = performance.now()
    const decks: DeckKey[] = ['top', 'bottom']
    decks.forEach((deck) => {
      const patch = patches[deck]
      if (!patch) return
      const nextState = buildNextPresentationState(state[deck], patch, nextRevision, updatedAtMs)
      state[deck] = nextState
    })
  }

  const resolveSyncDecks = (leader: DeckKey, follower: DeckKey): DeckKey[] =>
    leader === follower ? ['top', 'bottom'] : [leader, follower]

  const setSurfaceMode = (
    deck: DeckKey,
    surfaceMode: HorizontalBrowseWaveformPresentationSurfaceMode
  ) => commitDeck(deck, { surfaceMode })

  const markSeek = (deck: DeckKey, seconds: number) =>
    commitDeck(deck, {
      owner: 'seek',
      sourceDeck: deck,
      affectedDecks: [deck],
      anchorSec: Number(seconds) || 0,
      viewportStartSec: null,
      visibleDurationSec: null,
      playbackClock: null,
      linked: false,
      visualPending: false
    })

  const markDragPreview = (
    deck: DeckKey,
    anchorSec: number,
    linked: boolean,
    linkedAnchors: Partial<Record<DeckKey, number>> = {}
  ) => {
    if (linked) {
      const affectedDecks: DeckKey[] = ['top', 'bottom']
      commitDeckPatches({
        top: {
          owner: 'linked-drag',
          sourceDeck: deck,
          affectedDecks,
          anchorSec: Number(linkedAnchors.top ?? anchorSec) || 0,
          linked: true,
          visualPending: false
        },
        bottom: {
          owner: 'linked-drag',
          sourceDeck: deck,
          affectedDecks,
          anchorSec: Number(linkedAnchors.bottom ?? anchorSec) || 0,
          linked: true,
          visualPending: false
        }
      })
      return
    }
    commitDeck(deck, {
      owner: linked ? 'linked-drag' : 'drag',
      sourceDeck: deck,
      affectedDecks: [deck],
      anchorSec: Number(anchorSec) || 0,
      linked: false,
      visualPending: false
    })
  }

  const clearDrag = (deck: DeckKey, linkedActive = state[deck].linked) => {
    const currentState = state[deck]
    if (currentState.owner !== 'drag' && currentState.owner !== 'linked-drag') return
    const wasLinkedDrag = currentState.owner === 'linked-drag' || currentState.linked
    const affectedDecks = wasLinkedDrag
      ? currentState.affectedDecks.length
        ? currentState.affectedDecks
        : (['top', 'bottom'] as DeckKey[])
      : [deck]
    if (wasLinkedDrag && linkedActive) {
      commitDecks(affectedDecks, {
        owner: 'linked-playback',
        sourceDeck: deck,
        affectedDecks,
        viewportStartSec: null,
        playbackClock: null,
        linked: true,
        visualPending: false,
        surfaceMode: 'dual-detail'
      })
      return
    }
    commitDecks(affectedDecks, {
      owner: 'playback',
      sourceDeck: deck,
      affectedDecks,
      linked: false,
      visualPending: false
    })
  }

  const markZoom = (
    deck: DeckKey,
    zoom: number,
    anchorRatio: number,
    linked: boolean,
    options: {
      affectedDecks?: DeckKey[]
      anchorSec?: number | null
      viewportStartSec?: number | null
      visibleDurationSec?: number | null
      timeScale?: number | null
    } = {}
  ) => {
    const affectedDecks = options.affectedDecks ?? (linked ? ['top', 'bottom'] : [deck])
    const normalizedAnchorRatio = Math.max(0, Math.min(1, Number(anchorRatio) || 0.5))
    const normalizedZoom = Number(zoom) || null
    const resolveZoomTimeScale = (targetDeck: DeckKey) =>
      Math.max(0.25, Number(options.timeScale) || Number(state[targetDeck].timeScale) || 1)
    const resolveZoomPlaybackClock = (targetDeck: DeckKey) => {
      const currentState = state[targetDeck]
      if (currentState.owner === 'linked-playback' || currentState.owner === 'linked-zoom') {
        return currentState.playbackClock
      }
      return null
    }
    const buildPatch = (
      targetDeck: DeckKey,
      includeSourceViewport: boolean
    ): PresentationPatch => ({
      owner: linked ? 'linked-zoom' : 'zoom',
      sourceDeck: deck,
      affectedDecks,
      anchorSec: includeSourceViewport ? resolveOptionalNumber(options.anchorSec) : null,
      viewportStartSec: includeSourceViewport
        ? resolveOptionalNumber(options.viewportStartSec)
        : null,
      visibleDurationSec: includeSourceViewport
        ? resolveOptionalNumber(options.visibleDurationSec)
        : null,
      zoom: normalizedZoom,
      anchorRatio: normalizedAnchorRatio,
      timeScale: resolveZoomTimeScale(targetDeck),
      playbackClock: resolveZoomPlaybackClock(targetDeck),
      linked,
      visualPending: false
    })
    if (linked) {
      const patches = affectedDecks.reduce<PresentationDeckPatch>((result, targetDeck) => {
        result[targetDeck] = buildPatch(targetDeck, targetDeck === deck)
        return result
      }, {})
      commitDeckPatches(patches)
    } else {
      commitDecks(affectedDecks, buildPatch(deck, true))
    }
  }

  const beginSyncTransaction = (leader: DeckKey, follower: DeckKey) => {
    const affectedDecks = resolveSyncDecks(leader, follower)
    commitDecks(affectedDecks, {
      owner: 'sync-transaction',
      sourceDeck: leader,
      affectedDecks,
      linked: true,
      visualPending: true,
      surfaceMode: 'dual-detail'
    })
  }

  const finishSyncTransaction = (
    leader: DeckKey,
    follower: DeckKey,
    committed: boolean,
    results: HorizontalBrowseLinkedGridVisualTransactionResults = {}
  ) => {
    const affectedDecks = resolveSyncDecks(leader, follower)
    const topResult = results.top
    const bottomResult = results.bottom
    const canCommit = committed && topResult?.committed === true && bottomResult?.committed === true
    if (!canCommit) {
      commitDecks(affectedDecks, {
        owner: 'idle',
        sourceDeck: leader,
        affectedDecks,
        linked: false,
        visualPending: false,
        gridTimeBasis: null,
        playbackClock: null,
        anchorSec: null,
        viewportStartSec: null,
        visibleDurationSec: null,
        timeScale: 1
      })
      return
    }
    commitDeckPatches({
      top: buildSyncCommitPatch(topResult, leader, affectedDecks),
      bottom: buildSyncCommitPatch(bottomResult, leader, affectedDecks)
    })
  }

  const clearLinkedPresentation = (
    playbackStates: HorizontalBrowseClearLinkedPresentationState = {}
  ) => {
    commitDeckPatches({
      top: buildClearLinkedPresentationPatch(playbackStates.top),
      bottom: buildClearLinkedPresentationPatch(playbackStates.bottom)
    })
  }

  return {
    state,
    setSurfaceMode,
    markSeek,
    markDragPreview,
    clearDrag,
    markZoom,
    beginSyncTransaction,
    finishSyncTransaction,
    clearLinkedPresentation
  }
}
