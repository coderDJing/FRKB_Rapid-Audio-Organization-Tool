import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

export const BPM_POINT_SEC_EPSILON = 0.0001
export const BPM_MIN_VALUE = 1
const TRACK_TEMPO_ROUND_FACTOR = 10000

const BPM_MAX_POINTS_PER_SEC = 2
const BPM_CLAMP_MIN_MULTIPLIER = 0.25
const BPM_VISUAL_MAX_MULTIPLIER = 2

export const clampTrackTempoNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const roundTrackTempoSec = (value: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  if (numeric >= 0) {
    return (
      Math.round((numeric + Number.EPSILON) * TRACK_TEMPO_ROUND_FACTOR) / TRACK_TEMPO_ROUND_FACTOR
    )
  }
  return (
    -Math.round((-numeric + Number.EPSILON) * TRACK_TEMPO_ROUND_FACTOR) / TRACK_TEMPO_ROUND_FACTOR
  )
}

const normalizeTrackBpmPointValue = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= BPM_MIN_VALUE) return null
  return Math.max(BPM_MIN_VALUE, Number(numeric.toFixed(4)))
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
          ? roundTrackTempoSec(Number(point.sourceSec))
          : undefined,
      allowOffGrid: point.allowOffGrid === true ? true : undefined
    }))
}

export const normalizeTrackBpmValue = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= BPM_MIN_VALUE) return null
  return Math.max(BPM_MIN_VALUE, Number(numeric.toFixed(4)))
}

export const resolveTrackBpmEnvelopeBaseValue = (
  track: Pick<MixtapeTrack, 'bpm' | 'gridBaseBpm' | 'originalBpm'>
): number => {
  const candidates = [track.bpm, track.gridBaseBpm, track.originalBpm]
  for (const candidate of candidates) {
    const normalized = normalizeTrackBpmValue(candidate)
    if (normalized !== null) return normalized
  }
  return 128
}

export const resolveTrackGridSourceBpm = (
  track: Pick<MixtapeTrack, 'bpm' | 'gridBaseBpm' | 'originalBpm'>
): number => {
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
  const safeBpm = clampTrackTempoNumber(fallbackBaseBpm, clampRange.minBpm, clampRange.maxBpm)
  return [
    { sec: 0, bpm: safeBpm, sourceSec: 0 },
    {
      sec: roundTrackTempoSec(safeDuration),
      bpm: safeBpm
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
        .map((item, index) => {
          const sec = Number((item as any)?.sec)
          const bpm = normalizeTrackBpmPointValue((item as any)?.bpm)
          const sourceSec = Number((item as any)?.sourceSec)
          if (!Number.isFinite(sec) || sec < 0 || bpm === null) return null
          return {
            index,
            sec: roundTrackTempoSec(clampTrackTempoNumber(sec, 0, safeDuration)),
            bpm: clampTrackTempoNumber(bpm, clampRange.minBpm, clampRange.maxBpm),
            sourceSec:
              Number.isFinite(sourceSec) && sourceSec >= 0
                ? roundTrackTempoSec(sourceSec)
                : undefined,
            allowOffGrid: (item as any)?.allowOffGrid === true ? true : undefined
          }
        })
        .filter(Boolean)
    : []

  if (!points.length) {
    return buildFlatTrackBpmEnvelope(safeDuration, fallbackBpm)
  }

  const sortedWithIndex = (points as Array<MixtapeBpmPoint & { index: number }>).sort(
    (left, right) => {
      if (Math.abs(left.sec - right.sec) > BPM_POINT_SEC_EPSILON) return left.sec - right.sec
      return left.index - right.index
    }
  )
  const sorted = sortedWithIndex.map(({ index: _index, ...point }) => point)

  if (sorted[0].sec > BPM_POINT_SEC_EPSILON) {
    sorted.unshift({ sec: 0, bpm: sorted[0].bpm, sourceSec: 0 })
  } else {
    sorted[0].sec = 0
    sorted[0].sourceSec = 0
  }

  const safeDurationRounded = roundTrackTempoSec(safeDuration)
  const last = sorted[sorted.length - 1]
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
        ? roundTrackTempoSec(Number(point.sourceSec))
        : undefined,
    allowOffGrid: point.allowOffGrid === true ? true : undefined
  }))
