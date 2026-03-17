import {
  buildTrackRuntimeTempoSnapshot,
  type TrackRuntimeTempoSnapshot
} from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  normalizeTrackBpmEnvelopePoints,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import { rebuildTrackBpmEnvelopePointsFromSourceAnchors } from '@renderer/composables/mixtape/trackTimeMapCore'
import type {
  MixtapeBpmPoint,
  MixtapeGridLineOverride,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

export type PhaseSyncPlannerTrackState = {
  track: MixtapeTrack
  startSec: number
  snapshot: TrackRuntimeTempoSnapshot
}

export type PhaseSyncPlan = {
  replacementTempoPoints: MixtapeBpmPoint[]
  nextTempoPoints: MixtapeBpmPoint[]
  gridOverride: {
    rangeStartLocalSec: number
    rangeEndLocalSec: number
    lines: MixtapeGridLineOverride[]
  }
}

const mergeGridLines = (params: {
  currentLines: MixtapeGridLineOverride[] | undefined
  replacementLines: MixtapeGridLineOverride[]
  currentRange?: {
    startSec?: number
    endSec?: number
  }
  replacementRange: {
    startSec: number
    endSec: number
  }
}) => {
  const { currentLines, replacementLines, currentRange, replacementRange } = params
  if (!replacementLines.length) return currentLines ?? []
  const currentStartSec = Number(currentRange?.startSec)
  const currentEndSec = Number(currentRange?.endSec)
  const clearStart = Number.isFinite(currentStartSec)
    ? Math.min(currentStartSec, replacementRange.startSec)
    : replacementRange.startSec
  const clearEnd = Number.isFinite(currentEndSec)
    ? Math.max(currentEndSec, replacementRange.endSec)
    : replacementRange.endSec
  const preserved = Array.isArray(currentLines)
    ? currentLines.filter(
        (line) =>
          line.sec < clearStart - BPM_POINT_SEC_EPSILON ||
          line.sec > clearEnd + BPM_POINT_SEC_EPSILON
      )
    : []
  return [...preserved, ...replacementLines].sort((left, right) => left.sec - right.sec)
}

const buildMirroredSourceSegment = (params: {
  sourceState: PhaseSyncPlannerTrackState
  targetState: PhaseSyncPlannerTrackState
  overlapStartSec: number
  overlapEndSec: number
}) => {
  const sourcePoints = params.sourceState.snapshot.timeMap.renderPoints
  const sourceLocalStart = roundTrackTempoSec(params.overlapStartSec - params.sourceState.startSec)
  const sourceLocalEnd = roundTrackTempoSec(params.overlapEndSec - params.sourceState.startSec)
  const targetLocalStart = roundTrackTempoSec(params.overlapStartSec - params.targetState.startSec)
  const targetLocalEnd = roundTrackTempoSec(params.overlapEndSec - params.targetState.startSec)
  if (targetLocalEnd - targetLocalStart <= BPM_POINT_SEC_EPSILON) return [] as MixtapeBpmPoint[]

  const sourceOriginalBpm = Math.max(
    1,
    Number(params.sourceState.snapshot.originalBpm || params.sourceState.snapshot.baseBpm || 1)
  )
  const targetOriginalBpm = Math.max(
    1,
    Number(params.targetState.snapshot.originalBpm || params.targetState.snapshot.baseBpm || 1)
  )
  const sampleSourceRatioAtLocal = (localSec: number) =>
    clampTrackTempoNumber(
      params.sourceState.snapshot.timeMap.sampleBpmAtLocal(localSec) / sourceOriginalBpm,
      0.25,
      4
    )
  const mapRatioToTargetBpm = (ratio: number) =>
    Number((clampTrackTempoNumber(ratio, 0.25, 4) * targetOriginalBpm).toFixed(4))

  const milestones = [
    {
      sourceLocalSec: sourceLocalStart,
      targetLocalSec: targetLocalStart,
      ratio: sampleSourceRatioAtLocal(sourceLocalStart)
    }
  ]

  for (const point of sourcePoints) {
    if (point.sec <= sourceLocalStart + BPM_POINT_SEC_EPSILON) continue
    if (point.sec >= sourceLocalEnd - BPM_POINT_SEC_EPSILON) continue
    const absoluteSec = params.sourceState.startSec + point.sec
    milestones.push({
      sourceLocalSec: roundTrackTempoSec(point.sec),
      targetLocalSec: roundTrackTempoSec(absoluteSec - params.targetState.startSec),
      ratio: clampTrackTempoNumber(Number(point.bpm) / sourceOriginalBpm, 0.25, 4)
    })
  }

  milestones.push({
    sourceLocalSec: sourceLocalEnd,
    targetLocalSec: targetLocalEnd,
    ratio: sampleSourceRatioAtLocal(sourceLocalEnd)
  })

  milestones.sort((left, right) => left.targetLocalSec - right.targetLocalSec)

  let targetSourceCursor = roundTrackTempoSec(
    params.targetState.snapshot.timeMap.mapLocalToSource(targetLocalStart)
  )

  return milestones.map((milestone, index) => {
    if (index > 0) {
      const prev = milestones[index - 1]!
      const deltaLocalSec = Math.max(0, milestone.targetLocalSec - prev.targetLocalSec)
      const averageRatio = clampTrackTempoNumber((prev.ratio + milestone.ratio) / 2, 0.25, 4)
      targetSourceCursor = roundTrackTempoSec(targetSourceCursor + deltaLocalSec * averageRatio)
    }

    return {
      sec: roundTrackTempoSec(
        clampTrackTempoNumber(milestone.targetLocalSec, targetLocalStart, targetLocalEnd)
      ),
      bpm: mapRatioToTargetBpm(milestone.ratio),
      sourceSec: roundTrackTempoSec(targetSourceCursor),
      allowOffGrid: true
    } satisfies MixtapeBpmPoint
  })
}

const mergeReplacementIntoTrack = (params: {
  targetState: PhaseSyncPlannerTrackState
  replacementPoints: MixtapeBpmPoint[]
  segmentStartLocal: number
  segmentEndLocal: number
}) => {
  const targetPoints = params.targetState.snapshot.timeMap.renderPoints
  const nextPoints: MixtapeBpmPoint[] = targetPoints.filter(
    (point) => point.sec < params.segmentStartLocal - BPM_POINT_SEC_EPSILON
  )

  const beforeBpm = targetPoints.reduce((result, point) => {
    if (point.sec <= params.segmentStartLocal + BPM_POINT_SEC_EPSILON) return point.bpm
    return result
  }, targetPoints[0]?.bpm ?? params.targetState.snapshot.baseBpm)

  if (params.segmentStartLocal > BPM_POINT_SEC_EPSILON && params.replacementPoints.length > 0) {
    const nextStartBpm = params.replacementPoints[0]!.bpm
    if (Math.abs(beforeBpm - nextStartBpm) > BPM_POINT_SEC_EPSILON) {
      nextPoints.push({
        sec: params.segmentStartLocal,
        bpm: beforeBpm,
        sourceSec: params.targetState.snapshot.timeMap.mapLocalToSource(params.segmentStartLocal),
        allowOffGrid: params.replacementPoints[0]?.allowOffGrid === true ? true : undefined
      })
    }
  }

  nextPoints.push(...params.replacementPoints)
  nextPoints.push(
    ...targetPoints.filter((point) => point.sec > params.segmentEndLocal + BPM_POINT_SEC_EPSILON)
  )

  return normalizeTrackBpmEnvelopePoints(
    nextPoints,
    params.targetState.snapshot.durationSec,
    params.targetState.snapshot.baseBpm
  )
}

const rebuildMergedTrackPoints = (params: {
  targetState: PhaseSyncPlannerTrackState
  mergedPoints: MixtapeBpmPoint[]
}) => {
  const normalizedMergedPoints = normalizeTrackBpmEnvelopePoints(
    params.mergedPoints,
    params.targetState.snapshot.durationSec,
    params.targetState.snapshot.baseBpm
  )
  const sourceDurationSec = params.targetState.snapshot.sourceDurationSec
  if (sourceDurationSec <= BPM_POINT_SEC_EPSILON || normalizedMergedPoints.length < 2) {
    return normalizedMergedPoints
  }

  const sourceAnchorsSec = normalizedMergedPoints.map((point, index) => {
    if (Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0) {
      return roundTrackTempoSec(Number(point.sourceSec))
    }
    if (index <= 0) return 0
    if (index >= normalizedMergedPoints.length - 1) {
      return roundTrackTempoSec(sourceDurationSec)
    }
    return roundTrackTempoSec(params.targetState.snapshot.timeMap.mapLocalToSource(point.sec))
  })

  const rebuiltPoints = rebuildTrackBpmEnvelopePointsFromSourceAnchors({
    sourceAnchorsSec,
    bpms: normalizedMergedPoints.map((point) => point.bpm),
    sourceDurationSec,
    originalBpm: params.targetState.snapshot.originalBpm,
    fallbackBpm: params.targetState.snapshot.baseBpm
  })
  const rebuiltSnapshot = buildTrackRuntimeTempoSnapshot({
    track: params.targetState.track,
    sourceDurationSec,
    rawPoints: rebuiltPoints
  })

  const refinedPoints = rebuiltPoints.map((point, index) => {
    const allowOffGrid = normalizedMergedPoints[index]?.allowOffGrid === true ? true : undefined
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
        sourceSec: roundTrackTempoSec(sourceDurationSec),
        allowOffGrid
      }
    }
    return {
      sec:
        allowOffGrid === true &&
        Number.isFinite(Number(normalizedMergedPoints[index]?.sec)) &&
        Number(normalizedMergedPoints[index]?.sec) >= 0
          ? roundTrackTempoSec(Number(normalizedMergedPoints[index]?.sec))
          : rebuiltSnapshot.timeMap.mapSourceToLocal(sourceAnchorsSec[index] ?? 0),
      bpm: point.bpm,
      sourceSec: sourceAnchorsSec[index],
      allowOffGrid
    }
  })

  return normalizeTrackBpmEnvelopePoints(
    refinedPoints,
    rebuiltSnapshot.durationSec,
    params.targetState.snapshot.baseBpm
  )
}

