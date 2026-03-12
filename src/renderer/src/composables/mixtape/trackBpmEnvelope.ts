import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import { normalizeBeatOffset } from '@renderer/composables/mixtape/mixxxSyncModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const BPM_POINT_SEC_EPSILON = 0.0001
const BPM_MAX_POINTS_PER_SEC = 2
const BPM_MIN_VALUE = 1
const BPM_CLAMP_MIN_MULTIPLIER = 0.25
const BPM_VISUAL_MAX_MULTIPLIER = 2
const BPM_VISUAL_MIN_Y_PERCENT = 75

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveVisibleGridSnapModes = (zoom: number) => ({
  snapBar: true,
  snapBeat4: zoom >= GRID_BEAT4_LINE_ZOOM,
  snapBeat: zoom >= GRID_BEAT_LINE_ZOOM
})

const resolveNearestGridSec = (params: {
  targetSec: number
  minSec: number
  maxSec: number
  baseSec: number
  stepSec: number
}) => {
  const targetSec = Number(params.targetSec)
  const minSec = Number(params.minSec)
  const maxSec = Number(params.maxSec)
  const baseSec = Number(params.baseSec)
  const stepSec = Number(params.stepSec)
  if (
    !Number.isFinite(targetSec) ||
    !Number.isFinite(minSec) ||
    !Number.isFinite(maxSec) ||
    !Number.isFinite(baseSec) ||
    !Number.isFinite(stepSec) ||
    stepSec <= BPM_POINT_SEC_EPSILON ||
    maxSec < minSec
  ) {
    return null
  }
  const minIndex = Math.ceil((minSec - baseSec) / stepSec)
  const maxIndex = Math.floor((maxSec - baseSec) / stepSec)
  if (minIndex > maxIndex) return null
  const approxIndex = Math.round((targetSec - baseSec) / stepSec)
  const snappedIndex = clampNumber(approxIndex, minIndex, maxIndex)
  return Number((baseSec + snappedIndex * stepSec).toFixed(4))
}

const collapseBoundaryBpmPoints = (
  points: MixtapeBpmPoint[],
  durationSec: number
): MixtapeBpmPoint[] => {
  if (points.length <= 2) return points
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const lastZeroIndex = points.reduce(
    (result, point, index) => (Math.abs(point.sec) <= BPM_POINT_SEC_EPSILON ? index : result),
    -1
  )
  const firstDurationIndex = points.findIndex(
    (point) => Math.abs(point.sec - safeDuration) <= BPM_POINT_SEC_EPSILON
  )
  return points
    .filter((point, index) => {
      if (Math.abs(point.sec) <= BPM_POINT_SEC_EPSILON) {
        return index === lastZeroIndex
      }
      if (Math.abs(point.sec - safeDuration) <= BPM_POINT_SEC_EPSILON) {
        return index === firstDurationIndex
      }
      return true
    })
    .map((point) => ({
      sec:
        Math.abs(point.sec) <= BPM_POINT_SEC_EPSILON
          ? 0
          : Math.abs(point.sec - safeDuration) <= BPM_POINT_SEC_EPSILON
            ? safeDuration
            : point.sec,
      bpm: point.bpm,
      sourceSec:
        Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
          ? Number(Number(point.sourceSec).toFixed(4))
          : undefined
    }))
}

export const normalizeTrackBpmValue = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= BPM_MIN_VALUE) return null
  return Math.max(BPM_MIN_VALUE, Math.round(numeric))
}

export const resolveTrackBpmEnvelopeBaseValue = (track: MixtapeTrack): number => {
  const candidates = [track.bpm, track.gridBaseBpm, track.originalBpm]
  for (const candidate of candidates) {
    const normalized = normalizeTrackBpmValue(candidate)
    if (normalized !== null) return normalized
  }
  return 128
}

export const resolveTrackGridSourceBpm = (track: MixtapeTrack): number => {
  const candidates = [track.gridBaseBpm, track.originalBpm, track.bpm]
  for (const candidate of candidates) {
    const normalized = normalizeTrackBpmValue(candidate)
    if (normalized !== null) return normalized
  }
  return 128
}

export const resolveTrackBpmEnvelopeClampRange = (baseBpm: number) => ({
  minBpm: Math.max(BPM_MIN_VALUE, Math.round(baseBpm * BPM_CLAMP_MIN_MULTIPLIER)),
  maxBpm: Math.max(BPM_MIN_VALUE, Math.round(baseBpm * BPM_VISUAL_MAX_MULTIPLIER))
})

