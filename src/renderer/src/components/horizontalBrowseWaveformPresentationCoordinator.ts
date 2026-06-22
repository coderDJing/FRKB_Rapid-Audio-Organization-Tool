import { reactive } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'

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
const resolveOptionalNumber = (value: unknown) =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null

export const useHorizontalBrowseWaveformPresentationCoordinator = () => {
  let revision = 0
  const state = reactive<Record<DeckKey, HorizontalBrowseWaveformPresentationState>>({
    top: createDefaultPresentationState('dual-detail'),
    bottom: createDefaultPresentationState('dual-detail')
  })

  const commitDeck = (deck: DeckKey, patch: PresentationPatch) => {
    const nextRevision = (revision += 1)
    Object.assign(state[deck], {
      ...patch,
      revision: nextRevision,
      updatedAtMs: performance.now()
    })
  }

  const commitDecks = (decks: DeckKey[], patch: PresentationPatch) => {
    const nextRevision = (revision += 1)
    const updatedAtMs = performance.now()
    decks.forEach((deck) => {
      Object.assign(state[deck], {
        ...patch,
        revision: nextRevision,
        updatedAtMs
      })
    })
  }

  const commitDeckPatches = (patches: PresentationDeckPatch) => {
    const nextRevision = (revision += 1)
    const updatedAtMs = performance.now()
    const decks: DeckKey[] = ['top', 'bottom']
    decks.forEach((deck) => {
      const patch = patches[deck]
      if (!patch) return
      Object.assign(state[deck], {
        ...patch,
        revision: nextRevision,
        updatedAtMs
      })
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

  const clearDrag = (deck: DeckKey) => {
    if (state[deck].owner !== 'drag' && state[deck].owner !== 'linked-drag') return
    const affectedDecks = state[deck].linked
      ? state[deck].affectedDecks.length
        ? state[deck].affectedDecks
        : (['top', 'bottom'] as DeckKey[])
      : [deck]
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
    commitDecks(affectedDecks, {
      owner: linked ? 'linked-zoom' : 'zoom',
      sourceDeck: deck,
      affectedDecks,
      anchorSec: resolveOptionalNumber(options.anchorSec),
      viewportStartSec: resolveOptionalNumber(options.viewportStartSec),
      visibleDurationSec: resolveOptionalNumber(options.visibleDurationSec),
      zoom: Number(zoom) || null,
      anchorRatio: Math.max(0, Math.min(1, Number(anchorRatio) || 0.5)),
      timeScale: Math.max(0.25, Number(options.timeScale) || 1),
      linked,
      visualPending: false
    })
  }

  const beginSyncTransaction = (leader: DeckKey, follower: DeckKey) => {
    const affectedDecks = resolveSyncDecks(leader, follower)
    commitDecks(affectedDecks, {
      owner: 'sync-transaction',
      sourceDeck: leader,
      affectedDecks,
      linked: true,
      visualPending: true,
      gridTimeBasis: null,
      playbackClock: null,
      anchorSec: null,
      viewportStartSec: null,
      visibleDurationSec: null,
      timeScale: 1,
      surfaceMode: 'dual-detail'
    })
  }

  const finishSyncTransaction = (leader: DeckKey, follower: DeckKey, committed: boolean) => {
    const affectedDecks = resolveSyncDecks(leader, follower)
    commitDecks(affectedDecks, {
      owner: committed ? 'playback' : 'idle',
      sourceDeck: leader,
      affectedDecks,
      linked: committed,
      visualPending: false
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
    finishSyncTransaction
  }
}