const buildGridOverrideLines = (params: {
  sourceState: PhaseSyncPlannerTrackState
  targetState: PhaseSyncPlannerTrackState
  nextSnapshot: TrackRuntimeTempoSnapshot
  overlapStartSec: number
  overlapEndSec: number
}) => {
  const sourceGridLines = params.sourceState.snapshot.timeMap
    .buildVisibleGridLines(Number.POSITIVE_INFINITY)
    .filter((line) => {
      const absoluteSec = params.sourceState.startSec + line.sec
      return (
        absoluteSec >= params.overlapStartSec - BPM_POINT_SEC_EPSILON &&
        absoluteSec <= params.overlapEndSec + BPM_POINT_SEC_EPSILON
      )
    })
  return sourceGridLines.map((line) => {
    const absoluteSec = params.sourceState.startSec + line.sec
    const targetLocalSec = roundTrackTempoSec(absoluteSec - params.targetState.startSec)
    return {
      sec: targetLocalSec,
      sourceSec: roundTrackTempoSec(line.sourceSec),
      level: line.level
    } satisfies MixtapeGridLineOverride
  })
}

export const createPhaseSyncPlannerTrackState = (params: {
  track: MixtapeTrack
  startSec: number
  snapshot: TrackRuntimeTempoSnapshot
}) => ({
  track: params.track,
  startSec: params.startSec,
  snapshot: params.snapshot
})