export const buildFlatTrackBpmEnvelope = (durationSec: number, bpm: number): MixtapeBpmPoint[] => {
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const fallbackBaseBpm = normalizeTrackBpmValue(bpm) ?? 128
  const clampRange = resolveTrackBpmEnvelopeClampRange(fallbackBaseBpm)
  const safeBpm = clampNumber(fallbackBaseBpm, clampRange.minBpm, clampRange.maxBpm)
  return [
    { sec: 0, bpm: safeBpm, sourceSec: 0 },
    {
      sec: Number(safeDuration.toFixed(4)),
      bpm: safeBpm,
      sourceSec: Number(safeDuration.toFixed(4))
    }
  ]
}

export const normalizeTrackBpmEnvelopePoints = (
  value: unknown,
  durationSec: number,
  defaultBpm: number
): MixtapeBpmPoint[] => {
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const fallbackBpm = normalizeTrackBpmValue(defaultBpm) ?? 128
  const clampRange = resolveTrackBpmEnvelopeClampRange(fallbackBpm)
  const points = Array.isArray(value)
    ? value
        .map((item) => {
          const sec = Number((item as any)?.sec)
          const bpm = normalizeTrackBpmValue((item as any)?.bpm)
          const sourceSec = Number((item as any)?.sourceSec)
          if (!Number.isFinite(sec) || sec < 0 || bpm === null) return null
          return {
            sec: Number(clampNumber(sec, 0, safeDuration).toFixed(4)),
            bpm: clampNumber(bpm, clampRange.minBpm, clampRange.maxBpm),
            sourceSec:
              Number.isFinite(sourceSec) && sourceSec >= 0
                ? Number(sourceSec.toFixed(4))
                : undefined
          }
        })
        .filter(Boolean)
    : []
  if (!points.length) {
    return buildFlatTrackBpmEnvelope(safeDuration, fallbackBpm)
  }
  const sorted = (points as MixtapeBpmPoint[]).sort((left, right) => {
    if (Math.abs(left.sec - right.sec) > BPM_POINT_SEC_EPSILON) return left.sec - right.sec
    return left.bpm - right.bpm
  })
  if (sorted[0].sec > BPM_POINT_SEC_EPSILON) {
    sorted.unshift({ sec: 0, bpm: sorted[0].bpm })
  } else {
    sorted[0].sec = 0
  }
  const last = sorted[sorted.length - 1]
  const safeDurationRounded = Number(safeDuration.toFixed(4))
  if (!last || Math.abs(last.sec - safeDurationRounded) > BPM_POINT_SEC_EPSILON) {
    sorted.push({
      sec: safeDurationRounded,
      bpm: last?.bpm ?? fallbackBpm
    })
  } else {
    last.sec = safeDurationRounded
  }
  const limited: MixtapeBpmPoint[] = []
  let bucketStartIndex = -1
  let bucketSec = Number.NaN
  let bucketCount = 0
  for (const point of sorted) {
    if (!bucketCount || Math.abs(point.sec - bucketSec) > BPM_POINT_SEC_EPSILON) {
      limited.push(point)
      bucketStartIndex = limited.length - 1
      bucketSec = point.sec
      bucketCount = 1
      continue
    }
    bucketCount += 1
    if (bucketCount <= BPM_MAX_POINTS_PER_SEC) {
      limited.push(point)
      continue
    }
    const replaceIndex = bucketStartIndex + BPM_MAX_POINTS_PER_SEC - 1
    limited[replaceIndex] = point
  }
  return collapseBoundaryBpmPoints(limited, safeDurationRounded)
}

export const cloneTrackBpmPoints = (points: MixtapeBpmPoint[]) =>
  points.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm),
    sourceSec:
      Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
        ? Number(Number(point.sourceSec).toFixed(4))
        : undefined
  }))

