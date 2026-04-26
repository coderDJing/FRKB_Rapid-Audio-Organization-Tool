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
  buildMixtapeMasterGridSignature,
  buildProjectedMasterGridTempoPoints,
  createMixtapeMasterGrid,
  resolveTrackTimelineDurationOnMasterGrid,
  sampleMixtapeMasterGridBpmAtSec
} from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoPhaseOffsetSec
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { buildMixtapeTrackLoopSignature } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type {
  MixtapeTrack,
  SerializedTrackTempoSnapshot
} from '@renderer/composables/mixtape/types'

export type TrackRuntimeTempoSnapshot = {
  track: MixtapeTrack
  durationSec: number
  baseDurationSec: number
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
      const bpm = Math.round((Number(point?.bpm) || 0) * 1000000)
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
    Math.round(snapshot.baseBpm * 1000000),
    Math.round(snapshot.gridSourceBpm * 1000000),
    Math.round(snapshot.originalBpm * 1000000)
  ].join('|')

const buildTrackStartSignature = (track: Pick<MixtapeTrack, 'startSec'>) =>
  Math.round((Math.max(0, Number(track.startSec) || 0) || 0) * 1000)

const buildTrackLoopSignature = (track: Pick<MixtapeTrack, 'loopSegment' | 'loopSegments'>) =>
  buildMixtapeTrackLoopSignature(track.loopSegments ?? track.loopSegment)

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
  snapshot.timeMapInput.mappingMode === 'masterGrid'
    ? [
        'masterGrid',
        buildMixtapeMasterGridSignature(
          snapshot.timeMapInput.masterGridPoints || [],
          Number(snapshot.timeMapInput.masterGridPhaseOffsetSec) || 0
        ),
        buildTrackStartSignature(snapshot.track),
        buildTrackLoopSignature(snapshot.track),
        buildGridOverrideSignature(snapshot)
      ].join('|')
    : [
        'tempoEnvelope',
        buildBpmEnvelopeSignature(snapshot.timeMapInput.controlPoints),
        buildTrackLoopSignature(snapshot.track),
        buildGridOverrideSignature(snapshot)
      ].join('|')

export const serializeTrackRuntimeTempoSnapshot = (
  snapshot: TrackRuntimeTempoSnapshot
): SerializedTrackTempoSnapshot => ({
  signature: snapshot.signature,
  durationSec: snapshot.durationSec,
  baseDurationSec: snapshot.baseDurationSec,
  sourceDurationSec: snapshot.sourceDurationSec,
  baseBpm: snapshot.baseBpm,
  gridSourceBpm: snapshot.gridSourceBpm,
  originalBpm: snapshot.originalBpm,
  firstBeatSourceSec: snapshot.firstBeatSourceSec,
  beatSourceSec: snapshot.timeMapInput.beatSourceSec,
  barBeatOffset: snapshot.barBeatOffset,
  mappingMode: snapshot.timeMapInput.mappingMode,
  trackStartSec: snapshot.timeMapInput.trackStartSec,
  masterGridFallbackBpm: snapshot.timeMapInput.masterGridFallbackBpm,
  masterGridPhaseOffsetSec: snapshot.timeMapInput.masterGridPhaseOffsetSec,
  masterGridPoints: Array.isArray(snapshot.timeMapInput.masterGridPoints)
    ? snapshot.timeMapInput.masterGridPoints.map((point) => ({
        sec: Number(point.sec),
        bpm: Number(point.bpm)
      }))
    : undefined,
  loopSegments: Array.isArray(snapshot.timeMapInput.loopSegments)
    ? snapshot.timeMapInput.loopSegments.map((segment) => ({
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec),
        repeatCount: Number(segment.repeatCount)
      }))
    : undefined,
  loopSegment: snapshot.timeMapInput.loopSegment
    ? {
        startSec: Number(snapshot.timeMapInput.loopSegment.startSec),
        endSec: Number(snapshot.timeMapInput.loopSegment.endSec),
        repeatCount: Number(snapshot.timeMapInput.loopSegment.repeatCount)
      }
    : undefined,
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
  const shouldUseMasterGrid = !hasExplicitRawPoints && isMixtapeGlobalTempoReady()
  const trackStartSec = Math.max(0, Number(track.startSec) || 0)
  const beatSourceSec = 60 / Math.max(1, gridSourceBpm)
  const masterGrid =
    shouldUseMasterGrid && mixtapeGlobalTempoEnvelope.value.length >= 2
      ? createMixtapeMasterGrid({
          points: mixtapeGlobalTempoEnvelope.value,
          phaseOffsetSec: mixtapeGlobalTempoPhaseOffsetSec.value,
          fallbackBpm:
            Number(mixtapeGlobalTempoEnvelope.value[0]?.bpm) ||
            Number(track.bpm) ||
            fallbackTrackBpm
        })
      : null
  const baseDurationSec =
    typeof params.durationSec === 'number' &&
    Number.isFinite(params.durationSec) &&
    params.durationSec > 0
      ? Math.max(0, params.durationSec)
      : masterGrid
        ? resolveTrackTimelineDurationOnMasterGrid({
            grid: masterGrid,
            trackStartSec,
            sourceDurationSec,
            beatSourceSec
          })
        : resolveFallbackTimelineDuration(track, sourceDurationSec)
  const baseBpm = masterGrid
    ? sampleMixtapeMasterGridBpmAtSec(
        mixtapeGlobalTempoEnvelope.value,
        trackStartSec,
        fallbackTrackBpm
      )
    : fallbackTrackBpm
  const controlPoints = masterGrid
    ? normalizeTrackBpmEnvelopePoints(
        buildProjectedMasterGridTempoPoints({
          points: mixtapeGlobalTempoEnvelope.value,
          trackStartSec,
          durationSec: baseDurationSec,
          fallbackBpm: baseBpm
        }),
        baseDurationSec,
        baseBpm
      )
    : params.rawPoints !== undefined && params.rawPoints !== null
      ? normalizeTrackBpmEnvelopePoints(params.rawPoints, baseDurationSec, baseBpm)
      : buildFlatTrackBpmEnvelope(baseDurationSec, baseBpm)
  const normalizedLoopSegments =
    Array.isArray(track.loopSegments) && track.loopSegments.length
      ? track.loopSegments
      : track.loopSegment
        ? [track.loopSegment]
        : undefined
  const timeMapInput: TrackTimeMapInput = {
    controlPoints,
    durationSec: baseDurationSec,
    sourceDurationSec,
    originalBpm,
    fallbackBpm: baseBpm,
    firstBeatSourceSec: Number.isFinite(Number(track.firstBeatMs))
      ? Number(track.firstBeatMs) / 1000
      : 0,
    beatSourceSec,
    barBeatOffset: Number(track.barBeatOffset) || 0,
    loopSegments: normalizedLoopSegments,
    loopSegment: normalizedLoopSegments?.[0],
    mappingMode: masterGrid ? 'masterGrid' : 'tempoEnvelope',
    trackStartSec: trackStartSec,
    masterGridFallbackBpm: masterGrid ? masterGrid.tailBpm : undefined,
    masterGridPhaseOffsetSec: masterGrid ? mixtapeGlobalTempoPhaseOffsetSec.value : undefined,
    masterGridPoints: masterGrid ? mixtapeGlobalTempoEnvelope.value : undefined
  }
  const timeMap = createTrackTimeMap(timeMapInput)
  const visibleGridLines = timeMap.buildVisibleGridLines(Number(params.zoom) || 0)
  const snapshot: TrackRuntimeTempoSnapshot = {
    track,
    durationSec: timeMap.durationSec,
    baseDurationSec,
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
