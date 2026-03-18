import { resolveTempoRatioByBpm } from '@renderer/composables/mixtape/mixxxSyncModel'
import { resolveTrackTimelineDurationFromSource } from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  BPM_MIN_VALUE,
  BPM_POINT_SEC_EPSILON,
  buildFlatTrackBpmEnvelope,
  normalizeTrackBpmEnvelopePoints,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= BPM_MIN_VALUE) return null
  return Number(numeric.toFixed(4))
}

const resolveTrackStartSec = (track: MixtapeTrack) => {
  const numeric = Number(track.startSec)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return Number(numeric.toFixed(4))
}

export const resolveDefaultGlobalBpmFromTracks = (tracks: MixtapeTrack[]) => {
  for (const track of tracks) {
    const candidates = [track.bpm, track.gridBaseBpm, track.originalBpm]
    for (const candidate of candidates) {
      const normalized = normalizeBpm(candidate)
      if (normalized !== null) return normalized
    }
  }
  return 128
}

export const buildFlatMixtapeGlobalBpmEnvelope = (durationSec: number, bpm: number) =>
  buildFlatTrackBpmEnvelope(durationSec, bpm).map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm)
  }))

export const buildDefaultMixtapeGlobalBpmEnvelopeSnapshot = (params: {
  tracks: MixtapeTrack[]
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
}) => {
  const defaultBpm = resolveDefaultGlobalBpmFromTracks(params.tracks)
  const durationSec = Math.max(
    0,
    ...params.tracks.map((track) => {
      const startSec = Number(track.startSec)
      const safeStartSec = Number.isFinite(startSec) && startSec >= 0 ? startSec : 0
      const trackDurationSec = Math.max(0, Number(params.resolveTrackDurationSeconds(track)) || 0)
      return safeStartSec + trackDurationSec
    })
  )
  return {
    bpmEnvelope: buildFlatMixtapeGlobalBpmEnvelope(durationSec, defaultBpm),
    bpmEnvelopeDurationSec: durationSec
  }
}

export const normalizeMixtapeGlobalBpmEnvelopePoints = (
  value: unknown,
  durationSec: number,
  defaultBpm: number
) =>
  normalizeTrackBpmEnvelopePoints(value, durationSec, defaultBpm).map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm)
  }))

export const sampleMixtapeGlobalBpmAtSec = (
  points: MixtapeBpmPoint[],
  sec: number,
  fallbackBpm: number
) => {
  if (!points.length) return Math.max(BPM_MIN_VALUE, Number(fallbackBpm) || 128)
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= points[0].sec + BPM_POINT_SEC_EPSILON) {
    return Number(points[0].bpm) || fallbackBpm
  }
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]
    const previous = points[index - 1]
    if (safeSec > current.sec + BPM_POINT_SEC_EPSILON) continue
    const span = Math.max(BPM_POINT_SEC_EPSILON, Number(current.sec) - Number(previous.sec))
    const ratio = clampNumber((safeSec - Number(previous.sec)) / span, 0, 1)
    return Number(
      (Number(previous.bpm) + (Number(current.bpm) - Number(previous.bpm)) * ratio).toFixed(4)
    )
  }
  return Number(points[points.length - 1]?.bpm) || fallbackBpm
}

const resolveProjectedTrackDurationFallback = (params: {
  startBpm: number
  sourceDurationSec: number
  originalBpm: number
}) => {
  const startBpm = Number(params.startBpm)
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const originalBpm = Number(params.originalBpm)
  if (!sourceDurationSec) return 0
  if (!Number.isFinite(startBpm) || startBpm <= 0) return sourceDurationSec
  if (!Number.isFinite(originalBpm) || originalBpm <= 0) return sourceDurationSec
  const ratio = resolveTempoRatioByBpm(startBpm, originalBpm)
  if (!Number.isFinite(ratio) || ratio <= BPM_POINT_SEC_EPSILON) return sourceDurationSec
  return sourceDurationSec / ratio
}

