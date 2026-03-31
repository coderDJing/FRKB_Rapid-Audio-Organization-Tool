import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import { normalizeBeatOffset } from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  BPM_MIN_VALUE,
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { TrackVisibleGridLine } from '@renderer/composables/mixtape/trackTimeMapCore'
import type { MixtapeBpmPoint } from '@renderer/composables/mixtape/types'

type MixtapeMasterGridIntegralSegment = {
  startSec: number
  endSec: number
  startBpm: number
  endBpm: number
  beatsBefore: number
  beatsAfter: number
}

type MixtapeMasterGridIntegralCache = {
  durationSec: number
  totalBeats: number
  tailBpm: number
  segments: MixtapeMasterGridIntegralSegment[]
}

export type MixtapeMasterGridLine = {
  sec: number
  beat: number
  level: 'bar' | 'beat4' | 'beat'
}

type MixtapeMasterGridRange = {
  minSec?: number
  maxSec?: number
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const normalizeMixtapeMasterGridPhaseOffsetSec = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return roundTrackTempoSec(numeric)
}

export const sampleMixtapeMasterGridBpmAtSec = (
  points: MixtapeBpmPoint[],
  sec: number,
  fallbackBpm: number
) => {
  const safeFallbackBpm = Math.max(BPM_MIN_VALUE, Number(fallbackBpm) || 128)
  if (!points.length) return safeFallbackBpm
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= Number(points[0]?.sec) + BPM_POINT_SEC_EPSILON) {
    return Math.max(BPM_MIN_VALUE, Number(points[0]?.bpm) || safeFallbackBpm)
  }
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]
    const previous = points[index - 1]
    if (safeSec > Number(current?.sec) + BPM_POINT_SEC_EPSILON) continue
    const startSec = Number(previous?.sec) || 0
    const endSec = Math.max(startSec + BPM_POINT_SEC_EPSILON, Number(current?.sec) || startSec)
    const spanSec = endSec - startSec
    const ratio = clampNumber((safeSec - startSec) / spanSec, 0, 1)
    const startBpm = Math.max(BPM_MIN_VALUE, Number(previous?.bpm) || safeFallbackBpm)
    const endBpm = Math.max(BPM_MIN_VALUE, Number(current?.bpm) || startBpm)
    return Number((startBpm + (endBpm - startBpm) * ratio).toFixed(4))
  }
  return Math.max(BPM_MIN_VALUE, Number(points[points.length - 1]?.bpm) || safeFallbackBpm)
}

const buildMixtapeMasterGridIntegralCache = (
  points: MixtapeBpmPoint[],
  fallbackBpm: number
): MixtapeMasterGridIntegralCache => {
  const durationSec = Math.max(0, Number(points[points.length - 1]?.sec) || 0)
  const tailBpm = sampleMixtapeMasterGridBpmAtSec(points, durationSec, fallbackBpm)
  if (points.length < 2 || durationSec <= BPM_POINT_SEC_EPSILON) {
    return {
      durationSec,
      totalBeats: (durationSec * tailBpm) / 60,
      tailBpm,
      segments: []
    }
  }
  const segments: MixtapeMasterGridIntegralSegment[] = []
  let totalBeats = 0
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]
    const right = points[index]
    const startSec = Math.max(0, Number(left?.sec) || 0)
    const endSec = Math.max(startSec, Number(right?.sec) || 0)
    const spanSec = endSec - startSec
    if (spanSec <= BPM_POINT_SEC_EPSILON) continue
    const startBpm = Math.max(BPM_MIN_VALUE, Number(left?.bpm) || fallbackBpm || 128)
    const endBpm = Math.max(BPM_MIN_VALUE, Number(right?.bpm) || startBpm)
    const beatsBefore = totalBeats
    totalBeats += ((startBpm + endBpm) * 0.5 * spanSec) / 60
    segments.push({
      startSec,
      endSec,
      startBpm,
      endBpm,
      beatsBefore,
      beatsAfter: totalBeats
    })
  }
  return {
    durationSec,
    totalBeats,
    tailBpm,
    segments
  }
}

const resolveMixtapeMasterGridRawBeatsAtSec = (
  cache: MixtapeMasterGridIntegralCache,
  sec: number
) => {
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= 0) return 0
  if (!cache.segments.length) {
    return (safeSec * cache.tailBpm) / 60
  }
  if (safeSec >= cache.durationSec - BPM_POINT_SEC_EPSILON) {
    return (
      cache.totalBeats +
      (Math.max(0, safeSec - cache.durationSec) * Math.max(BPM_MIN_VALUE, cache.tailBpm)) / 60
    )
  }
  for (const segment of cache.segments) {
    if (safeSec > segment.endSec + BPM_POINT_SEC_EPSILON) continue
    if (safeSec <= segment.startSec + BPM_POINT_SEC_EPSILON) return segment.beatsBefore
    const spanSec = Math.max(BPM_POINT_SEC_EPSILON, segment.endSec - segment.startSec)
    const deltaSec = clampNumber(safeSec - segment.startSec, 0, spanSec)
    const bpmSlope = (segment.endBpm - segment.startBpm) / spanSec
    const beatsDelta = (segment.startBpm * deltaSec + 0.5 * bpmSlope * deltaSec * deltaSec) / 60
    return segment.beatsBefore + beatsDelta
  }
  return cache.totalBeats
}