export const sampleTrackBpmEnvelopeAtSec = (
  points: MixtapeBpmPoint[],
  sec: number,
  fallbackBpm: number
) => {
  if (!points.length) return fallbackBpm
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= points[0].sec + BPM_POINT_SEC_EPSILON) {
    let index = 0
    while (
      index + 1 < points.length &&
      Math.abs(points[index + 1].sec - points[0].sec) <= BPM_POINT_SEC_EPSILON
    ) {
      index += 1
    }
    return points[index].bpm
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (Math.abs(point.sec - safeSec) <= BPM_POINT_SEC_EPSILON) {
      let cursor = index
      while (
        cursor + 1 < points.length &&
        Math.abs(points[cursor + 1].sec - safeSec) <= BPM_POINT_SEC_EPSILON
      ) {
        cursor += 1
      }
      return points[cursor].bpm
    }
    if (point.sec < safeSec) continue
    const prev = points[Math.max(0, index - 1)] || points[0]
    const span = Math.max(BPM_POINT_SEC_EPSILON, point.sec - prev.sec)
    const ratio = clampNumber((safeSec - prev.sec) / span, 0, 1)
    return Number((prev.bpm + (point.bpm - prev.bpm) * ratio).toFixed(4))
  }
  return points[points.length - 1]?.bpm ?? fallbackBpm
}

export const mapTrackBpmToYPercent = (
  bpm: number,
  baseBpm: number,
  minBpm: number,
  maxBpm: number
) => {
  const safeBase = Math.max(BPM_MIN_VALUE, Number(baseBpm) || BPM_MIN_VALUE)
  const safeMin = Math.max(BPM_MIN_VALUE, Number(minBpm) || BPM_MIN_VALUE)
  const safeMax = Math.max(safeBase, Number(maxBpm) || safeBase)
  const safeBpm = clampNumber(Number(bpm) || safeBase, safeMin, safeMax)
  if (safeBpm >= safeBase) {
    const ratio = (safeBpm - safeBase) / Math.max(BPM_POINT_SEC_EPSILON, safeMax - safeBase)
    return clampNumber(50 - ratio * 50, 0, 50)
  }
  const ratio = (safeBase - safeBpm) / Math.max(BPM_POINT_SEC_EPSILON, safeBase - safeMin)
  return clampNumber(50 + ratio * (BPM_VISUAL_MIN_Y_PERCENT - 50), 50, BPM_VISUAL_MIN_Y_PERCENT)
}

export const mapTrackBpmYPercentToValue = (
  yPercent: number,
  baseBpm: number,
  minBpm: number,
  maxBpm: number
) => {
  const safeBase = Math.max(BPM_MIN_VALUE, Number(baseBpm) || BPM_MIN_VALUE)
  const safeMin = Math.max(BPM_MIN_VALUE, Number(minBpm) || BPM_MIN_VALUE)
  const safeMax = Math.max(safeBase, Number(maxBpm) || safeBase)
  const safeY = clampNumber(Number(yPercent) || 0, 0, BPM_VISUAL_MIN_Y_PERCENT)
  if (safeY <= 50) {
    const ratio = (50 - safeY) / 50
    return Math.max(BPM_MIN_VALUE, Math.round(safeBase + (safeMax - safeBase) * ratio))
  }
  const ratio = (safeY - 50) / Math.max(BPM_POINT_SEC_EPSILON, BPM_VISUAL_MIN_Y_PERCENT - 50)
  return Math.max(BPM_MIN_VALUE, Math.round(safeBase - (safeBase - safeMin) * ratio))
}

export const resolveTrackBpmEnvelopeVisualRange = (params: {
  track: MixtapeTrack
  tracks: MixtapeTrack[]
  resolveDurationSec: (track: MixtapeTrack) => number
}) => {
  const baseBpm = resolveTrackBpmEnvelopeBaseValue(params.track)
  const clampRange = resolveTrackBpmEnvelopeClampRange(baseBpm)
  return {
    minBpm: clampRange.minBpm,
    maxBpm: clampRange.maxBpm
  }
}

