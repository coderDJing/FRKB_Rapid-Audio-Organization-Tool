import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import { normalizeBeatOffset } from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  BPM_MIN_VALUE,
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  normalizeTrackBpmEnvelopePoints,
  normalizeTrackBpmValue,
  resolveTrackBpmEnvelopeClampRange,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import {
  applyTrackVisibleGridOverrides,
  type TrackVisibleGridLine
} from '@renderer/composables/mixtape/trackVisibleGridOverrides'
import type {
  MixtapeBpmPoint,
  SerializedTrackTempoSnapshot
} from '@renderer/composables/mixtape/types'

export type { TrackVisibleGridLine } from '@renderer/composables/mixtape/trackVisibleGridOverrides'

export type TrackTimeMapInput = {
  controlPoints: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  overrideLines?: TrackVisibleGridLine[]
  overrideRange?: {
    startSec: number
    endSec: number
  }
}

export type TrackTimeMap = {
  controlPoints: MixtapeBpmPoint[]
  renderPoints: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset: number
  mapLocalToSource: (localSec: number) => number
  mapSourceToLocal: (sourceSec: number) => number
  sampleBpmAtLocal: (localSec: number) => number
  sampleBpmAtSource: (sourceSec: number) => number
  buildVisibleGridLines: (zoom: number) => TrackVisibleGridLine[]
  buildSnapCandidates: (zoom: number) => number[]
  resolveNearestGridLine: (
    localSec: number,
    zoom: number,
    range?: { minLocalSec?: number; maxLocalSec?: number }
  ) => TrackVisibleGridLine | null
  snapLocalSec: (
    localSec: number,
    zoom: number,
    range?: { minLocalSec?: number; maxLocalSec?: number }
  ) => number
}

const resolveVisibleGridVisibility = (zoom: number) => ({
  showBar: true,
  showBeat4: zoom >= GRID_BEAT4_LINE_ZOOM,
  showBeat: zoom >= GRID_BEAT_LINE_ZOOM
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
  const snappedIndex = clampTrackTempoNumber(approxIndex, minIndex, maxIndex)
  return roundTrackTempoSec(baseSec + snappedIndex * stepSec)
}

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
    const ratio = clampTrackTempoNumber((safeSec - prev.sec) / span, 0, 1)
    return Number((prev.bpm + (point.bpm - prev.bpm) * ratio).toFixed(4))
  }
  return points[points.length - 1]?.bpm ?? fallbackBpm
}

