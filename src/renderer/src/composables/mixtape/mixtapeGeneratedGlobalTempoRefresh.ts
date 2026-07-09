import { watch } from 'vue'
import {
  buildDefaultMixtapeGlobalBpmEnvelopeSnapshot,
  buildMixtapeGlobalBpmEnvelopeSnapshotSignature
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import {
  applyMixtapeGlobalTempoSnapshot,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPhaseOffsetSec,
  mixtapeGlobalTempoSource
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { buildMixtapeTrackLoopSignature } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type {
  MixtapeOpenPayload,
  MixtapeProjectBpmEnvelopeSnapshot,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

type GeneratedGlobalTempoRefreshContext = {
  payload: ValueRef<MixtapeOpenPayload>
  tracks: ValueRef<MixtapeTrack[]>
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
}

const buildCurrentGlobalTempoSnapshotSignature = () => {
  const currentEnvelope = mixtapeGlobalTempoEnvelope.value
  const currentDurationSec = Math.max(
    0,
    Number(currentEnvelope[currentEnvelope.length - 1]?.sec) || 0
  )
  return buildMixtapeGlobalBpmEnvelopeSnapshotSignature({
    bpmEnvelope: currentEnvelope,
    bpmEnvelopeDurationSec: currentDurationSec,
    gridPhaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value
  })
}

const buildGeneratedTempoWatchSignature = (ctx: GeneratedGlobalTempoRefreshContext) =>
  ctx.tracks.value
    .map((track) =>
      [
        track.id,
        Number(track.startSec) || 0,
        Number(track.bpm) || 0,
        Number(track.gridBaseBpm) || 0,
        Number(track.originalBpm) || 0,
        Math.round(Math.max(0, Number(ctx.resolveTrackSourceDurationSeconds(track)) || 0) * 1000),
        track.beatGridMap?.signature || '',
        buildMixtapeTrackLoopSignature(track.loopSegments ?? track.loopSegment)
      ].join(':')
    )
    .join('|')

export const createMixtapeGeneratedGlobalTempoRefresh = (
  ctx: GeneratedGlobalTempoRefreshContext
) => {
  let lastAppliedGeneratedSignature = ''

  const buildGeneratedSnapshot = (): MixtapeProjectBpmEnvelopeSnapshot =>
    buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
      tracks: ctx.tracks.value,
      resolveTrackDurationSeconds: ctx.resolveTrackDurationSeconds,
      resolveTrackSourceDurationSeconds: ctx.resolveTrackSourceDurationSeconds,
      resolveTrackFirstBeatSeconds: ctx.resolveTrackFirstBeatSeconds
    })

  const refreshGeneratedGlobalTempoEnvelope = () => {
    const playlistId = String(ctx.payload.value.playlistId || '').trim()
    if (!playlistId || !ctx.tracks.value.length || mixtapeGlobalTempoSource.value !== 'generated') {
      return false
    }
    const snapshot = buildGeneratedSnapshot()
    const nextSignature = buildMixtapeGlobalBpmEnvelopeSnapshotSignature(snapshot)
    const currentSignature = buildCurrentGlobalTempoSnapshotSignature()
    if (
      nextSignature === currentSignature ||
      (nextSignature === lastAppliedGeneratedSignature && currentSignature === nextSignature)
    ) {
      lastAppliedGeneratedSignature = nextSignature
      return false
    }
    applyMixtapeGlobalTempoSnapshot({
      playlistId,
      snapshot,
      source: 'generated'
    })
    lastAppliedGeneratedSignature = nextSignature
    return true
  }

  watch(
    () => buildGeneratedTempoWatchSignature(ctx),
    () => {
      refreshGeneratedGlobalTempoEnvelope()
    },
    { flush: 'post' }
  )

  return {
    refreshGeneratedGlobalTempoEnvelope
  }
}