export const resolveTrackTempoRatioAtSec = (params: {
  points: MixtapeBpmPoint[]
  sec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const bpm = sampleTrackBpmEnvelopeAtSec(params.points, params.sec, params.fallbackBpm)
  return normalizeTrackBpmValue(params.originalBpm)
    ? clampNumber(bpm / Math.max(BPM_MIN_VALUE, params.originalBpm), 0.25, 4)
    : 1
}

const integrateTempoRatioToSec = (params: {
  points: MixtapeBpmPoint[]
  endSec: number
  durationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeEndSec = clampNumber(params.endSec, 0, Math.max(0, params.durationSec))
  if (safeEndSec <= 0) return 0
  const originalBpm = normalizeTrackBpmValue(params.originalBpm)
  if (originalBpm === null) return safeEndSec
  const points = params.points
  if (points.length < 2) {
    return (
      safeEndSec *
      resolveTrackTempoRatioAtSec({
        points,
        sec: 0,
        originalBpm,
        fallbackBpm: params.fallbackBpm
      })
    )
  }
  let integral = 0
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]
    const right = points[index]
    const segmentStart = Math.max(0, left.sec)
    const segmentEnd = Math.min(safeEndSec, right.sec)
    if (segmentEnd <= segmentStart) continue
    const leftRatio = clampNumber(left.bpm / originalBpm, 0.25, 4)
    const rightRatio = clampNumber(right.bpm / originalBpm, 0.25, 4)
    integral += ((leftRatio + rightRatio) / 2) * (segmentEnd - segmentStart)
    if (right.sec >= safeEndSec - BPM_POINT_SEC_EPSILON) break
  }
  const lastPoint = points[points.length - 1]
  if (lastPoint && safeEndSec > lastPoint.sec + BPM_POINT_SEC_EPSILON) {
    const lastRatio = clampNumber(lastPoint.bpm / originalBpm, 0.25, 4)
    integral += lastRatio * (safeEndSec - lastPoint.sec)
  }
  return integral
}

export const resolveTrackTimelineDurationFromSource = (params: {
  rawPoints: unknown
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
  fallbackDurationSec: number
}) => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const fallbackDurationSec = Math.max(0, Number(params.fallbackDurationSec) || 0)
  if (sourceDurationSec <= 0) return fallbackDurationSec
  const originalBpm = normalizeTrackBpmValue(params.originalBpm)
  if (originalBpm === null) return fallbackDurationSec || sourceDurationSec
  const rawPointsDurationSec = Array.isArray(params.rawPoints)
    ? params.rawPoints.reduce((result, item) => {
        const sec = Number((item as any)?.sec)
        return Number.isFinite(sec) && sec > result ? sec : result
      }, 0)
    : 0
  const guessDuration = Math.max(fallbackDurationSec, sourceDurationSec, rawPointsDurationSec)
  const points = normalizeTrackBpmEnvelopePoints(
    params.rawPoints,
    guessDuration,
    params.fallbackBpm
  )
  if (points.length < 2) {
    const ratio = clampNumber(
      (normalizeTrackBpmValue(params.fallbackBpm) ?? originalBpm) / originalBpm,
      0.25,
      4
    )
    return sourceDurationSec / Math.max(BPM_POINT_SEC_EPSILON, ratio)
  }
  let accumulated = 0
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]
    const right = points[index]
    const span = Math.max(0, right.sec - left.sec)
    if (span <= BPM_POINT_SEC_EPSILON) continue
    const leftRatio = clampNumber(left.bpm / originalBpm, 0.25, 4)
    const rightRatio = clampNumber(right.bpm / originalBpm, 0.25, 4)
    const avgRatio = (leftRatio + rightRatio) / 2
    const segmentIntegral = avgRatio * span
    if (accumulated + segmentIntegral >= sourceDurationSec - BPM_POINT_SEC_EPSILON) {
      const remaining = Math.max(0, sourceDurationSec - accumulated)
      return Number((left.sec + remaining / Math.max(BPM_POINT_SEC_EPSILON, avgRatio)).toFixed(4))
    }
    accumulated += segmentIntegral
  }
  const lastPoint = points[points.length - 1]
  const lastRatio = clampNumber(lastPoint.bpm / originalBpm, 0.25, 4)
  if (lastRatio <= BPM_POINT_SEC_EPSILON) return Number(lastPoint.sec.toFixed(4))
  const remaining = Math.max(0, sourceDurationSec - accumulated)
  return Number((lastPoint.sec + remaining / lastRatio).toFixed(4))
}