export const planPhaseSyncForTrackSegment = (params: {
  sourceState: PhaseSyncPlannerTrackState
  targetState: PhaseSyncPlannerTrackState
  overlapStartSec: number
  overlapEndSec: number
  mutateEnvelope?: boolean
}) => {
  const segmentStartLocal = roundTrackTempoSec(params.overlapStartSec - params.targetState.startSec)
  const segmentEndLocal = roundTrackTempoSec(params.overlapEndSec - params.targetState.startSec)
  const replacementTempoPoints = buildMirroredSourceSegment(params)
  const mutateEnvelope = params.mutateEnvelope !== false
  const mergedTempoPoints =
    replacementTempoPoints.length && mutateEnvelope
      ? mergeReplacementIntoTrack({
          targetState: params.targetState,
          replacementPoints: replacementTempoPoints,
          segmentStartLocal,
          segmentEndLocal
        })
      : params.targetState.snapshot.timeMap.renderPoints
  const nextTempoPoints =
    replacementTempoPoints.length && mutateEnvelope
      ? rebuildMergedTrackPoints({
          targetState: params.targetState,
          mergedPoints: mergedTempoPoints
        })
      : mergedTempoPoints

  const nextSnapshot = buildTrackRuntimeTempoSnapshot({
    track: params.targetState.track,
    sourceDurationSec: params.targetState.snapshot.sourceDurationSec,
    rawPoints: nextTempoPoints
  })
  const appliedTempoPoints = nextSnapshot.timeMapInput.controlPoints.map((point) => ({
    sec: point.sec,
    bpm: point.bpm,
    sourceSec: point.sourceSec,
    allowOffGrid: point.allowOffGrid
  }))
  const gridOverrideLines = buildGridOverrideLines({
    sourceState: params.sourceState,
    targetState: params.targetState,
    nextSnapshot,
    overlapStartSec: params.overlapStartSec,
    overlapEndSec: params.overlapEndSec
  })
  if (!gridOverrideLines.length) return null

  const mergedPreviewLines = mergeGridLines({
    currentLines: params.targetState.track.phaseSyncGridLines,
    replacementLines: gridOverrideLines,
    currentRange: {
      startSec: params.targetState.track.phaseSyncGridRangeStartSec,
      endSec: params.targetState.track.phaseSyncGridRangeEndSec
    },
    replacementRange: {
      startSec: segmentStartLocal,
      endSec: segmentEndLocal
    }
  })
  const previewTrack: MixtapeTrack = {
    ...params.targetState.track,
    phaseSyncGridLines: mergedPreviewLines,
    phaseSyncGridRangeStartSec: segmentStartLocal,
    phaseSyncGridRangeEndSec: segmentEndLocal
  }
  const previewSnapshot = buildTrackRuntimeTempoSnapshot({
    track: previewTrack,
    sourceDurationSec: params.targetState.snapshot.sourceDurationSec,
    rawPoints: appliedTempoPoints
  })

  return {
    replacementTempoPoints,
    nextTempoPoints: appliedTempoPoints,
    gridOverride: {
      rangeStartLocalSec: segmentStartLocal,
      rangeEndLocalSec: segmentEndLocal,
      lines: gridOverrideLines
    }
  } satisfies PhaseSyncPlan
}
