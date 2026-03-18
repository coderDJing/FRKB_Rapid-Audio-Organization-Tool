import { resolveTempoRatioByBpm } from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  type TrackTimeMap,
  type TrackTimeMapInput
} from '@renderer/composables/mixtape/trackTimeMapCore'
import { createTrackTimeMap } from '@renderer/composables/mixtape/trackTimeMapFactory'
import {
  BPM_POINT_SEC_EPSILON,
  buildFlatTrackBpmEnvelope,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackBpmEnvelopeBaseValue,
  resolveTrackGridSourceBpm
} from '@renderer/composables/mixtape/trackTempoModel'
import {
  projectMixtapeGlobalBpmEnvelopeToTrack,
  sampleMixtapeGlobalBpmAtSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import {
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import type {
  MixtapeTrack,
  SerializedTrackTempoSnapshot
} from '@renderer/composables/mixtape/types'

export type TrackRuntimeTempoSnapshot = {
  track: MixtapeTrack
  durationSec: number
  sourceDurationSec: number
  baseBpm: number
  gridSourceBpm: number
  originalBpm: number
  firstBeatSourceSec: number
  barBeatOffset: number
  timeMapInput: TrackTimeMapInput
  timeMap: TrackTimeMap
  visibleGridLines: ReturnType<TrackTimeMap['buildVisibleGridLines']>
  snapCandidates: number[]
  signature: string
}

const buildBpmEnvelopeSignature = (
  points: TrackRuntimeTempoSnapshot['timeMapInput']['controlPoints']
) =>
  points
    .map((point) => {
      const sec = Math.round((Number(point?.sec) || 0) * 1000)
      const bpm = Math.round((Number(point?.bpm) || 0) * 1000)
      const sourceSec = Number.isFinite(Number(point?.sourceSec))
        ? Math.round(Number(point?.sourceSec) * 1000)
        : -1
      const allowOffGrid = point?.allowOffGrid === true ? 1 : 0
      return `${sec}:${bpm}:${sourceSec}:${allowOffGrid}`
    })
    .join(';')

const buildGridOverrideSignature = (snapshot: {
  durationSec: number
  baseBpm: number
  gridSourceBpm: number
  originalBpm: number
}) =>
  [
    Math.round(snapshot.durationSec * 1000),
    Math.round(snapshot.baseBpm * 1000),
    Math.round(snapshot.gridSourceBpm * 1000),
    Math.round(snapshot.originalBpm * 1000)
  ].join('|')

const resolveFallbackTimelineDuration = (track: MixtapeTrack, sourceDurationSec: number) => {
  const targetBpm = Number(track.bpm)
  const originalBpm = Number(track.originalBpm)
  if (
    !Number.isFinite(sourceDurationSec) ||
    sourceDurationSec <= 0 ||
    !Number.isFinite(targetBpm) ||
    targetBpm <= 0 ||
    !Number.isFinite(originalBpm) ||
    originalBpm <= 0
  ) {
    return sourceDurationSec
  }
  const ratio = resolveTempoRatioByBpm(targetBpm, originalBpm)
  if (!Number.isFinite(ratio) || ratio <= BPM_POINT_SEC_EPSILON) return sourceDurationSec
  return sourceDurationSec / ratio
}

export const buildTrackTimeMapSignature = (snapshot: TrackRuntimeTempoSnapshot) =>
  [
    buildBpmEnvelopeSignature(snapshot.timeMapInput.controlPoints),
    buildGridOverrideSignature(snapshot)
  ].join('|')

export const serializeTrackRuntimeTempoSnapshot = (
  snapshot: TrackRuntimeTempoSnapshot
): SerializedTrackTempoSnapshot => ({
  signature: snapshot.signature,
  durationSec: snapshot.durationSec,
  sourceDurationSec: snapshot.sourceDurationSec,
  baseBpm: snapshot.baseBpm,
  gridSourceBpm: snapshot.gridSourceBpm,
  originalBpm: snapshot.originalBpm,
  firstBeatSourceSec: snapshot.firstBeatSourceSec,
  beatSourceSec: snapshot.timeMapInput.beatSourceSec,
  barBeatOffset: snapshot.barBeatOffset,
  controlPoints: snapshot.timeMapInput.controlPoints.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm),
    sourceSec:
      Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
        ? Number(point.sourceSec)
        : undefined,
    allowOffGrid: point.allowOffGrid === true ? true : undefined
  }))
})