export const resolveTrackSourceProgressAtLocalSec = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const totalIntegral = integrateTempoRatioToSec({
    points: params.points,
    endSec: params.durationSec,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  if (!Number.isFinite(totalIntegral) || totalIntegral <= BPM_POINT_SEC_EPSILON) {
    return clampNumber(params.localSec / Math.max(BPM_POINT_SEC_EPSILON, params.durationSec), 0, 1)
  }
  const partialIntegral = integrateTempoRatioToSec({
    points: params.points,
    endSec: params.localSec,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  return clampNumber(partialIntegral / totalIntegral, 0, 1)
}

export const resolveTrackSourceTimeAtLocalSec = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) =>
  resolveTrackSourceProgressAtLocalSec({
    points: params.points,
    localSec: params.localSec,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  }) * Math.max(0, params.sourceDurationSec)

export const resolveTrackLocalSecAtSourceTime = (params: {
  points: MixtapeBpmPoint[]
  sourceSec: number
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (safeDurationSec <= BPM_POINT_SEC_EPSILON || safeSourceDurationSec <= BPM_POINT_SEC_EPSILON) {
    return clampNumber(Number(params.sourceSec) || 0, 0, safeDurationSec)
  }
  const targetSourceSec = clampNumber(Number(params.sourceSec) || 0, 0, safeSourceDurationSec)
  let leftSec = 0
  let rightSec = safeDurationSec
  for (let index = 0; index < 28; index += 1) {
    const middleSec = (leftSec + rightSec) / 2
    const mappedSourceSec = resolveTrackSourceTimeAtLocalSec({
      points: params.points,
      localSec: middleSec,
      durationSec: safeDurationSec,
      sourceDurationSec: safeSourceDurationSec,
      originalBpm: params.originalBpm,
      fallbackBpm: params.fallbackBpm
    })
    if (mappedSourceSec < targetSourceSec) {
      leftSec = middleSec
    } else {
      rightSec = middleSec
    }
  }
  return Number((((leftSec + rightSec) / 2) as number).toFixed(4))
}

export const snapTrackSourceSecToBeatGrid = (params: {
  sourceSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  zoom?: number
  minSourceSec?: number
  maxSourceSec?: number
}) => {
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const beatSourceSec = Number(params.beatSourceSec)
  const firstBeatSourceSec = Number(params.firstBeatSourceSec)
  const minSourceSec = clampNumber(Number(params.minSourceSec) || 0, 0, safeSourceDurationSec)
  const maxSourceSec = clampNumber(
    Number.isFinite(Number(params.maxSourceSec))
      ? Number(params.maxSourceSec)
      : safeSourceDurationSec,
    minSourceSec,
    safeSourceDurationSec
  )
  const safeSourceSec = clampNumber(Number(params.sourceSec) || 0, minSourceSec, maxSourceSec)
  if (!Number.isFinite(beatSourceSec) || beatSourceSec <= BPM_POINT_SEC_EPSILON)
    return safeSourceSec
  if (!Number.isFinite(firstBeatSourceSec)) return safeSourceSec
  const barOffset = normalizeBeatOffset(params.barBeatOffset, 32)
  const barBaseSec = firstBeatSourceSec + barOffset * beatSourceSec
  const { snapBar, snapBeat4, snapBeat } = resolveVisibleGridSnapModes(Number(params.zoom) || 0)
  const candidates: number[] = []
  if (snapBar) {
    const barSec = resolveNearestGridSec({
      targetSec: safeSourceSec,
      minSec: minSourceSec,
      maxSec: maxSourceSec,
      baseSec: barBaseSec,
      stepSec: beatSourceSec * 32
    })
    if (typeof barSec === 'number') candidates.push(barSec)
  }
  if (snapBeat4) {
    const beat4Sec = resolveNearestGridSec({
      targetSec: safeSourceSec,
      minSec: minSourceSec,
      maxSec: maxSourceSec,
      baseSec: barBaseSec,
      stepSec: beatSourceSec * 4
    })
    if (typeof beat4Sec === 'number') candidates.push(beat4Sec)
  }
  if (snapBeat) {
    const beatSec = resolveNearestGridSec({
      targetSec: safeSourceSec,
      minSec: minSourceSec,
      maxSec: maxSourceSec,
      baseSec: firstBeatSourceSec,
      stepSec: beatSourceSec
    })
    if (typeof beatSec === 'number') candidates.push(beatSec)
  }
  if (!candidates.length) return safeSourceSec
  let nearest = candidates[0]
  let minDiff = Math.abs(nearest - safeSourceSec)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const diff = Math.abs(candidate - safeSourceSec)
    if (diff < minDiff) {
      nearest = candidate
      minDiff = diff
    }
  }
  return Number(nearest.toFixed(4))
}

export const snapTrackLocalSecToBeatGrid = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  zoom?: number
  originalBpm: number
  fallbackBpm: number
  minLocalSec?: number
  maxLocalSec?: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const minLocalSec = clampNumber(Number(params.minLocalSec) || 0, 0, safeDurationSec)
  const maxLocalSec = clampNumber(
    Number.isFinite(Number(params.maxLocalSec)) ? Number(params.maxLocalSec) : safeDurationSec,
    minLocalSec,
    safeDurationSec
  )
  const safeLocalSec = clampNumber(Number(params.localSec) || 0, minLocalSec, maxLocalSec)
  if (safeLocalSec <= BPM_POINT_SEC_EPSILON) return 0
  if (safeLocalSec >= safeDurationSec - BPM_POINT_SEC_EPSILON) {
    return Number(safeDurationSec.toFixed(4))
  }
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (safeSourceDurationSec <= BPM_POINT_SEC_EPSILON) return Number(safeLocalSec.toFixed(4))
  const visibleGridLines = buildTrackVisibleGridLines({
    points: params.points,
    durationSec: safeDurationSec,
    sourceDurationSec: safeSourceDurationSec,
    firstBeatSourceSec: params.firstBeatSourceSec,
    beatSourceSec: params.beatSourceSec,
    barBeatOffset: params.barBeatOffset,
    zoom: params.zoom,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  const candidates = visibleGridLines
    .map((line) => line.sec)
    .filter(
      (sec) =>
        sec >= minLocalSec - BPM_POINT_SEC_EPSILON && sec <= maxLocalSec + BPM_POINT_SEC_EPSILON
    )
  if (!candidates.length) return Number(safeLocalSec.toFixed(4))
  let nearest = candidates[0]
  let minDiff = Math.abs(nearest - safeLocalSec)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const diff = Math.abs(candidate - safeLocalSec)
    if (diff < minDiff) {
      nearest = candidate
      minDiff = diff
    }
  }
  return Number(clampNumber(nearest, minLocalSec, maxLocalSec).toFixed(4))
}

export const resolveNearestTrackVisibleGridLine = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  zoom?: number
  originalBpm: number
  fallbackBpm: number
  minLocalSec?: number
  maxLocalSec?: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const minLocalSec = clampNumber(Number(params.minLocalSec) || 0, 0, safeDurationSec)
  const maxLocalSec = clampNumber(
    Number.isFinite(Number(params.maxLocalSec)) ? Number(params.maxLocalSec) : safeDurationSec,
    minLocalSec,
    safeDurationSec
  )
  const safeLocalSec = clampNumber(Number(params.localSec) || 0, minLocalSec, maxLocalSec)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (safeDurationSec <= BPM_POINT_SEC_EPSILON || safeSourceDurationSec <= BPM_POINT_SEC_EPSILON) {
    return null
  }
  const visibleGridLines = buildTrackVisibleGridLines({
    points: params.points,
    durationSec: safeDurationSec,
    sourceDurationSec: safeSourceDurationSec,
    firstBeatSourceSec: params.firstBeatSourceSec,
    beatSourceSec: params.beatSourceSec,
    barBeatOffset: params.barBeatOffset,
    zoom: params.zoom,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  }).filter(
    (line) =>
      line.sec >= minLocalSec - BPM_POINT_SEC_EPSILON &&
      line.sec <= maxLocalSec + BPM_POINT_SEC_EPSILON
  )
  if (!visibleGridLines.length) return null
  let nearest = visibleGridLines[0]
  let minDiff = Math.abs(nearest.sec - safeLocalSec)
  for (let index = 1; index < visibleGridLines.length; index += 1) {
    const candidate = visibleGridLines[index]
    const diff = Math.abs(candidate.sec - safeLocalSec)
    if (diff < minDiff) {
      nearest = candidate
      minDiff = diff
    }
  }
  return nearest
}

export const resolveTrackBpmEnvelopeSourceAnchors = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeSourceDuration = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (safeSourceDuration <= BPM_POINT_SEC_EPSILON) {
    return params.points.map((point) =>
      clampNumber(Number(point.sec) || 0, 0, Math.max(0, Number(params.durationSec) || 0))
    )
  }
  return params.points.map((point) =>
    Number(
      resolveTrackSourceTimeAtLocalSec({
        points: params.points,
        localSec: Number(point.sec) || 0,
        durationSec: params.durationSec,
        sourceDurationSec: safeSourceDuration,
        originalBpm: params.originalBpm,
        fallbackBpm: params.fallbackBpm
      }).toFixed(4)
    )
  )
}