const buildProjectedTrackEnvelopePoints = (params: {
  globalPoints: MixtapeBpmPoint[]
  trackStartSec: number
  durationSec: number
  fallbackBpm: number
}) => {
  const startSec = Math.max(0, Number(params.trackStartSec) || 0)
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const endSec = roundTrackTempoSec(startSec + durationSec)
  const points = [
    {
      sec: 0,
      bpm: sampleMixtapeGlobalBpmAtSec(params.globalPoints, startSec, params.fallbackBpm)
    }
  ]
  for (const point of params.globalPoints) {
    const absoluteSec = Number(point.sec)
    if (absoluteSec <= startSec + BPM_POINT_SEC_EPSILON) continue
    if (absoluteSec >= endSec - BPM_POINT_SEC_EPSILON) continue
    points.push({
      sec: roundTrackTempoSec(absoluteSec - startSec),
      bpm: Number(point.bpm)
    })
  }
  points.push({
    sec: roundTrackTempoSec(durationSec),
    bpm: sampleMixtapeGlobalBpmAtSec(params.globalPoints, endSec, params.fallbackBpm)
  })
  return points
}

export const projectMixtapeGlobalBpmEnvelopeToTrack = (params: {
  track: MixtapeTrack
  globalPoints: MixtapeBpmPoint[]
  sourceDurationSec: number
  originalBpm: number
  fallbackBpm: number
}) => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (sourceDurationSec <= BPM_POINT_SEC_EPSILON || params.globalPoints.length < 2) {
    const flatDuration = sourceDurationSec
    return {
      bpmAtStart: Math.max(BPM_MIN_VALUE, Number(params.fallbackBpm) || 128),
      durationSec: flatDuration,
      points: buildFlatTrackBpmEnvelope(flatDuration, params.fallbackBpm)
    }
  }

  const trackStartSec = resolveTrackStartSec(params.track)
  const originalBpm =
    Number.isFinite(Number(params.originalBpm)) && Number(params.originalBpm) > 0
      ? Number(params.originalBpm)
      : Number(params.fallbackBpm) || 128
  const fallbackBpm = Math.max(BPM_MIN_VALUE, Number(params.fallbackBpm) || 128)
  const bpmAtStart = sampleMixtapeGlobalBpmAtSec(params.globalPoints, trackStartSec, fallbackBpm)

  let durationSec = resolveProjectedTrackDurationFallback({
    startBpm: bpmAtStart,
    sourceDurationSec,
    originalBpm
  })

  for (let index = 0; index < 8; index += 1) {
    const rawPoints = buildProjectedTrackEnvelopePoints({
      globalPoints: params.globalPoints,
      trackStartSec,
      durationSec,
      fallbackBpm
    })
    const nextDuration = resolveTrackTimelineDurationFromSource({
      rawPoints,
      sourceDurationSec,
      originalBpm,
      fallbackBpm,
      fallbackDurationSec: durationSec
    })
    if (Math.abs(nextDuration - durationSec) <= 0.0005) {
      durationSec = nextDuration
      break
    }
    durationSec = nextDuration
  }

  const projectedPoints = buildProjectedTrackEnvelopePoints({
    globalPoints: params.globalPoints,
    trackStartSec,
    durationSec,
    fallbackBpm
  })

  return {
    bpmAtStart,
    durationSec,
    points: normalizeTrackBpmEnvelopePoints(projectedPoints, durationSec, bpmAtStart)
  }
}

export const applyMixtapeGlobalTempoTargetsToTracks = (
  tracks: MixtapeTrack[],
  globalPoints: MixtapeBpmPoint[]
) =>
  tracks.map((track) => {
    const fallbackBpm =
      normalizeBpm(track.gridBaseBpm) ??
      normalizeBpm(track.originalBpm) ??
      normalizeBpm(track.bpm) ??
      128
    return {
      ...track,
      bpm: sampleMixtapeGlobalBpmAtSec(globalPoints, resolveTrackStartSec(track), fallbackBpm)
    }
  })

export const resolveMixtapeGlobalBpmVisualRange = (params: {
  tracks: MixtapeTrack[]
  points: MixtapeBpmPoint[]
}) => {
  const values = [
    ...params.points.map((point) => Number(point.bpm)),
    ...params.tracks.flatMap((track) => [
      Number(track.bpm),
      Number(track.gridBaseBpm),
      Number(track.originalBpm)
    ])
  ].filter((value) => Number.isFinite(value) && value > 0)
  if (!values.length) {
    return {
      baseBpm: 128,
      minBpm: 64,
      maxBpm: 192
    }
  }
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const baseBpm = Number((params.points[0]?.bpm || values[0] || 128).toFixed(2))
  return {
    baseBpm,
    minBpm: Math.max(40, Math.floor(minValue * 0.85)),
    maxBpm: Math.max(80, Math.ceil(maxValue * 1.15))
  }
}