export const buildTrackRuntimeTempoSnapshot = (params: {
  track: MixtapeTrack
  sourceDurationSec: number
  durationSec?: number
  rawPoints?: unknown
  zoom?: number
}) => {
  const track = params.track
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const fallbackTrackBpm = resolveTrackBpmEnvelopeBaseValue(track)
  const gridSourceBpm = resolveTrackGridSourceBpm(track)
  const originalBpm =
    Number(track.originalBpm) || Number(track.gridBaseBpm) || Number(track.bpm) || fallbackTrackBpm
  const hasExplicitRawPoints = params.rawPoints !== undefined && params.rawPoints !== null
  const shouldUseGlobalTempo = !hasExplicitRawPoints && isMixtapeGlobalTempoReady()
  const projectedGlobalTempo = shouldUseGlobalTempo
    ? projectMixtapeGlobalBpmEnvelopeToTrack({
        track,
        globalPoints: mixtapeGlobalTempoEnvelope.value,
        sourceDurationSec,
        originalBpm,
        fallbackBpm: fallbackTrackBpm
      })
    : null
  const durationSec =
    typeof params.durationSec === 'number' &&
    Number.isFinite(params.durationSec) &&
    params.durationSec > 0
      ? Math.max(0, params.durationSec)
      : projectedGlobalTempo
        ? projectedGlobalTempo.durationSec
        : resolveFallbackTimelineDuration(track, sourceDurationSec)
  const baseBpm = projectedGlobalTempo
    ? sampleMixtapeGlobalBpmAtSec(
        mixtapeGlobalTempoEnvelope.value,
        Number(track.startSec) || 0,
        projectedGlobalTempo.bpmAtStart
      )
    : fallbackTrackBpm
  const controlPoints = projectedGlobalTempo
    ? normalizeTrackBpmEnvelopePoints(projectedGlobalTempo.points, durationSec, baseBpm)
    : params.rawPoints !== undefined && params.rawPoints !== null
      ? normalizeTrackBpmEnvelopePoints(params.rawPoints, durationSec, baseBpm)
      : buildFlatTrackBpmEnvelope(durationSec, baseBpm)
  const timeMapInput: TrackTimeMapInput = {
    controlPoints,
    durationSec,
    sourceDurationSec,
    originalBpm,
    fallbackBpm: baseBpm,
    firstBeatSourceSec: Math.max(0, Number(track.firstBeatMs) || 0) / 1000,
    beatSourceSec: 60 / Math.max(1, gridSourceBpm),
    barBeatOffset: Number(track.barBeatOffset) || 0
  }
  const timeMap = createTrackTimeMap(timeMapInput)
  const visibleGridLines = timeMap.buildVisibleGridLines(Number(params.zoom) || 0)
  const snapshot: TrackRuntimeTempoSnapshot = {
    track,
    durationSec,
    sourceDurationSec,
    baseBpm,
    gridSourceBpm,
    originalBpm,
    firstBeatSourceSec: timeMapInput.firstBeatSourceSec,
    barBeatOffset: Number(track.barBeatOffset) || 0,
    timeMapInput,
    timeMap,
    visibleGridLines,
    snapCandidates: visibleGridLines.map((line) => line.sec),
    signature: ''
  }
  snapshot.signature = buildTrackTimeMapSignature(snapshot)
  return snapshot
}
