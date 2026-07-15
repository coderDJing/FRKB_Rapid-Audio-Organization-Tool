import {
  GRID_BEAT_LINE_ZOOM,
  GRID_DOWNBEAT_LINE_ZOOM
} from '@renderer/composables/mixtape/constants'
import {
  BPM_MIN_VALUE,
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  normalizeTrackBpmValue,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrackLoopSegment } from '@renderer/composables/mixtape/types'
import {
  createUnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridLine,
  type UnifiedSongBeatGridLineLevel,
  type UnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridRuntimeClip
} from '@shared/songBeatGridRuntime'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

export type TrackVisibleGridLine = {
  sec: number
  sourceSec: number
  level: 'downbeat' | 'beat'
}

export type TrackTimeMapInput = {
  controlPoints: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
  firstBeatSourceSec: number
  beatSourceSec: number
  downbeatBeatOffset?: number
  sourceBeatGridMap?: SongBeatGridMapV2 | null
  loopSegments?: MixtapeTrackLoopSegment[]
  loopSegment?: MixtapeTrackLoopSegment
  mappingMode?: 'tempoEnvelope' | 'masterGrid'
  trackStartSec?: number
  masterGridFallbackBpm?: number
  masterGridPhaseOffsetSec?: number
  masterGridPoints?: MixtapeBpmPoint[]
}

export type TrackTimeMap = {
  controlPoints: MixtapeBpmPoint[]
  renderPoints: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  downbeatBeatOffset: number
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

export type DynamicSourceBeatMap = {
  runtime: UnifiedSongBeatGridRuntime
  startBeatOrdinal: number
  endBeatOrdinal: number
  beatSpan: number
  lines: UnifiedSongBeatGridLine[]
  firstBeatDelta: number
  firstDownbeatBeatDelta: number | null
  mapSourceToBeatOrdinal: (sourceSec: number) => number
  mapBeatOrdinalToSource: (beatOrdinal: number) => number
}

const resolveVisibleGridVisibility = (zoom: number) => ({
  showDownbeat: zoom >= GRID_DOWNBEAT_LINE_ZOOM,
  showBeat: zoom >= GRID_BEAT_LINE_ZOOM
})

const shouldShowGridLineLevel = (level: UnifiedSongBeatGridLineLevel, zoom: number) => {
  const visibility = resolveVisibleGridVisibility(zoom)
  if (level === 'downbeat') return visibility.showDownbeat
  return visibility.showBeat
}

const resolveRuntimeClipAtSec = (
  runtime: UnifiedSongBeatGridRuntime,
  secInput: number
): UnifiedSongBeatGridRuntimeClip | null => {
  const sec = clampTrackTempoNumber(Number(secInput) || 0, 0, runtime.durationSec)
  let left = 0
  let right = runtime.clips.length - 1
  let answer = runtime.clips[0] || null
  while (left <= right) {
    const middle = (left + right) >> 1
    const clip = runtime.clips[middle]
    if (!clip) break
    if (clip.startSec <= sec + BPM_POINT_SEC_EPSILON) {
      answer = clip
      left = middle + 1
    } else {
      right = middle - 1
    }
  }
  return answer && sec <= answer.endSec + BPM_POINT_SEC_EPSILON ? answer : null
}

const resolveRuntimeBeatOrdinalAtSec = (runtime: UnifiedSongBeatGridRuntime, secInput: number) => {
  const sec = clampTrackTempoNumber(Number(secInput) || 0, 0, runtime.durationSec)
  const lines = runtime.lines
  if (!lines.length) return 0
  for (let index = 0; index < lines.length - 1; index += 1) {
    const left = lines[index]
    const right = lines[index + 1]
    if (sec < left.sec || sec > right.sec) continue
    const spanSec = right.sec - left.sec
    if (!Number.isFinite(spanSec) || spanSec <= BPM_POINT_SEC_EPSILON) {
      return left.beatOrdinal
    }
    return left.beatOrdinal + (sec - left.sec) / spanSec
  }
  const clip = resolveRuntimeClipAtSec(runtime, sec) || runtime.clips[0]
  const referenceLine = sec < lines[0].sec ? lines[0] : lines[lines.length - 1]
  if (!clip || !referenceLine) return lines[0].beatOrdinal
  return referenceLine.beatOrdinal + (sec - referenceLine.sec) / clip.beatSec
}

const resolveRuntimeSecAtBeatOrdinal = (
  runtime: UnifiedSongBeatGridRuntime,
  beatOrdinalInput: number
) => {
  const beatOrdinal = Number(beatOrdinalInput)
  const lines = runtime.lines
  if (!Number.isFinite(beatOrdinal) || !lines.length) return 0
  const firstLine = lines[0]
  if (beatOrdinal <= firstLine.beatOrdinal) {
    const clip = resolveRuntimeClipAtSec(runtime, 0) || runtime.clips[0]
    const beatSec = clip?.beatSec || BPM_POINT_SEC_EPSILON
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        firstLine.sec + (beatOrdinal - firstLine.beatOrdinal) * beatSec,
        0,
        runtime.durationSec
      )
    )
  }
  const lastLine = lines[lines.length - 1]
  if (beatOrdinal >= lastLine.beatOrdinal) {
    const clip =
      resolveRuntimeClipAtSec(runtime, runtime.durationSec) ||
      runtime.clips[runtime.clips.length - 1]
    const beatSec = clip?.beatSec || BPM_POINT_SEC_EPSILON
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        lastLine.sec + (beatOrdinal - lastLine.beatOrdinal) * beatSec,
        0,
        runtime.durationSec
      )
    )
  }
  const leftOrdinal = Math.floor(beatOrdinal)
  const rightOrdinal = Math.ceil(beatOrdinal)
  const leftLine = lines.find((line) => line.beatOrdinal === leftOrdinal) || null
  const rightLine = lines.find((line) => line.beatOrdinal === rightOrdinal) || null
  if (!leftLine || !rightLine) return roundTrackTempoSec(runtime.durationSec)
  if (leftOrdinal === rightOrdinal) return roundTrackTempoSec(leftLine.sec)
  const ratio = beatOrdinal - leftOrdinal
  return roundTrackTempoSec(leftLine.sec + (rightLine.sec - leftLine.sec) * ratio)
}