export const rebuildTrackBpmEnvelopePointsFromSourceAnchors = (params: {
  sourceAnchorsSec: number[]
  bpms: number[]
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeSourceDuration = Math.max(0, Number(params.sourceDurationSec) || 0)
  const fallbackBpm = normalizeTrackBpmValue(params.fallbackBpm) ?? 128
  const originalBpm = normalizeTrackBpmValue(params.originalBpm) ?? fallbackBpm
  const clampRange = resolveTrackBpmEnvelopeClampRange(fallbackBpm)
  if (
    !Array.isArray(params.sourceAnchorsSec) ||
    !Array.isArray(params.bpms) ||
    params.sourceAnchorsSec.length < 2 ||
    params.sourceAnchorsSec.length !== params.bpms.length
  ) {
    return buildFlatTrackBpmEnvelope(safeSourceDuration, fallbackBpm)
  }
  const points: MixtapeBpmPoint[] = []
  let localSec = 0
  for (let index = 0; index < params.bpms.length; index += 1) {
    const sourceAnchorSec = clampNumber(
      Number(params.sourceAnchorsSec[index]) || 0,
      0,
      safeSourceDuration
    )
    const bpm = clampNumber(
      normalizeTrackBpmValue(params.bpms[index]) ?? fallbackBpm,
      clampRange.minBpm,
      clampRange.maxBpm
    )
    if (!points.length) {
      points.push({
        sec: 0,
        bpm
      })
      continue
    }
    const prevSourceAnchorSec = clampNumber(
      Number(params.sourceAnchorsSec[index - 1]) || 0,
      0,
      safeSourceDuration
    )
    const prevBpm = points[points.length - 1]?.bpm ?? bpm
    const deltaSourceSec = Math.max(0, sourceAnchorSec - prevSourceAnchorSec)
    const avgRatio =
      (clampNumber(prevBpm / originalBpm, 0.25, 4) + clampNumber(bpm / originalBpm, 0.25, 4)) / 2
    localSec += deltaSourceSec / Math.max(BPM_POINT_SEC_EPSILON, avgRatio)
    points.push({
      sec: Number(localSec.toFixed(4)),
      bpm
    })
  }
  return normalizeTrackBpmEnvelopePoints(points, Number(localSec.toFixed(4)), fallbackBpm)
}

export const buildTrackBeatPositions = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  firstBeatSec: number
  fallbackBpm: number
}) => {
  const positions: number[] = []
  const safeDuration = Math.max(0, Number(params.durationSec) || 0)
  const firstBeatSec = Number(params.firstBeatSec)
  if (!Number.isFinite(firstBeatSec) || safeDuration <= 0) return positions
  let forward = clampNumber(firstBeatSec, 0, safeDuration)
  if (forward >= 0 && forward <= safeDuration) {
    positions.push(Number(forward.toFixed(4)))
  }
  while (forward < safeDuration - BPM_POINT_SEC_EPSILON) {
    const bpm = sampleTrackBpmEnvelopeAtSec(params.points, forward, params.fallbackBpm)
    const beatSec = 60 / Math.max(BPM_MIN_VALUE, bpm)
    forward += beatSec
    if (forward > safeDuration + BPM_POINT_SEC_EPSILON) break
    positions.push(Number(forward.toFixed(4)))
  }
  let backward = clampNumber(firstBeatSec, 0, safeDuration)
  while (backward > BPM_POINT_SEC_EPSILON) {
    const bpm = sampleTrackBpmEnvelopeAtSec(params.points, backward, params.fallbackBpm)
    const beatSec = 60 / Math.max(BPM_MIN_VALUE, bpm)
    backward -= beatSec
    if (backward < -BPM_POINT_SEC_EPSILON) break
    positions.unshift(Number(Math.max(0, backward).toFixed(4)))
  }
  return positions
}