export const resolveTrackTempoRatioAtSec = (params: {
  points: MixtapeBpmPoint[]
  sec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const bpm = sampleTrackBpmEnvelopeAtSec(params.points, params.sec, params.fallbackBpm)
  return normalizeTrackBpmValue(params.originalBpm)
    ? clampTrackTempoNumber(bpm / Math.max(BPM_MIN_VALUE, params.originalBpm), 0.25, 4)
    : 1
}

type TempoRatioIntegralSegment = {
  startSec: number
  endSec: number
  ratio: number
  integralBefore: number
  integralAfter: number
}

type TempoRatioIntegralCache =
  | {
      mode: 'linear'
      durationSec: number
      totalIntegral: number
    }
  | {
      mode: 'constant'
      durationSec: number
      totalIntegral: number
      constantRatio: number
    }
  | {
      mode: 'piecewise'
      durationSec: number
      totalIntegral: number
      segments: TempoRatioIntegralSegment[]
      segmentEndSecs: number[]
    }

const buildTempoRatioIntegralCache = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  originalBpm: number
  fallbackBpm: number
}): TempoRatioIntegralCache => {
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  if (durationSec <= 0) {
    return {
      mode: 'linear',
      durationSec,
      totalIntegral: 0
    }
  }
  const originalBpm = normalizeTrackBpmValue(params.originalBpm)
  if (originalBpm === null) {
    return {
      mode: 'linear',
      durationSec,
      totalIntegral: durationSec
    }
  }
  const points = params.points
  if (points.length < 2) {
    const constantRatio = resolveTrackTempoRatioAtSec({
      points,
      sec: 0,
      originalBpm,
      fallbackBpm: params.fallbackBpm
    })
    return {
      mode: 'constant',
      durationSec,
      totalIntegral: durationSec * constantRatio,
      constantRatio
    }
  }

  const segments: TempoRatioIntegralSegment[] = []
  const segmentEndSecs: number[] = []
  let totalIntegral = 0

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]
    const right = points[index]
    const span = Number(right.sec) - Number(left.sec)
    if (!Number.isFinite(span) || span <= BPM_POINT_SEC_EPSILON) continue
    const startSec = Math.max(0, Number(left.sec) || 0)
    const endSec = Math.min(durationSec, Number(right.sec) || 0)
    if (endSec <= startSec) continue
    const leftRatio = clampTrackTempoNumber(left.bpm / originalBpm, 0.25, 4)
    const rightRatio = clampTrackTempoNumber(right.bpm / originalBpm, 0.25, 4)
    const ratio = (leftRatio + rightRatio) / 2
    const deltaSec = endSec - startSec
    const integralBefore = totalIntegral
    totalIntegral += ratio * deltaSec
    segments.push({
      startSec,
      endSec,
      ratio,
      integralBefore,
      integralAfter: totalIntegral
    })
    segmentEndSecs.push(endSec)
  }

  const lastPoint = points[points.length - 1]
  if (lastPoint && durationSec > lastPoint.sec + BPM_POINT_SEC_EPSILON) {
    const startSec = Math.max(0, Number(lastPoint.sec) || 0)
    const endSec = durationSec
    if (endSec > startSec) {
      const lastRatio = clampTrackTempoNumber(lastPoint.bpm / originalBpm, 0.25, 4)
      const deltaSec = endSec - startSec
      const integralBefore = totalIntegral
      totalIntegral += lastRatio * deltaSec
      segments.push({
        startSec,
        endSec,
        ratio: lastRatio,
        integralBefore,
        integralAfter: totalIntegral
      })
      segmentEndSecs.push(endSec)
    }
  }

  return {
    mode: 'piecewise',
    durationSec,
    totalIntegral,
    segments,
    segmentEndSecs
  }
}

const findTempoRatioIntegralSegmentIndex = (segmentEndSecs: number[], localSec: number): number => {
  let left = 0
  let right = segmentEndSecs.length - 1
  let answer = -1
  while (left <= right) {
    const middle = (left + right) >> 1
    if ((segmentEndSecs[middle] || 0) >= localSec - BPM_POINT_SEC_EPSILON) {
      answer = middle
      right = middle - 1
    } else {
      left = middle + 1
    }
  }
  return answer
}

const findTempoRatioIntegralSegmentByIntegral = (
  segments: TempoRatioIntegralSegment[],
  targetIntegral: number
): TempoRatioIntegralSegment | null => {
  let left = 0
  let right = segments.length - 1
  let answer = -1
  while (left <= right) {
    const middle = (left + right) >> 1
    if ((segments[middle]?.integralAfter || 0) >= targetIntegral - BPM_POINT_SEC_EPSILON) {
      answer = middle
      right = middle - 1
    } else {
      left = middle + 1
    }
  }
  return answer >= 0 ? segments[answer] || null : null
}

const resolveTempoRatioIntegralAtLocalSec = (cache: TempoRatioIntegralCache, localSec: number) => {
  const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, cache.durationSec)
  if (safeLocalSec <= 0) return 0
  if (cache.mode === 'linear') {
    return safeLocalSec
  }
  if (cache.mode === 'constant') {
    return safeLocalSec * cache.constantRatio
  }
  if (!cache.segments.length) return 0
  const segmentIndex = findTempoRatioIntegralSegmentIndex(cache.segmentEndSecs, safeLocalSec)
  if (segmentIndex < 0) return cache.totalIntegral
  const segment = cache.segments[segmentIndex]
  if (!segment) return cache.totalIntegral
  if (safeLocalSec <= segment.startSec + BPM_POINT_SEC_EPSILON) {
    return segment.integralBefore
  }
  const deltaSec = Math.min(
    segment.endSec - segment.startSec,
    Math.max(0, safeLocalSec - segment.startSec)
  )
  return segment.integralBefore + segment.ratio * deltaSec
}