export const createDynamicSourceBeatMap = (
  sourceBeatGridMap: SongBeatGridMapV2 | null | undefined,
  sourceDurationSecInput: number
): DynamicSourceBeatMap | null => {
  const sourceDurationSec = Math.max(0, Number(sourceDurationSecInput) || 0)
  const runtime = createUnifiedSongBeatGridRuntime(sourceBeatGridMap, sourceDurationSec)
  if (!runtime) return null
  const startBeatOrdinal = resolveRuntimeBeatOrdinalAtSec(runtime, 0)
  const endBeatOrdinal = resolveRuntimeBeatOrdinalAtSec(runtime, sourceDurationSec)
  const beatSpan = endBeatOrdinal - startBeatOrdinal
  if (!Number.isFinite(beatSpan) || beatSpan <= BPM_POINT_SEC_EPSILON) return null
  const firstBeatLine = runtime.lines[0] || null
  const firstDownbeatLine = runtime.lines.find((line) => line.level === 'downbeat') || null
  return {
    runtime,
    startBeatOrdinal,
    endBeatOrdinal,
    beatSpan,
    lines: runtime.lines,
    firstBeatDelta: firstBeatLine ? firstBeatLine.beatOrdinal - startBeatOrdinal : 0,
    firstDownbeatBeatDelta: firstDownbeatLine
      ? firstDownbeatLine.beatOrdinal - startBeatOrdinal
      : null,
    mapSourceToBeatOrdinal: (sourceSec: number) =>
      resolveRuntimeBeatOrdinalAtSec(runtime, sourceSec),
    mapBeatOrdinalToSource: (beatOrdinal: number) =>
      resolveRuntimeSecAtBeatOrdinal(runtime, beatOrdinal)
  }
}

export const resolveDynamicSourceBeatSpan = (
  sourceBeatGridMap: SongBeatGridMapV2 | null | undefined,
  sourceDurationSec: number
) => createDynamicSourceBeatMap(sourceBeatGridMap, sourceDurationSec)?.beatSpan ?? null

export const resolveDynamicSourceTimelineDurationByBpm = (params: {
  sourceBeatGridMap?: SongBeatGridMapV2 | null
  sourceDurationSec: number
  targetBpm: number
}) => {
  const beatSpan = resolveDynamicSourceBeatSpan(params.sourceBeatGridMap, params.sourceDurationSec)
  const targetBpm = normalizeTrackBpmValue(params.targetBpm)
  if (beatSpan === null || targetBpm === null) return null
  return roundTrackTempoSec((beatSpan * 60) / Math.max(BPM_MIN_VALUE, targetBpm))
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
    return Number((prev.bpm + (point.bpm - prev.bpm) * ratio).toFixed(6))
  }
  return points[points.length - 1]?.bpm ?? fallbackBpm
}

