import { resolveTempoRatioByBpm } from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  buildProjectedMasterGridTempoPoints,
  mapMixtapeMasterGridTimelineSec,
  sampleMixtapeMasterGridBpmAtSec
} from '@renderer/composables/mixtape/mixtapeMasterGrid'
import { resolveTrackTimelineDurationFromSource } from '@renderer/composables/mixtape/trackTimeMapCore'
import {
  BPM_MIN_VALUE,
  BPM_POINT_SEC_EPSILON,
  buildFlatTrackBpmEnvelope,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackBpmEnvelopeClampRange,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= BPM_MIN_VALUE) return null
  return Number(numeric.toFixed(4))
}

const roundGlobalBpm = (value: number) => Math.max(BPM_MIN_VALUE, Math.round(Number(value) || 0))

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
      if (normalized !== null) return roundGlobalBpm(normalized)
    }
  }
  return 128
}

export const buildFlatMixtapeGlobalBpmEnvelope = (durationSec: number, bpm: number) =>
  buildFlatTrackBpmEnvelope(durationSec, roundGlobalBpm(bpm)).map((point) => ({
    sec: Number(point.sec),
    bpm: roundGlobalBpm(Number(point.bpm))
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
) => {
  const normalizedPoints = normalizeTrackBpmEnvelopePoints(
    value,
    durationSec,
    roundGlobalBpm(defaultBpm)
  ).map((point) => ({
    sec: Number(point.sec),
    bpm: roundGlobalBpm(Number(point.bpm))
  }))

  if (
    normalizedPoints.length >= 2 &&
    normalizedPoints.every((point) => point.bpm === normalizedPoints[0]?.bpm)
  ) {
    return buildFlatMixtapeGlobalBpmEnvelope(
      durationSec,
      normalizedPoints[0]?.bpm ?? roundGlobalBpm(defaultBpm)
    )
  }

  return normalizedPoints
}

export const sampleMixtapeGlobalBpmAtSec = (
  points: MixtapeBpmPoint[],
  sec: number,
  fallbackBpm: number
) => sampleMixtapeMasterGridBpmAtSec(points, sec, fallbackBpm)

export const mapMixtapeGlobalTimelineSec = (params: {
  fromPoints: MixtapeBpmPoint[]
  toPoints: MixtapeBpmPoint[]
  sec: number
  fromFallbackBpm: number
  toFallbackBpm: number
}) => mapMixtapeMasterGridTimelineSec(params)

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
  points: MixtapeBpmPoint[]
  trackStartSec: number
  durationSec: number
  fallbackBpm: number
}) => buildProjectedMasterGridTempoPoints(params)

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
      points: params.globalPoints,
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
    points: params.globalPoints,
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
  const baseBpm = resolveDefaultGlobalBpmFromTracks(params.tracks)
  const clampRange = resolveTrackBpmEnvelopeClampRange(baseBpm)
  return {
    baseBpm,
    minBpm: clampRange.minBpm,
    maxBpm: clampRange.maxBpm
  }
}