const resolveMixtapeMasterGridSecByRawBeats = (
  cache: MixtapeMasterGridIntegralCache,
  beats: number
) => {
  const safeBeats = Math.max(0, Number(beats) || 0)
  if (safeBeats <= 0) return 0
  if (!cache.segments.length) {
    return roundTrackTempoSec((safeBeats * 60) / Math.max(BPM_MIN_VALUE, cache.tailBpm))
  }
  if (safeBeats >= cache.totalBeats - BPM_POINT_SEC_EPSILON) {
    return roundTrackTempoSec(
      cache.durationSec +
        ((safeBeats - cache.totalBeats) * 60) / Math.max(BPM_MIN_VALUE, cache.tailBpm)
    )
  }
  for (const segment of cache.segments) {
    if (safeBeats > segment.beatsAfter + BPM_POINT_SEC_EPSILON) continue
    if (safeBeats <= segment.beatsBefore + BPM_POINT_SEC_EPSILON) return segment.startSec
    const targetBeatDelta = safeBeats - segment.beatsBefore
    const spanSec = Math.max(BPM_POINT_SEC_EPSILON, segment.endSec - segment.startSec)
    const bpmSlope = (segment.endBpm - segment.startBpm) / spanSec
    const a = bpmSlope / 120
    const b = segment.startBpm / 60
    const c = -targetBeatDelta
    let deltaSec = 0
    if (Math.abs(a) <= 1e-9) {
      deltaSec = targetBeatDelta / Math.max(BPM_POINT_SEC_EPSILON, b)
    } else {
      const discriminant = Math.max(0, b * b - 4 * a * c)
      const sqrtDiscriminant = Math.sqrt(discriminant)
      const candidates = [(-b + sqrtDiscriminant) / (2 * a), (-b - sqrtDiscriminant) / (2 * a)]
      const matched =
        candidates.find(
          (candidate) => Number.isFinite(candidate) && candidate >= -BPM_POINT_SEC_EPSILON
        ) ?? targetBeatDelta / Math.max(BPM_POINT_SEC_EPSILON, b)
      deltaSec = matched
    }
    return roundTrackTempoSec(
      clampNumber(segment.startSec + deltaSec, segment.startSec, segment.endSec)
    )
  }
  return roundTrackTempoSec(cache.durationSec)
}

const resolveMasterGridVisibility = (zoom: number) => ({
  showBar: true,
  showBeat4: zoom >= GRID_BEAT4_LINE_ZOOM,
  showBeat: zoom >= GRID_BEAT_LINE_ZOOM
})

const resolveMasterGridTailBpm = (points: MixtapeBpmPoint[], fallbackBpm: number) =>
  sampleMixtapeMasterGridBpmAtSec(points, Number(points[points.length - 1]?.sec) || 0, fallbackBpm)

export const buildMixtapeMasterGridSignature = (
  points: MixtapeBpmPoint[],
  phaseOffsetSec: number = 0
) =>
  [
    Math.round(normalizeMixtapeMasterGridPhaseOffsetSec(phaseOffsetSec) * 1000),
    points
      .map((point) => {
        const sec = Math.round((Number(point?.sec) || 0) * 1000)
        const bpm = Math.round((Number(point?.bpm) || 0) * 1000)
        return `${sec}:${bpm}`
      })
      .join(';')
  ].join('|')