const resolveTrackTempoRatioAtSec = (params: {
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
  startRatio: number
  endRatio: number
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

const resolveLinearTempoRatioIntegral = (params: {
  startRatio: number
  endRatio: number
  spanSec: number
  deltaSec: number
}) => {
  const spanSec = Math.max(BPM_POINT_SEC_EPSILON, Number(params.spanSec) || 0)
  const deltaSec = clampTrackTempoNumber(Number(params.deltaSec) || 0, 0, spanSec)
  const startRatio = Number(params.startRatio) || 0
  const endRatio = Number(params.endRatio) || startRatio
  const ratioSlope = (endRatio - startRatio) / spanSec
  return startRatio * deltaSec + 0.5 * ratioSlope * deltaSec * deltaSec
}

const resolveLinearTempoRatioDeltaSec = (params: {
  startRatio: number
  endRatio: number
  spanSec: number
  targetIntegral: number
}) => {
  const spanSec = Math.max(BPM_POINT_SEC_EPSILON, Number(params.spanSec) || 0)
  const targetIntegral = Math.max(0, Number(params.targetIntegral) || 0)
  const startRatio = Number(params.startRatio) || 0
  const endRatio = Number(params.endRatio) || startRatio
  const ratioSlope = (endRatio - startRatio) / spanSec
  if (Math.abs(ratioSlope) <= 1e-9) {
    return clampTrackTempoNumber(
      targetIntegral / Math.max(BPM_POINT_SEC_EPSILON, startRatio),
      0,
      spanSec
    )
  }
  const a = 0.5 * ratioSlope
  const b = startRatio
  const c = -targetIntegral
  const discriminant = Math.max(0, b * b - 4 * a * c)
  const sqrtDiscriminant = Math.sqrt(discriminant)
  const candidates = [(-b + sqrtDiscriminant) / (2 * a), (-b - sqrtDiscriminant) / (2 * a)]
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate >= -BPM_POINT_SEC_EPSILON) {
      return clampTrackTempoNumber(candidate, 0, spanSec)
    }
  }
  return clampTrackTempoNumber(
    targetIntegral / Math.max(BPM_POINT_SEC_EPSILON, startRatio),
    0,
    spanSec
  )
}

