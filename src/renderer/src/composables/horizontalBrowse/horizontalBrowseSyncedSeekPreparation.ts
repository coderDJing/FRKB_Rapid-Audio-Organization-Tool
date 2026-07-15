import type { ISongInfo } from 'src/types/globals'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from '@shared/songBeatGridMapV2'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type HorizontalBrowseSyncedSeekPreparationParams = {
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const SYNCED_SEEK_PHASE_EPSILON_BEATS = 0.04

const resolveOtherDeck = (deck: DeckKey): DeckKey => (deck === 'top' ? 'bottom' : 'top')
const normalizePhase = (value: number, modulo: number) => ((value % modulo) + modulo) % modulo

const resolveCircularPhaseDelta = (leftPhase: number, rightPhase: number) => {
  if (!Number.isFinite(leftPhase) || !Number.isFinite(rightPhase)) return null
  const normalized = normalizePhase(leftPhase - rightPhase, 1)
  return normalized > 0.5 ? 1 - normalized : normalized
}

export const createHorizontalBrowseSyncedSeekPreparation = (
  params: HorizontalBrowseSyncedSeekPreparationParams
) => {
  const buildDeckBeatDiagnostics = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const song = params.resolveDeckSong(deck)
    const beatGridProjection = projectSongBeatGridMapV2ToFixedGrid(
      normalizeSongBeatGridMapV2(song?.beatGridMap, { allowSingleClip: true })
    )
    const bpm = beatGridProjection ? Number(params.resolveDeckGridBpm(deck)) || 0 : 0
    const firstBeatSec = Math.max(0, Number(beatGridProjection?.firstBeatMs) || 0) / 1000
    const beatSec = bpm > 0 ? 60 / bpm : 0
    const currentSec = Math.max(0, Number(snapshot.currentSec) || 0)
    const renderCurrentSec = Math.max(0, Number(snapshot.renderCurrentSec) || 0)
    const beatDistance = beatSec > 0 ? (currentSec - firstBeatSec) / beatSec : 0
    const renderBeatDistance = beatSec > 0 ? (renderCurrentSec - firstBeatSec) / beatSec : 0
    const downbeatBeatOffset = beatGridProjection?.downbeatBeatOffset ?? 0
    return {
      bpm,
      firstBeatSec,
      beatSec,
      currentSec,
      renderCurrentSec,
      beatDistance,
      renderBeatDistance,
      beatPhase: normalizePhase(beatDistance, 1),
      renderBeatPhase: normalizePhase(renderBeatDistance, 1),
      downbeatBeatOffset,
      downbeatPhase: normalizePhase(beatDistance - downbeatBeatOffset, 4)
    }
  }

  const resolveSyncedSeekPhaseDelta = (deck: DeckKey) => {
    const targetBeat = buildDeckBeatDiagnostics(deck)
    const otherBeat = buildDeckBeatDiagnostics(resolveOtherDeck(deck))
    if (targetBeat.beatSec <= 0 || otherBeat.beatSec <= 0) return null
    return resolveCircularPhaseDelta(targetBeat.beatPhase, otherBeat.beatPhase)
  }

  const resolveSyncedSeekPreparationState = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const phaseDelta = resolveSyncedSeekPhaseDelta(deck)
    const phaseReady = phaseDelta === null || phaseDelta <= SYNCED_SEEK_PHASE_EPSILON_BEATS
    const playheadReady = snapshot.playheadLoaded
    return {
      snapshot,
      phaseDelta,
      phaseReady,
      playheadReady,
      ready: playheadReady && snapshot.syncLock === 'full' && phaseReady
    }
  }

  return {
    resolveSyncedSeekPreparationState
  }
}