export const createMixtapeMasterGrid = (params: {
  points: MixtapeBpmPoint[]
  fallbackBpm: number
  phaseOffsetSec?: number
}) => {
  const points = Array.isArray(params.points)
    ? params.points.map((point) => ({
        sec: Number(point?.sec) || 0,
        bpm: Math.max(BPM_MIN_VALUE, Number(point?.bpm) || params.fallbackBpm || 128)
      }))
    : []
  const fallbackBpm = Math.max(BPM_MIN_VALUE, Number(params.fallbackBpm) || 128)
  const cache = buildMixtapeMasterGridIntegralCache(points, fallbackBpm)
  const tailBpm = resolveMasterGridTailBpm(points, fallbackBpm)
  const phaseOffsetSec = normalizeMixtapeMasterGridPhaseOffsetSec(params.phaseOffsetSec)
  const phaseOffsetBeats = resolveMixtapeMasterGridRawBeatsAtSec(cache, phaseOffsetSec)
  const mapSecToBeats = (sec: number) =>
    resolveMixtapeMasterGridRawBeatsAtSec(cache, sec) - phaseOffsetBeats
  const mapBeatsToSec = (beats: number) =>
    resolveMixtapeMasterGridSecByRawBeats(cache, Number(beats) + phaseOffsetBeats)

  const buildVisibleGridLines = (zoom: number, range?: MixtapeMasterGridRange) => {
    const visibility = resolveMasterGridVisibility(Number(zoom) || 0)
    const minSec = Math.max(0, Number(range?.minSec) || 0)
    const maxSec = Math.max(
      minSec,
      Number.isFinite(Number(range?.maxSec)) ? Number(range?.maxSec) : cache.durationSec
    )
    const minBeat = Math.ceil(mapSecToBeats(minSec) - BPM_POINT_SEC_EPSILON)
    const maxBeat = Math.floor(mapSecToBeats(maxSec) + BPM_POINT_SEC_EPSILON)
    const lines: MixtapeMasterGridLine[] = []
    for (let beat = minBeat; beat <= maxBeat; beat += 1) {
      const mod32 = ((beat % 32) + 32) % 32
      const mod4 = ((beat % 4) + 4) % 4
      const level: MixtapeMasterGridLine['level'] =
        mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
      if (level === 'beat' && !visibility.showBeat) continue
      if (level === 'beat4' && !visibility.showBeat4) continue
      const sec = mapBeatsToSec(beat)
      if (sec < minSec - BPM_POINT_SEC_EPSILON || sec > maxSec + BPM_POINT_SEC_EPSILON) continue
      lines.push({
        sec,
        beat,
        level
      })
    }
    return lines
  }

  return {
    points,
    durationSec: cache.durationSec,
    totalBeats: cache.totalBeats,
    tailBpm,
    phaseOffsetSec,
    signature: buildMixtapeMasterGridSignature(points, phaseOffsetSec),
    sampleBpmAtSec: (sec: number) => sampleMixtapeMasterGridBpmAtSec(points, sec, fallbackBpm),
    mapSecToBeats,
    mapBeatsToSec,
    buildVisibleGridLines
  }
}

export const mapMixtapeMasterGridTimelineSec = (params: {
  fromPoints: MixtapeBpmPoint[]
  toPoints: MixtapeBpmPoint[]
  sec: number
  fromFallbackBpm: number
  toFallbackBpm: number
  fromPhaseOffsetSec?: number
  toPhaseOffsetSec?: number
}) => {
  const fromGrid = createMixtapeMasterGrid({
    points: params.fromPoints,
    fallbackBpm: params.fromFallbackBpm,
    phaseOffsetSec: params.fromPhaseOffsetSec
  })
  const toGrid = createMixtapeMasterGrid({
    points: params.toPoints,
    fallbackBpm: params.toFallbackBpm,
    phaseOffsetSec: params.toPhaseOffsetSec
  })
  return toGrid.mapBeatsToSec(fromGrid.mapSecToBeats(Number(params.sec) || 0))
}

export const buildProjectedMasterGridTempoPoints = (params: {
  points: MixtapeBpmPoint[]
  trackStartSec: number
  durationSec: number
  fallbackBpm: number
}) => {
  const startSec = Math.max(0, Number(params.trackStartSec) || 0)
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const endSec = roundTrackTempoSec(startSec + durationSec)
  const projectedPoints: MixtapeBpmPoint[] = [
    {
      sec: 0,
      bpm: sampleMixtapeMasterGridBpmAtSec(params.points, startSec, params.fallbackBpm)
    }
  ]
  for (const point of params.points) {
    const absoluteSec = Number(point?.sec)
    if (absoluteSec <= startSec + BPM_POINT_SEC_EPSILON) continue
    if (absoluteSec >= endSec - BPM_POINT_SEC_EPSILON) continue
    projectedPoints.push({
      sec: roundTrackTempoSec(absoluteSec - startSec),
      bpm: Number(point?.bpm) || params.fallbackBpm
    })
  }
  projectedPoints.push({
    sec: roundTrackTempoSec(durationSec),
    bpm: sampleMixtapeMasterGridBpmAtSec(params.points, endSec, params.fallbackBpm)
  })
  return projectedPoints
}

const resolveTrackStartBeat = (
  grid: ReturnType<typeof createMixtapeMasterGrid>,
  trackStartSec: number
) => grid.mapSecToBeats(Math.max(0, Number(trackStartSec) || 0))

export const resolveTrackTimelineDurationOnMasterGrid = (params: {
  grid: ReturnType<typeof createMixtapeMasterGrid>
  trackStartSec: number
  sourceDurationSec: number
  beatSourceSec: number
}) => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, Number(params.beatSourceSec) || 0)
  const trackStartSec = Math.max(0, Number(params.trackStartSec) || 0)
  const startBeat = resolveTrackStartBeat(params.grid, trackStartSec)
  return roundTrackTempoSec(
    Math.max(
      0,
      params.grid.mapBeatsToSec(startBeat + sourceDurationSec / beatSourceSec) - trackStartSec
    )
  )
}