const integrateTempoRatioToSec = (params: {
  points: MixtapeBpmPoint[]
  endSec: number
  durationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeEndSec = clampTrackTempoNumber(params.endSec, 0, Math.max(0, params.durationSec))
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
    const leftRatio = clampTrackTempoNumber(left.bpm / originalBpm, 0.25, 4)
    const rightRatio = clampTrackTempoNumber(right.bpm / originalBpm, 0.25, 4)
    integral += ((leftRatio + rightRatio) / 2) * (segmentEnd - segmentStart)
    if (right.sec >= safeEndSec - BPM_POINT_SEC_EPSILON) break
  }
  const lastPoint = points[points.length - 1]
  if (lastPoint && safeEndSec > lastPoint.sec + BPM_POINT_SEC_EPSILON) {
    const lastRatio = clampTrackTempoNumber(lastPoint.bpm / originalBpm, 0.25, 4)
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
    const ratio = clampTrackTempoNumber(
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
    const leftRatio = clampTrackTempoNumber(left.bpm / originalBpm, 0.25, 4)
    const rightRatio = clampTrackTempoNumber(right.bpm / originalBpm, 0.25, 4)
    const avgRatio = (leftRatio + rightRatio) / 2
    const segmentIntegral = avgRatio * span
    if (accumulated + segmentIntegral >= sourceDurationSec - BPM_POINT_SEC_EPSILON) {
      const remaining = Math.max(0, sourceDurationSec - accumulated)
      return roundTrackTempoSec(left.sec + remaining / Math.max(BPM_POINT_SEC_EPSILON, avgRatio))
    }
    accumulated += segmentIntegral
  }
  const lastPoint = points[points.length - 1]
  const lastRatio = clampTrackTempoNumber(lastPoint.bpm / originalBpm, 0.25, 4)
  if (lastRatio <= BPM_POINT_SEC_EPSILON) return roundTrackTempoSec(lastPoint.sec)
  const remaining = Math.max(0, sourceDurationSec - accumulated)
  return roundTrackTempoSec(lastPoint.sec + remaining / lastRatio)
}

export const resolveTrackSourceProgressAtLocalSec = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  originalBpm: number
  fallbackBpm: number
  integralCache?: TempoRatioIntegralCache
}) => {
  if (params.integralCache) {
    const totalIntegral = params.integralCache.totalIntegral
    if (!Number.isFinite(totalIntegral) || totalIntegral <= BPM_POINT_SEC_EPSILON) {
      return clampTrackTempoNumber(
        params.localSec / Math.max(BPM_POINT_SEC_EPSILON, params.durationSec),
        0,
        1
      )
    }
    const partialIntegral = resolveTempoRatioIntegralAtLocalSec(
      params.integralCache,
      params.localSec
    )
    return clampTrackTempoNumber(partialIntegral / totalIntegral, 0, 1)
  }
  const totalIntegral = integrateTempoRatioToSec({
    points: params.points,
    endSec: params.durationSec,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  if (!Number.isFinite(totalIntegral) || totalIntegral <= BPM_POINT_SEC_EPSILON) {
    return clampTrackTempoNumber(
      params.localSec / Math.max(BPM_POINT_SEC_EPSILON, params.durationSec),
      0,
      1
    )
  }
  const partialIntegral = integrateTempoRatioToSec({
    points: params.points,
    endSec: params.localSec,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  return clampTrackTempoNumber(partialIntegral / totalIntegral, 0, 1)
}

export const resolveTrackSourceTimeAtLocalSec = (params: {
  points: MixtapeBpmPoint[]
  localSec: number
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
  integralCache?: TempoRatioIntegralCache
}) => {
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (!params.integralCache) {
    return (
      resolveTrackSourceProgressAtLocalSec({
        points: params.points,
        localSec: params.localSec,
        durationSec: params.durationSec,
        originalBpm: params.originalBpm,
        fallbackBpm: params.fallbackBpm
      }) * safeSourceDurationSec
    )
  }
  const totalIntegral = params.integralCache.totalIntegral
  if (!Number.isFinite(totalIntegral) || totalIntegral <= BPM_POINT_SEC_EPSILON) {
    return (
      clampTrackTempoNumber(
        Number(params.localSec) || 0,
        0,
        Math.max(0, Number(params.durationSec) || 0)
      ) *
      (safeSourceDurationSec / Math.max(BPM_POINT_SEC_EPSILON, Number(params.durationSec) || 0))
    )
  }
  return (
    resolveTempoRatioIntegralAtLocalSec(params.integralCache, params.localSec) *
    (safeSourceDurationSec / totalIntegral)
  )
}

export const resolveTrackLocalSecAtSourceTime = (params: {
  points: MixtapeBpmPoint[]
  sourceSec: number
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
  integralCache?: TempoRatioIntegralCache
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (safeDurationSec <= BPM_POINT_SEC_EPSILON || safeSourceDurationSec <= BPM_POINT_SEC_EPSILON) {
    return clampTrackTempoNumber(Number(params.sourceSec) || 0, 0, safeDurationSec)
  }
  const targetSourceSec = clampTrackTempoNumber(
    Number(params.sourceSec) || 0,
    0,
    safeSourceDurationSec
  )
  if (params.integralCache) {
    const totalIntegral = params.integralCache.totalIntegral
    if (!Number.isFinite(totalIntegral) || totalIntegral <= BPM_POINT_SEC_EPSILON) {
      return roundTrackTempoSec((targetSourceSec / safeSourceDurationSec) * safeDurationSec)
    }
    if (params.integralCache.mode === 'linear') {
      return roundTrackTempoSec((targetSourceSec / safeSourceDurationSec) * safeDurationSec)
    }
    const targetIntegral = (targetSourceSec / safeSourceDurationSec) * totalIntegral
    if (params.integralCache.mode === 'constant') {
      return roundTrackTempoSec(
        clampTrackTempoNumber(
          targetIntegral / Math.max(BPM_POINT_SEC_EPSILON, params.integralCache.constantRatio),
          0,
          safeDurationSec
        )
      )
    }
    if (!params.integralCache.segments.length) return 0
    const segment = findTempoRatioIntegralSegmentByIntegral(
      params.integralCache.segments,
      targetIntegral
    )
    if (!segment) return roundTrackTempoSec(safeDurationSec)
    if (targetIntegral <= segment.integralBefore + BPM_POINT_SEC_EPSILON) {
      return roundTrackTempoSec(segment.startSec)
    }
    const localSec =
      segment.startSec +
      (targetIntegral - segment.integralBefore) / Math.max(BPM_POINT_SEC_EPSILON, segment.ratio)
    return roundTrackTempoSec(clampTrackTempoNumber(localSec, segment.startSec, segment.endSec))
  }
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
      fallbackBpm: params.fallbackBpm,
      integralCache: params.integralCache
    })
    if (mappedSourceSec < targetSourceSec) {
      leftSec = middleSec
    } else {
      rightSec = middleSec
    }
  }
  return roundTrackTempoSec((leftSec + rightSec) / 2)
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
  const minSourceSec = clampTrackTempoNumber(
    Number(params.minSourceSec) || 0,
    0,
    safeSourceDurationSec
  )
  const maxSourceSec = clampTrackTempoNumber(
    Number.isFinite(Number(params.maxSourceSec))
      ? Number(params.maxSourceSec)
      : safeSourceDurationSec,
    minSourceSec,
    safeSourceDurationSec
  )
  const safeSourceSec = clampTrackTempoNumber(
    Number(params.sourceSec) || 0,
    minSourceSec,
    maxSourceSec
  )
  if (!Number.isFinite(beatSourceSec) || beatSourceSec <= BPM_POINT_SEC_EPSILON)
    return safeSourceSec
  if (!Number.isFinite(firstBeatSourceSec)) return safeSourceSec
  const barOffset = normalizeBeatOffset(params.barBeatOffset, 32)
  const barBaseSec = firstBeatSourceSec + barOffset * beatSourceSec
  const visibility = resolveVisibleGridVisibility(Number(params.zoom) || 0)
  const candidates: number[] = []
  if (visibility.showBar) {
    const barSec = resolveNearestGridSec({
      targetSec: safeSourceSec,
      minSec: minSourceSec,
      maxSec: maxSourceSec,
      baseSec: barBaseSec,
      stepSec: beatSourceSec * 32
    })
    if (typeof barSec === 'number') candidates.push(barSec)
  }
  if (visibility.showBeat4) {
    const beat4Sec = resolveNearestGridSec({
      targetSec: safeSourceSec,
      minSec: minSourceSec,
      maxSec: maxSourceSec,
      baseSec: barBaseSec,
      stepSec: beatSourceSec * 4
    })
    if (typeof beat4Sec === 'number') candidates.push(beat4Sec)
  }
  if (visibility.showBeat) {
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
  return roundTrackTempoSec(nearest)
}

export const resolveTrackBpmEnvelopeRenderablePoints = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const safeSourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (!safeDurationSec || params.points.length < 2 || !safeSourceDurationSec) return params.points
  const tempoRatioIntegralCache = buildTempoRatioIntegralCache({
    points: params.points,
    durationSec: safeDurationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  return params.points.map((point, index) => {
    if (index === 0) return { ...point, sec: 0, sourceSec: 0 }
    if (index === params.points.length - 1) {
      return {
        ...point,
        sec: roundTrackTempoSec(safeDurationSec),
        sourceSec: roundTrackTempoSec(safeSourceDurationSec)
      }
    }
    const sourceSec = Number(point.sourceSec)
    if (!Number.isFinite(sourceSec) || sourceSec < 0) return point
    const clampedSourceSec = roundTrackTempoSec(
      clampTrackTempoNumber(sourceSec, 0, safeSourceDurationSec)
    )
    if (point.allowOffGrid === true) {
      return {
        ...point,
        sec: roundTrackTempoSec(clampTrackTempoNumber(Number(point.sec) || 0, 0, safeDurationSec)),
        sourceSec: clampedSourceSec
      }
    }
    return {
      ...point,
      sourceSec: clampedSourceSec,
      sec: resolveTrackLocalSecAtSourceTime({
        points: params.points,
        sourceSec,
        durationSec: safeDurationSec,
        sourceDurationSec: safeSourceDurationSec,
        originalBpm: params.originalBpm,
        fallbackBpm: params.fallbackBpm,
        integralCache: tempoRatioIntegralCache
      })
    }
  })
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
      clampTrackTempoNumber(Number(point.sec) || 0, 0, Math.max(0, Number(params.durationSec) || 0))
    )
  }
  const tempoRatioIntegralCache = buildTempoRatioIntegralCache({
    points: params.points,
    durationSec: params.durationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  return params.points.map((point) =>
    roundTrackTempoSec(
      resolveTrackSourceTimeAtLocalSec({
        points: params.points,
        localSec: Number(point.sec) || 0,
        durationSec: params.durationSec,
        sourceDurationSec: safeSourceDuration,
        originalBpm: params.originalBpm,
        fallbackBpm: params.fallbackBpm,
        integralCache: tempoRatioIntegralCache
      })
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
    return normalizeTrackBpmEnvelopePoints([], safeSourceDuration, fallbackBpm)
  }
  const points: MixtapeBpmPoint[] = []
  let localSec = 0
  for (let index = 0; index < params.bpms.length; index += 1) {
    const sourceAnchorSec = clampTrackTempoNumber(
      Number(params.sourceAnchorsSec[index]) || 0,
      0,
      safeSourceDuration
    )
    const bpm = clampTrackTempoNumber(
      Number(params.bpms[index]) || fallbackBpm,
      clampRange.minBpm,
      clampRange.maxBpm
    )
    if (!points.length) {
      points.push({
        sec: 0,
        bpm,
        sourceSec: 0
      })
      continue
    }
    const prevSourceAnchorSec = clampTrackTempoNumber(
      Number(params.sourceAnchorsSec[index - 1]) || 0,
      0,
      safeSourceDuration
    )
    const prevBpm = points[points.length - 1]?.bpm ?? bpm
    const deltaSourceSec = Math.max(0, sourceAnchorSec - prevSourceAnchorSec)
    const avgRatio =
      (clampTrackTempoNumber(prevBpm / originalBpm, 0.25, 4) +
        clampTrackTempoNumber(bpm / originalBpm, 0.25, 4)) /
      2
    localSec += deltaSourceSec / Math.max(BPM_POINT_SEC_EPSILON, avgRatio)
    points.push({
      sec: roundTrackTempoSec(localSec),
      bpm,
      sourceSec: roundTrackTempoSec(sourceAnchorSec)
    })
  }
  return normalizeTrackBpmEnvelopePoints(points, roundTrackTempoSec(localSec), fallbackBpm)
}

const buildTrackBeatPositionsFromSourceGrid = (params: {
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
  const tempoRatioIntegralCache = buildTempoRatioIntegralCache({
    points: params.points,
    durationSec: safeDurationSec,
    originalBpm: params.originalBpm,
    fallbackBpm: params.fallbackBpm
  })
  for (let beatIndex = minIndex; beatIndex <= maxIndex; beatIndex += 1) {
    const sourceSec = firstBeatSourceSec + beatIndex * beatSourceSec
    const localSec = resolveTrackLocalSecAtSourceTime({
      points: params.points,
      sourceSec,
      durationSec: safeDurationSec,
      sourceDurationSec: safeSourceDurationSec,
      originalBpm: params.originalBpm,
      fallbackBpm: params.fallbackBpm,
      integralCache: tempoRatioIntegralCache
    })
    positions.push(roundTrackTempoSec(localSec))
  }
  return {
    positions,
    anchorIndex: -minIndex
  }
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
  overrideLines?: TrackVisibleGridLine[]
  overrideRange?: {
    startSec: number
    endSec: number
  }
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
  const visibility = resolveVisibleGridVisibility(Number(params.zoom) || 0)
  const lines: TrackVisibleGridLine[] = []
  for (let index = 0; index < beatGrid.positions.length; index += 1) {
    const positionSec = beatGrid.positions[index]
    const sourceSec = params.firstBeatSourceSec + (index - anchorIndex) * params.beatSourceSec
    const relativeBeatIndex = index - anchorIndex
    const shiftedIndex = relativeBeatIndex - normalizedBarOffset
    const mod32 = ((shiftedIndex % 32) + 32) % 32
    const mod4 = ((shiftedIndex % 4) + 4) % 4
    const level: TrackVisibleGridLine['level'] = mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
    if (level === 'bar' && visibility.showBar) {
      lines.push({
        sec: roundTrackTempoSec(positionSec),
        sourceSec: roundTrackTempoSec(sourceSec),
        level
      })
      continue
    }
    if (level === 'beat4' && visibility.showBeat4) {
      lines.push({
        sec: roundTrackTempoSec(positionSec),
        sourceSec: roundTrackTempoSec(sourceSec),
        level
      })
      continue
    }
    if (level === 'beat' && visibility.showBeat) {
      lines.push({
        sec: roundTrackTempoSec(positionSec),
        sourceSec: roundTrackTempoSec(sourceSec),
        level
      })
    }
  }
  return applyTrackVisibleGridOverrides({
    lines,
    overrideLines: params.overrideLines,
    overrideRange: params.overrideRange,
    visibility
  })
}

export const resolveNearestTrackVisibleGridLine = (params: {
  timeMap: TrackTimeMap
  localSec: number
  zoom: number
  minLocalSec?: number
  maxLocalSec?: number
}) =>
  params.timeMap.resolveNearestGridLine(params.localSec, params.zoom, {
    minLocalSec: params.minLocalSec,
    maxLocalSec: params.maxLocalSec
  })

export const snapTrackLocalSecToBeatGrid = (params: {
  timeMap: TrackTimeMap
  localSec: number
  zoom: number
  minLocalSec?: number
  maxLocalSec?: number
}) =>
  params.timeMap.snapLocalSec(params.localSec, params.zoom, {
    minLocalSec: params.minLocalSec,
    maxLocalSec: params.maxLocalSec
  })

const TRACK_TIME_MAP_SNAPSHOT_CACHE_LIMIT = 180
const trackTimeMapSnapshotCache = new Map<string, TrackTimeMap>()

const buildSerializedTrackTimeMapCacheKey = (snapshot: SerializedTrackTempoSnapshot) =>
  [
    String(snapshot.signature || ''),
    Math.round((Number(snapshot.sourceDurationSec) || 0) * 1000),
    Math.round((Number(snapshot.firstBeatSourceSec) || 0) * 1000),
    Math.round((Number(snapshot.beatSourceSec) || 0) * 1000),
    Math.round((Number(snapshot.barBeatOffset) || 0) * 1000)
  ].join('|')

const readTrackTimeMapSnapshotCache = (key: string) => {
  const cached = trackTimeMapSnapshotCache.get(key)
  if (!cached) return null
  trackTimeMapSnapshotCache.delete(key)
  trackTimeMapSnapshotCache.set(key, cached)
  return cached
}

const writeTrackTimeMapSnapshotCache = (key: string, value: TrackTimeMap) => {
  trackTimeMapSnapshotCache.set(key, value)
  if (trackTimeMapSnapshotCache.size <= TRACK_TIME_MAP_SNAPSHOT_CACHE_LIMIT) return
  const oldestKey = trackTimeMapSnapshotCache.keys().next().value
  if (typeof oldestKey === 'string') {
    trackTimeMapSnapshotCache.delete(oldestKey)
  }
}

export const createTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  const durationSec = Math.max(0, Number(input.durationSec) || 0)
  const sourceDurationSec = Math.max(0, Number(input.sourceDurationSec) || 0)
  const firstBeatSourceSec = Math.max(0, Number(input.firstBeatSourceSec) || 0)
  const beatSourceSec = Math.max(0, Number(input.beatSourceSec) || 0)
  const barBeatOffset = Number(input.barBeatOffset) || 0
  const renderPoints = resolveTrackBpmEnvelopeRenderablePoints({
    points: input.controlPoints,
    durationSec,
    sourceDurationSec,
    originalBpm: input.originalBpm,
    fallbackBpm: input.fallbackBpm
  })
  const tempoRatioIntegralCache = buildTempoRatioIntegralCache({
    points: renderPoints,
    durationSec,
    originalBpm: input.originalBpm,
    fallbackBpm: input.fallbackBpm
  })

  const buildLines = (zoom: number) =>
    buildTrackVisibleGridLines({
      points: renderPoints,
      durationSec,
      sourceDurationSec,
      firstBeatSourceSec,
      beatSourceSec,
      barBeatOffset,
      zoom,
      originalBpm: input.originalBpm,
      fallbackBpm: input.fallbackBpm,
      overrideLines: input.overrideLines,
      overrideRange: input.overrideRange
    })

  const filterLinesByRange = (
    lines: TrackVisibleGridLine[],
    range?: { minLocalSec?: number; maxLocalSec?: number }
  ) => {
    const minLocalSec = clampTrackTempoNumber(Number(range?.minLocalSec) || 0, 0, durationSec)
    const maxLocalSec = clampTrackTempoNumber(
      Number.isFinite(Number(range?.maxLocalSec)) ? Number(range?.maxLocalSec) : durationSec,
      minLocalSec,
      durationSec
    )
    return lines.filter(
      (line) =>
        line.sec >= minLocalSec - BPM_POINT_SEC_EPSILON &&
        line.sec <= maxLocalSec + BPM_POINT_SEC_EPSILON
    )
  }

  return {
    controlPoints: input.controlPoints,
    renderPoints,
    durationSec,
    sourceDurationSec,
    firstBeatSourceSec,
    beatSourceSec,
    barBeatOffset,
    mapLocalToSource: (localSec: number) =>
      resolveTrackSourceTimeAtLocalSec({
        points: renderPoints,
        localSec,
        durationSec,
        sourceDurationSec,
        originalBpm: input.originalBpm,
        fallbackBpm: input.fallbackBpm,
        integralCache: tempoRatioIntegralCache
      }),
    mapSourceToLocal: (sourceSec: number) =>
      resolveTrackLocalSecAtSourceTime({
        points: renderPoints,
        sourceSec,
        durationSec,
        sourceDurationSec,
        originalBpm: input.originalBpm,
        fallbackBpm: input.fallbackBpm,
        integralCache: tempoRatioIntegralCache
      }),
    sampleBpmAtLocal: (localSec: number) =>
      sampleTrackBpmEnvelopeAtSec(renderPoints, localSec, input.fallbackBpm),
    sampleBpmAtSource: (sourceSec: number) =>
      sampleTrackBpmEnvelopeAtSec(
        renderPoints,
        resolveTrackLocalSecAtSourceTime({
          points: renderPoints,
          sourceSec,
          durationSec,
          sourceDurationSec,
          originalBpm: input.originalBpm,
          fallbackBpm: input.fallbackBpm,
          integralCache: tempoRatioIntegralCache
        }),
        input.fallbackBpm
      ),
    buildVisibleGridLines: (zoom: number) => buildLines(zoom),
    buildSnapCandidates: (zoom: number) => buildLines(zoom).map((line) => line.sec),
    resolveNearestGridLine: (localSec: number, zoom: number, range) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, durationSec)
      const visibleGridLines = filterLinesByRange(buildLines(zoom), range)
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
    },
    snapLocalSec: (localSec: number, zoom: number, range) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, durationSec)
      if (safeLocalSec <= BPM_POINT_SEC_EPSILON) return 0
      if (safeLocalSec >= durationSec - BPM_POINT_SEC_EPSILON) {
        return roundTrackTempoSec(durationSec)
      }
      const visibleGridLines = filterLinesByRange(buildLines(zoom), range)
      if (!visibleGridLines.length) return roundTrackTempoSec(safeLocalSec)
      let nearest = visibleGridLines[0]!.sec
      let minDiff = Math.abs(nearest - safeLocalSec)
      for (let index = 1; index < visibleGridLines.length; index += 1) {
        const candidate = visibleGridLines[index]!.sec
        const diff = Math.abs(candidate - safeLocalSec)
        if (diff < minDiff) {
          nearest = candidate
          minDiff = diff
        }
      }
      return roundTrackTempoSec(nearest)
    }
  }
}

export const createTrackTimeMapFromSnapshotPayload = (
  snapshot: SerializedTrackTempoSnapshot
): TrackTimeMap => {
  const cacheKey = buildSerializedTrackTimeMapCacheKey(snapshot)
  const cached = readTrackTimeMapSnapshotCache(cacheKey)
  if (cached) return cached
  const next = createTrackTimeMap({
    controlPoints: snapshot.controlPoints.map((point) => ({
      sec: Number(point.sec),
      bpm: Number(point.bpm),
      sourceSec:
        Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
          ? Number(point.sourceSec)
          : undefined,
      allowOffGrid: point.allowOffGrid === true ? true : undefined
    })),
    durationSec: Number(snapshot.durationSec) || 0,
    sourceDurationSec: Number(snapshot.sourceDurationSec) || 0,
    originalBpm: Number(snapshot.originalBpm) || 0,
    fallbackBpm: Number(snapshot.baseBpm) || 128,
    firstBeatSourceSec: Number(snapshot.firstBeatSourceSec) || 0,
    beatSourceSec: Number(snapshot.beatSourceSec) || 0,
    barBeatOffset: Number(snapshot.barBeatOffset) || 0,
    overrideLines: Array.isArray(snapshot.overrideLines)
      ? snapshot.overrideLines.map((line) => ({
          sec: Number(line.sec),
          sourceSec: Number(line.sourceSec),
          level: line.level
        }))
      : [],
    overrideRange:
      Number.isFinite(Number(snapshot.overrideRange?.startSec)) &&
      Number.isFinite(Number(snapshot.overrideRange?.endSec))
        ? {
            startSec: Number(snapshot.overrideRange?.startSec),
            endSec: Number(snapshot.overrideRange?.endSec)
          }
        : undefined
  })
  writeTrackTimeMapSnapshotCache(cacheKey, next)
  return next
}