export const buildTrackBeatPositionsFromSourceGrid = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const positions: number[] = []
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const firstBeatSourceSec = Number(params.firstBeatSourceSec)
  const beatSourceSec = Number(params.beatSourceSec)
  if (
    safeDurationSec <= BPM_POINT_SEC_EPSILON ||
    safeSourceDurationSec <= BPM_POINT_SEC_EPSILON ||
    !Number.isFinite(firstBeatSourceSec) ||
    !Number.isFinite(beatSourceSec) ||
    beatSourceSec <= BPM_POINT_SEC_EPSILON
  ) {
    return {
      positions,
      anchorIndex: 0
    }
  }
  const minIndex = Math.ceil((0 - firstBeatSourceSec) / beatSourceSec)
  const maxIndex = Math.floor((safeSourceDurationSec - firstBeatSourceSec) / beatSourceSec)
  if (minIndex > maxIndex) {
    return {
      positions,
      anchorIndex: 0
    }
  }
  for (let beatIndex = minIndex; beatIndex <= maxIndex; beatIndex += 1) {
    const sourceSec = firstBeatSourceSec + beatIndex * beatSourceSec
    const localSec = resolveTrackLocalSecAtSourceTime({
      points: params.points,
      sourceSec,
      durationSec: safeDurationSec,
      sourceDurationSec: safeSourceDurationSec,
      originalBpm: params.originalBpm,
      fallbackBpm: params.fallbackBpm
    })
    positions.push(Number(localSec.toFixed(4)))
  }
  return {
    positions,
    anchorIndex: -minIndex
  }
}

