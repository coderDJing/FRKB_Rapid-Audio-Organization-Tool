import {
  applyPhaseSyncPlanToTrack,
  mergePhaseSyncGridLines,
  type PhaseSyncApplyTrigger
} from '@renderer/composables/mixtape/phaseSyncApplier'
import {
  createPhaseSyncPlannerTrackState,
  planPhaseSyncForTrackSegment,
  type PhaseSyncPlannerTrackState
} from '@renderer/composables/mixtape/phaseSyncPlanner'
import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { rebuildTrackBpmEnvelopePointsFromSourceAnchors } from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  BPM_POINT_SEC_EPSILON,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackBpmEnvelopeBaseValue,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

export type MixtapePhaseSyncTrackState = PhaseSyncPlannerTrackState

export const createMixtapePhaseSyncTrackState = createPhaseSyncPlannerTrackState
export { applyPhaseSyncPlanToTrack, mergePhaseSyncGridLines, type PhaseSyncApplyTrigger }

export const rebuildTrackPointsBySourceAnchors = (params: {
  track: MixtapeTrack
  previousPoints: MixtapeBpmPoint[]
  previousDurationSec: number
  nextPoints: MixtapeBpmPoint[]
  sourceDurationSec: number
}) => {
  const fallbackBpm = resolveTrackBpmEnvelopeBaseValue(params.track)
  const normalizedNextPoints = normalizeTrackBpmEnvelopePoints(
    params.nextPoints,
    params.previousDurationSec,
    fallbackBpm
  )
  if (
    params.sourceDurationSec <= BPM_POINT_SEC_EPSILON ||
    params.previousPoints.length < 2 ||
    normalizedNextPoints.length < 2
  ) {
    return normalizedNextPoints
  }

  const previousSnapshot = buildTrackRuntimeTempoSnapshot({
    track: params.track,
    sourceDurationSec: params.sourceDurationSec,
    durationSec: params.previousDurationSec,
    rawPoints: params.previousPoints
  })

  const sourceAnchorsSec = normalizedNextPoints.map((point, index) => {
    if (Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0) {
      return roundTrackTempoSec(Number(point.sourceSec))
    }
    if (index <= 0) return 0
    if (index >= normalizedNextPoints.length - 1) {
      return roundTrackTempoSec(params.sourceDurationSec)
    }
    return roundTrackTempoSec(previousSnapshot.timeMap.mapLocalToSource(point.sec))
  })

  const rebuiltPoints = rebuildTrackBpmEnvelopePointsFromSourceAnchors({
    sourceAnchorsSec,
    bpms: normalizedNextPoints.map((point) => point.bpm),
    sourceDurationSec: params.sourceDurationSec,
    originalBpm: Number(params.track.originalBpm) || Number(params.track.bpm) || 0,
    fallbackBpm
  })

  const rebuiltSnapshot = buildTrackRuntimeTempoSnapshot({
    track: params.track,
    sourceDurationSec: params.sourceDurationSec,
    rawPoints: rebuiltPoints
  })

  const refinedPoints = rebuiltPoints.map((point, index) => {
    const allowOffGrid = normalizedNextPoints[index]?.allowOffGrid === true ? true : undefined
    if (index === 0) {
      return {
        sec: 0,
        bpm: point.bpm,
        sourceSec: 0,
        allowOffGrid
      }
    }
    if (index === rebuiltPoints.length - 1) {
      return {
        sec: roundTrackTempoSec(rebuiltSnapshot.durationSec),
        bpm: point.bpm,
        sourceSec: roundTrackTempoSec(params.sourceDurationSec),
        allowOffGrid
      }
    }
    return {
      sec:
        allowOffGrid === true &&
        Number.isFinite(Number(normalizedNextPoints[index]?.sec)) &&
        Number(normalizedNextPoints[index]?.sec) >= 0
          ? roundTrackTempoSec(Number(normalizedNextPoints[index]?.sec))
          : rebuiltSnapshot.timeMap.mapSourceToLocal(sourceAnchorsSec[index] ?? 0),
      bpm: point.bpm,
      sourceSec: sourceAnchorsSec[index],
      allowOffGrid
    }
  })

  return normalizeTrackBpmEnvelopePoints(refinedPoints, rebuiltSnapshot.durationSec, fallbackBpm)
}

export const syncTargetTrackBpmSegmentToSourcePhase = (params: {
  sourceState: MixtapePhaseSyncTrackState
  targetState: MixtapePhaseSyncTrackState
  overlapStartSec: number
  overlapEndSec: number
  mutateEnvelope?: boolean
}) => {
  const plan = planPhaseSyncForTrackSegment(params)
  if (!plan) return null
  return {
    nextPoints: plan.nextTempoPoints,
    phaseSyncGridLines: plan.gridOverride.lines,
    phaseSyncGridRangeStartSec: plan.gridOverride.rangeStartLocalSec,
    phaseSyncGridRangeEndSec: plan.gridOverride.rangeEndLocalSec
  }
}