export const mapTrackSourceToLocalOnMasterGrid = (params: {
  grid: ReturnType<typeof createMixtapeMasterGrid>
  trackStartSec: number
  sourceSec: number
  sourceDurationSec: number
  beatSourceSec: number
  durationSec: number
}) => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, Number(params.beatSourceSec) || 0)
  const sourceSec = clampTrackTempoNumber(Number(params.sourceSec) || 0, 0, sourceDurationSec)
  const trackStartSec = Math.max(0, Number(params.trackStartSec) || 0)
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const startBeat = resolveTrackStartBeat(params.grid, trackStartSec)
  const localSec = params.grid.mapBeatsToSec(startBeat + sourceSec / beatSourceSec) - trackStartSec
  return roundTrackTempoSec(clampTrackTempoNumber(localSec, 0, durationSec))
}

export const mapTrackLocalToSourceOnMasterGrid = (params: {
  grid: ReturnType<typeof createMixtapeMasterGrid>
  trackStartSec: number
  localSec: number
  sourceDurationSec: number
  beatSourceSec: number
  durationSec: number
}) => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, Number(params.beatSourceSec) || 0)
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const trackStartSec = Math.max(0, Number(params.trackStartSec) || 0)
  const localSec = clampTrackTempoNumber(Number(params.localSec) || 0, 0, durationSec)
  const startBeat = resolveTrackStartBeat(params.grid, trackStartSec)
  const timelineBeat = params.grid.mapSecToBeats(trackStartSec + localSec)
  const sourceSec = (timelineBeat - startBeat) * beatSourceSec
  return roundTrackTempoSec(clampTrackTempoNumber(sourceSec, 0, sourceDurationSec))
}

export const buildTrackVisibleGridLinesOnMasterGrid = (params: {
  grid: ReturnType<typeof createMixtapeMasterGrid>
  trackStartSec: number
  durationSec: number
  sourceDurationSec: number
  firstBeatSourceSec: number
  beatSourceSec: number
  barBeatOffset?: number
  zoom?: number
}): TrackVisibleGridLine[] => {
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const firstBeatSourceSec = Number(params.firstBeatSourceSec)
  const beatSourceSec = Number(params.beatSourceSec)
  const trackStartSec = Math.max(0, Number(params.trackStartSec) || 0)
  if (
    durationSec <= BPM_POINT_SEC_EPSILON ||
    sourceDurationSec <= BPM_POINT_SEC_EPSILON ||
    !Number.isFinite(firstBeatSourceSec) ||
    !Number.isFinite(beatSourceSec) ||
    beatSourceSec <= BPM_POINT_SEC_EPSILON
  ) {
    return []
  }
  const visibility = resolveMasterGridVisibility(Number(params.zoom) || 0)
  const normalizedBarOffset = normalizeBeatOffset(params.barBeatOffset, 32)
  const minBeatIndex = Math.ceil((0 - firstBeatSourceSec) / beatSourceSec)
  const maxBeatIndex = Math.floor((sourceDurationSec - firstBeatSourceSec) / beatSourceSec)
  if (minBeatIndex > maxBeatIndex) return []
  const startBeat = resolveTrackStartBeat(params.grid, trackStartSec)
  const lines: TrackVisibleGridLine[] = []
  for (let beatIndex = minBeatIndex; beatIndex <= maxBeatIndex; beatIndex += 1) {
    const sourceSec = firstBeatSourceSec + beatIndex * beatSourceSec
    const timelineSec = params.grid.mapBeatsToSec(startBeat + sourceSec / beatSourceSec)
    const localSec = timelineSec - trackStartSec
    if (localSec < -BPM_POINT_SEC_EPSILON || localSec > durationSec + BPM_POINT_SEC_EPSILON) {
      continue
    }
    const shiftedIndex = beatIndex - normalizedBarOffset
    const mod32 = ((shiftedIndex % 32) + 32) % 32
    const mod4 = ((shiftedIndex % 4) + 4) % 4
    const level: TrackVisibleGridLine['level'] = mod32 === 0 ? 'bar' : mod4 === 0 ? 'beat4' : 'beat'
    if (level === 'beat' && !visibility.showBeat) continue
    if (level === 'beat4' && !visibility.showBeat4) continue
    lines.push({
      sec: roundTrackTempoSec(clampTrackTempoNumber(localSec, 0, durationSec)),
      sourceSec: roundTrackTempoSec(clampTrackTempoNumber(sourceSec, 0, sourceDurationSec)),
      level
    })
  }
  return lines
}
