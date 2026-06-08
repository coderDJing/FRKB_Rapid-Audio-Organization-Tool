import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowsePendingPlayViewMode = 'dual' | 'edit' | 'unknown'

type PendingPlayDiagnosticState = {
  startedAtMs: number
  timer: number | null
  emitted: boolean
  startSnapshot: Record<string, unknown> | null
}

type HorizontalBrowsePendingPlayDiagnosticsParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckPendingPlay: (deck: DeckKey) => boolean
  isDeckPlayheadReady: (deck: DeckKey) => boolean
  resolveDualTransportSyncActive: () => boolean
  resolveBrowseViewMode?: () => HorizontalBrowsePendingPlayViewMode
}

export const HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS = 500

const resolveOtherDeck = (deck: DeckKey): DeckKey => (deck === 'top' ? 'bottom' : 'top')

const createDefaultPendingPlayDiagnosticState = (): PendingPlayDiagnosticState => ({
  startedAtMs: 0,
  timer: null,
  emitted: false,
  startSnapshot: null
})

const normalizeDiagnosticNumber = (value: unknown, fractionDigits = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Number(numeric.toFixed(fractionDigits))
}

export const createHorizontalBrowsePendingPlayDiagnostics = (
  params: HorizontalBrowsePendingPlayDiagnosticsParams
) => {
  const deckPendingPlayDiagnostics: Record<DeckKey, PendingPlayDiagnosticState> = {
    top: createDefaultPendingPlayDiagnosticState(),
    bottom: createDefaultPendingPlayDiagnosticState()
  }

  const clearTimer = (deck: DeckKey) => {
    const timer = deckPendingPlayDiagnostics[deck].timer
    if (timer !== null) {
      window.clearTimeout(timer)
      deckPendingPlayDiagnostics[deck].timer = null
    }
  }

  const buildDeckSnapshot = (deck: DeckKey): Record<string, unknown> => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const song = params.resolveDeckSong(deck)
    return {
      deck,
      filePath: String(song?.filePath || '').trim(),
      label: snapshot.label,
      pendingPlay: params.resolveDeckPendingPlay(deck),
      resolvedReady: params.isDeckPlayheadReady(deck),
      loaded: snapshot.loaded,
      fullyDecoded: snapshot.fullyDecoded,
      decoding: snapshot.decoding,
      fullDecoding: snapshot.fullDecoding,
      playRequested: snapshot.playRequested,
      playingAudible: snapshot.playingAudible,
      playheadLoaded: snapshot.playheadLoaded,
      playing: snapshot.playing,
      currentSec: normalizeDiagnosticNumber(snapshot.currentSec),
      renderCurrentSec: normalizeDiagnosticNumber(snapshot.renderCurrentSec),
      audioCurrentSec: normalizeDiagnosticNumber(snapshot.audioCurrentSec),
      loadedSegmentStartSec: normalizeDiagnosticNumber(snapshot.loadedSegmentStartSec),
      loadedSegmentEndSec: normalizeDiagnosticNumber(snapshot.loadedSegmentEndSec),
      durationSec: normalizeDiagnosticNumber(snapshot.durationSec),
      effectiveDurationSec: normalizeDiagnosticNumber(snapshot.effectiveDurationSec),
      playbackRate: normalizeDiagnosticNumber(snapshot.playbackRate, 5),
      syncEnabled: snapshot.syncEnabled,
      syncLock: snapshot.syncLock,
      timeBasisOffsetMs: normalizeDiagnosticNumber(song?.timeBasisOffsetMs),
      bpm: normalizeDiagnosticNumber(song?.bpm),
      firstBeatMs: normalizeDiagnosticNumber(song?.firstBeatMs),
      barBeatOffset: normalizeDiagnosticNumber(song?.barBeatOffset)
    }
  }

  const emitDiagnostic = (
    event: 'threshold' | 'cleared',
    deck: DeckKey,
    state: PendingPlayDiagnosticState,
    elapsedMs: number
  ) => {
    try {
      const otherDeck = resolveOtherDeck(deck)
      const payload = {
        event,
        mode: params.resolveBrowseViewMode?.() ?? 'unknown',
        deck,
        elapsedMs: normalizeDiagnosticNumber(elapsedMs, 1),
        thresholdMs: HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS,
        pendingTop: params.resolveDeckPendingPlay('top'),
        pendingBottom: params.resolveDeckPendingPlay('bottom'),
        dualSyncActive: params.resolveDualTransportSyncActive(),
        start: state.startSnapshot,
        current: buildDeckSnapshot(deck),
        other: buildDeckSnapshot(otherDeck)
      }
      window.electron.ipcRenderer.send('outputLog', {
        level: 'warn',
        source: 'renderer',
        scope: 'horizontal-browse-pending-play',
        message: `[HB-PENDING-PLAY] ${event} ${JSON.stringify(payload)}`
      })
    } catch {}
  }

  const reset = (deck: DeckKey) => {
    clearTimer(deck)
    deckPendingPlayDiagnostics[deck] = createDefaultPendingPlayDiagnosticState()
  }

  const sync = (deck: DeckKey, pending: boolean) => {
    const state = deckPendingPlayDiagnostics[deck]
    if (!pending) {
      if (state.startedAtMs > 0 && state.emitted) {
        emitDiagnostic('cleared', deck, state, performance.now() - state.startedAtMs)
      }
      reset(deck)
      return
    }

    if (state.startedAtMs <= 0) {
      state.startedAtMs = performance.now()
      state.startSnapshot = buildDeckSnapshot(deck)
    }
    if (state.emitted || state.timer !== null) return

    const delayMs = Math.max(
      0,
      HORIZONTAL_BROWSE_PENDING_PLAY_DIAGNOSTIC_THRESHOLD_MS -
        (performance.now() - state.startedAtMs)
    )
    state.timer = window.setTimeout(() => {
      state.timer = null
      if (!params.resolveDeckPendingPlay(deck) || state.emitted) return
      state.emitted = true
      emitDiagnostic('threshold', deck, state, performance.now() - state.startedAtMs)
    }, delayMs)
  }

  const dispose = () => {
    clearTimer('top')
    clearTimer('bottom')
  }

  return {
    sync,
    dispose
  }
}