export const buildTempoRatioIntegralCache = (params: {
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
    const deltaSec = endSec - startSec
    const integralBefore = totalIntegral
    totalIntegral += resolveLinearTempoRatioIntegral({
      startRatio: leftRatio,
      endRatio: rightRatio,
      spanSec: deltaSec,
      deltaSec
    })
    segments.push({
      startSec,
      endSec,
      startRatio: leftRatio,
      endRatio: rightRatio,
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
        startRatio: lastRatio,
        endRatio: lastRatio,
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
  return (
    segment.integralBefore +
    resolveLinearTempoRatioIntegral({
      startRatio: segment.startRatio,
      endRatio: segment.endRatio,
      spanSec: segment.endSec - segment.startSec,
      deltaSec
    })
  )
}

type TrackTargetBeatIntegralCache = {
  referenceBpm: number
  ratioCache: TempoRatioIntegralCache
  durationSec: number
  totalBeats: number
}

export const buildTrackTargetBeatIntegralCache = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  fallbackBpm: number
}): TrackTargetBeatIntegralCache => {
  const referenceBpm = normalizeTrackBpmValue(params.fallbackBpm) ?? 128
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const ratioCache = buildTempoRatioIntegralCache({
    points: params.points,
    durationSec,
    originalBpm: referenceBpm,
    fallbackBpm: params.fallbackBpm
  })
  return {
    referenceBpm,
    ratioCache,
    durationSec,
    totalBeats: (ratioCache.totalIntegral * referenceBpm) / 60
  }
}

export const resolveTargetBeatDeltaAtLocalSec = (
  cache: TrackTargetBeatIntegralCache,
  localSec: number
) => (resolveTempoRatioIntegralAtLocalSec(cache.ratioCache, localSec) * cache.referenceBpm) / 60

export const resolveLocalSecAtTargetBeatDelta = (
  cache: TrackTargetBeatIntegralCache,
  beatDeltaInput: number
) => {
  const beatDelta = clampTrackTempoNumber(
    Number(beatDeltaInput) || 0,
    0,
    Math.max(0, cache.totalBeats)
  )
  const targetIntegral = (beatDelta * 60) / Math.max(BPM_MIN_VALUE, cache.referenceBpm)
  const ratioCache = cache.ratioCache
  if (targetIntegral <= BPM_POINT_SEC_EPSILON) return 0
  if (targetIntegral >= ratioCache.totalIntegral - BPM_POINT_SEC_EPSILON) {
    return roundTrackTempoSec(cache.durationSec)
  }
  if (ratioCache.mode === 'linear') {
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        (targetIntegral / Math.max(BPM_POINT_SEC_EPSILON, ratioCache.totalIntegral)) *
          cache.durationSec,
        0,
        cache.durationSec
      )
    )
  }
  if (ratioCache.mode === 'constant') {
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        targetIntegral / Math.max(BPM_POINT_SEC_EPSILON, ratioCache.constantRatio),
        0,
        cache.durationSec
      )
    )
  }
  const segment = findTempoRatioIntegralSegmentByIntegral(ratioCache.segments, targetIntegral)
  if (!segment) return roundTrackTempoSec(cache.durationSec)
  if (targetIntegral <= segment.integralBefore + BPM_POINT_SEC_EPSILON) {
    return roundTrackTempoSec(segment.startSec)
  }
  return roundTrackTempoSec(
    clampTrackTempoNumber(
      segment.startSec +
        resolveLinearTempoRatioDeltaSec({
          startRatio: segment.startRatio,
          endRatio: segment.endRatio,
          spanSec: segment.endSec - segment.startSec,
          targetIntegral: targetIntegral - segment.integralBefore
        }),
      segment.startSec,
      segment.endSec
    )
  )
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
    integral += resolveLinearTempoRatioIntegral({
      startRatio: leftRatio,
      endRatio: rightRatio,
      spanSec: Math.max(BPM_POINT_SEC_EPSILON, right.sec - left.sec),
      deltaSec: segmentEnd - segmentStart
    })
    if (right.sec >= safeEndSec - BPM_POINT_SEC_EPSILON) break
  }
  const lastPoint = points[points.length - 1]
  if (lastPoint && safeEndSec > lastPoint.sec + BPM_POINT_SEC_EPSILON) {
    const lastRatio = clampTrackTempoNumber(lastPoint.bpm / originalBpm, 0.25, 4)
    integral += lastRatio * (safeEndSec - lastPoint.sec)
  }
  return integral
}

const resolveTrackSourceProgressAtLocalSec = (params: {
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
      resolveLinearTempoRatioDeltaSec({
        startRatio: segment.startRatio,
        endRatio: segment.endRatio,
        spanSec: segment.endSec - segment.startSec,
        targetIntegral: targetIntegral - segment.integralBefore
      })
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

export const buildTrackVisibleGridLinesFromDynamicSourceGrid = (params: {
  sourceBeatGridMap?: SongBeatGridMapV2 | null
  sourceDurationSec: number
  zoom?: number
  mapSourceToLocal: (sourceSec: number) => number
}) => {
  const runtime = createUnifiedSongBeatGridRuntime(
    params.sourceBeatGridMap,
    params.sourceDurationSec
  )
  if (!runtime) return null
  const zoom = Number(params.zoom) || 0
  const lines: TrackVisibleGridLine[] = []
  for (const sourceLine of runtime.lines) {
    if (!shouldShowGridLineLevel(sourceLine.level, zoom)) continue
    const localSec = params.mapSourceToLocal(sourceLine.sec)
    if (!Number.isFinite(localSec)) continue
    lines.push({
      sec: roundTrackTempoSec(localSec),
      sourceSec: roundTrackTempoSec(sourceLine.sec),
      level: sourceLine.level
    })
  }
  return lines
}

export const buildTrackVisibleGridLines = (params: {
  points: MixtapeBpmPoint[]
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  downbeatBeatOffset?: number
  sourceBeatGridMap?: SongBeatGridMapV2 | null
  zoom?: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const dynamicLines = buildTrackVisibleGridLinesFromDynamicSourceGrid({
    sourceBeatGridMap: params.sourceBeatGridMap,
    sourceDurationSec: params.sourceDurationSec,
    zoom: params.zoom,
    mapSourceToLocal: (sourceSec) =>
      resolveTrackLocalSecAtSourceTime({
        points: params.points,
        sourceSec,
        durationSec: params.durationSec,
        sourceDurationSec: params.sourceDurationSec,
        originalBpm: params.originalBpm,
        fallbackBpm: params.fallbackBpm
      })
  })
  return dynamicLines ?? []
}