export type TrackVisibleGridLine = {
  sec: number
  sourceSec: number
  level: 'bar' | 'beat4' | 'beat'
}

export const buildTrackVisibleGridLines = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  zoom?: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const beatGrid = buildTrackBeatPositionsFromSourceGrid({
    points: params.points,
    durationSec: params.durationSec,
    sourceDurationSec: params.sourceDurationSec,
    firstBeatSourceSec: params.firstBeatSourceSec,
    beatSourceSec: params.beatSourceSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  const normalizedBarOffset = normalizeBeatOffset(params.barBeatOffset, 32)
  const anchorIndex = Math.max(0, beatGrid.anchorIndex)
  const { snapBar, snapBeat4, snapBeat } = resolveVisibleGridSnapModes(Number(params.zoom) || 0)
  const lines: TrackVisibleGridLine[] = []
  for (let index = 0; index < beatGrid.positions.length; index += 1) {
    const positionSec = beatGrid.positions[index]
    const sourceSec = params.firstBeatSourceSec + (index - anchorIndex) * params.beatSourceSec
    const relativeBeatIndex = index - anchorIndex
    const shiftedIndex = relativeBeatIndex - normalizedBarOffset
    const mod32 = ((shiftedIndex % 32) + 32) % 32
    const mod4 = ((shiftedIndex % 4) + 4) % 4
    const level: TrackVisibleGridLine['level'] = mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
    if (level === 'bar' && snapBar) {
      lines.push({
        sec: Number(positionSec.toFixed(4)),
        sourceSec: Number(sourceSec.toFixed(4)),
        level
      })
      continue
    }
    if (level === 'beat4' && snapBeat4) {
      lines.push({
        sec: Number(positionSec.toFixed(4)),
        sourceSec: Number(sourceSec.toFixed(4)),
        level
      })
      continue
    }
    if (level === 'beat' && snapBeat) {
      lines.push({
        sec: Number(positionSec.toFixed(4)),
        sourceSec: Number(sourceSec.toFixed(4)),
        level
      })
    }
  }
  return lines
}

export const resolveTrackBpmEnvelopeRenderablePoints = (params: {
  track: MixtapeTrack
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (!safeDurationSec || params.points.length < 2 || !safeSourceDurationSec) {
    return params.points
  }
  const fallbackBpm = resolveTrackBpmEnvelopeBaseValue(params.track)
  const originalBpm = Number(params.track.originalBpm) || Number(params.track.bpm) || 0
  return params.points.map((point, index) => {
    if (index === 0) {
      return {
        ...point,
        sec: 0
      }
    }
    if (index === params.points.length - 1) {
      return {
        ...point,
        sec: Number(safeDurationSec.toFixed(4))
      }
    }
    const sourceSec = Number(point.sourceSec)
    if (!Number.isFinite(sourceSec) || sourceSec < 0) return point
    return {
      ...point,
      sec: resolveTrackLocalSecAtSourceTime({
        points: params.points,
        sourceSec,
        durationSec: safeDurationSec,
        sourceDurationSec: safeSourceDurationSec,
        originalBpm,
        fallbackBpm
      })
    }
  })
}

export const buildTrackBpmEnvelopePolylineByControlPoints = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  baseBpm: number
  minBpm: number
  maxBpm: number
}) => {
  const safeDuration = Math.max(0, Number(params.durationSec) || 0)
  if (!safeDuration || params.points.length < 2) return ''
  return params.points
    .map((point) => {
      const x = (clampNumber(point.sec / safeDuration, 0, 1) * 100).toFixed(6)
      const y = mapTrackBpmToYPercent(
        point.bpm,
        params.baseBpm,
        params.minBpm,
        params.maxBpm
      ).toFixed(3)
      return `${x},${y}`
    })
    .join(' ')
}
