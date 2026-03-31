import {
  buildTempoRatioIntegralCache,
  buildTrackVisibleGridLines,
  resolveTrackBpmEnvelopeRenderablePoints,
  resolveTrackLocalSecAtSourceTime,
  resolveTrackSourceTimeAtLocalSec,
  sampleTrackBpmEnvelopeAtSec,
  type TrackTimeMap,
  type TrackTimeMapInput,
  type TrackVisibleGridLine
} from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  buildTrackVisibleGridLinesOnMasterGrid,
  createMixtapeMasterGrid,
  mapTrackLocalToSourceOnMasterGrid,
  mapTrackSourceToLocalOnMasterGrid
} from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { SerializedTrackTempoSnapshot } from '@renderer/composables/mixtape/types'

const TRACK_TIME_MAP_SNAPSHOT_CACHE_LIMIT = 180
const trackTimeMapSnapshotCache = new Map<string, TrackTimeMap>()

const buildSerializedTrackTimeMapCacheKey = (snapshot: SerializedTrackTempoSnapshot) =>
  [
    String(snapshot.signature || ''),
    Math.round((Number(snapshot.sourceDurationSec) || 0) * 1000),
    Math.round((Number(snapshot.firstBeatSourceSec) || 0) * 1000),
    Math.round((Number(snapshot.beatSourceSec) || 0) * 1000),
    Math.round((Number(snapshot.barBeatOffset) || 0) * 1000),
    Math.round((Number(snapshot.masterGridPhaseOffsetSec) || 0) * 1000)
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

const createFilterLinesByRange = (
  durationSec: number,
  linesFactory: (zoom: number) => TrackVisibleGridLine[]
) => {
  return (
    zoom: number,
    range?: { minLocalSec?: number; maxLocalSec?: number }
  ): TrackVisibleGridLine[] => {
    const minLocalSec = clampTrackTempoNumber(Number(range?.minLocalSec) || 0, 0, durationSec)
    const maxLocalSec = clampTrackTempoNumber(
      Number.isFinite(Number(range?.maxLocalSec)) ? Number(range?.maxLocalSec) : durationSec,
      minLocalSec,
      durationSec
    )
    return linesFactory(zoom).filter(
      (line) =>
        line.sec >= minLocalSec - BPM_POINT_SEC_EPSILON &&
        line.sec <= maxLocalSec + BPM_POINT_SEC_EPSILON
    )
  }
}

const createGridResolvers = (params: {
  durationSec: number
  buildLines: (zoom: number) => TrackVisibleGridLine[]
}) => {
  const filterLinesByRange = createFilterLinesByRange(params.durationSec, params.buildLines)
  return {
    buildSnapCandidates: (zoom: number) => params.buildLines(zoom).map((line) => line.sec),
    resolveNearestGridLine: (
      localSec: number,
      zoom: number,
      range?: { minLocalSec?: number; maxLocalSec?: number }
    ) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, params.durationSec)
      const visibleGridLines = filterLinesByRange(zoom, range)
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
    snapLocalSec: (
      localSec: number,
      zoom: number,
      range?: { minLocalSec?: number; maxLocalSec?: number }
    ) => {
      const safeLocalSec = clampTrackTempoNumber(Number(localSec) || 0, 0, params.durationSec)
      if (safeLocalSec <= BPM_POINT_SEC_EPSILON) return 0
      if (safeLocalSec >= params.durationSec - BPM_POINT_SEC_EPSILON) {
        return roundTrackTempoSec(params.durationSec)
      }
      const visibleGridLines = filterLinesByRange(zoom, range)
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

const createLegacyTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
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
      fallbackBpm: input.fallbackBpm
    })
  const gridResolvers = createGridResolvers({ durationSec, buildLines })

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
    buildSnapCandidates: gridResolvers.buildSnapCandidates,
    resolveNearestGridLine: gridResolvers.resolveNearestGridLine,
    snapLocalSec: gridResolvers.snapLocalSec
  }
}

const createMasterGridTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  const durationSec = Math.max(0, Number(input.durationSec) || 0)
  const sourceDurationSec = Math.max(0, Number(input.sourceDurationSec) || 0)
  const firstBeatSourceSec = Math.max(0, Number(input.firstBeatSourceSec) || 0)
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, Number(input.beatSourceSec) || 0)
  const barBeatOffset = Number(input.barBeatOffset) || 0
  const trackStartSec = Math.max(0, Number(input.trackStartSec) || 0)
  const masterGrid = createMixtapeMasterGrid({
    points: input.masterGridPoints || [],
    phaseOffsetSec: input.masterGridPhaseOffsetSec,
    fallbackBpm: Number(input.masterGridFallbackBpm) || Number(input.fallbackBpm) || 128
  })
  const renderPoints = input.controlPoints.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm),
    sourceSec:
      Number.isFinite(Number(point.sourceSec)) && Number(point.sourceSec) >= 0
        ? Number(point.sourceSec)
        : undefined,
    allowOffGrid: point.allowOffGrid === true ? true : undefined
  }))
  const buildLines = (zoom: number) =>
    buildTrackVisibleGridLinesOnMasterGrid({
      grid: masterGrid,
      trackStartSec,
      durationSec,
      sourceDurationSec,
      firstBeatSourceSec,
      beatSourceSec,
      barBeatOffset,
      zoom
    })
  const gridResolvers = createGridResolvers({ durationSec, buildLines })

  return {
    controlPoints: renderPoints,
    renderPoints,
    durationSec,
    sourceDurationSec,
    firstBeatSourceSec,
    beatSourceSec,
    barBeatOffset,
    mapLocalToSource: (localSec: number) =>
      mapTrackLocalToSourceOnMasterGrid({
        grid: masterGrid,
        trackStartSec,
        localSec,
        sourceDurationSec,
        beatSourceSec,
        durationSec
      }),
    mapSourceToLocal: (sourceSec: number) =>
      mapTrackSourceToLocalOnMasterGrid({
        grid: masterGrid,
        trackStartSec,
        sourceSec,
        sourceDurationSec,
        beatSourceSec,
        durationSec
      }),
    sampleBpmAtLocal: (localSec: number) =>
      masterGrid.sampleBpmAtSec(trackStartSec + Number(localSec || 0)),
    sampleBpmAtSource: (sourceSec: number) =>
      masterGrid.sampleBpmAtSec(
        trackStartSec +
          mapTrackSourceToLocalOnMasterGrid({
            grid: masterGrid,
            trackStartSec,
            sourceSec,
            sourceDurationSec,
            beatSourceSec,
            durationSec
          })
      ),
    buildVisibleGridLines: (zoom: number) => buildLines(zoom),
    buildSnapCandidates: gridResolvers.buildSnapCandidates,
    resolveNearestGridLine: gridResolvers.resolveNearestGridLine,
    snapLocalSec: gridResolvers.snapLocalSec
  }
}

export const createTrackTimeMap = (input: TrackTimeMapInput): TrackTimeMap => {
  const shouldUseMasterGrid =
    input.mappingMode === 'masterGrid' &&
    Array.isArray(input.masterGridPoints) &&
    input.masterGridPoints.length >= 2
  return shouldUseMasterGrid ? createMasterGridTrackTimeMap(input) : createLegacyTrackTimeMap(input)
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
    mappingMode: snapshot.mappingMode,
    trackStartSec: Number(snapshot.trackStartSec) || 0,
    masterGridFallbackBpm:
      Number(snapshot.masterGridFallbackBpm) || Number(snapshot.baseBpm) || 128,
    masterGridPhaseOffsetSec: Number(snapshot.masterGridPhaseOffsetSec) || 0,
    masterGridPoints: Array.isArray(snapshot.masterGridPoints)
      ? snapshot.masterGridPoints.map((point) => ({
          sec: Number(point.sec),
          bpm: Number(point.bpm)
        }))
      : undefined
  })
  writeTrackTimeMapSnapshotCache(cacheKey, next)
  return next
}
