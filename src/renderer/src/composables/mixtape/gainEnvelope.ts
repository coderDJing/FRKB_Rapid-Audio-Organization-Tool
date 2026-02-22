import type { MixtapeGainPoint } from '@renderer/composables/mixtape/types'

const MIN_VALID_GAIN = 0.0001
export const MIXTAPE_GAIN_KNOB_MIN_DB = -26
export const MIXTAPE_GAIN_KNOB_MAX_DB = 12

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const linearGainToDb = (gain: number) => 20 * Math.log10(Math.max(MIN_VALID_GAIN, gain))

export const dbToLinearGain = (db: number) => Math.pow(10, db / 20)

export const buildFlatGainEnvelope = (
  durationSec: number,
  gain: number = 1
): MixtapeGainPoint[] => {
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const safeGain = clampNumber(Number(gain) || 1, MIN_VALID_GAIN, 16)
  return [
    { sec: 0, gain: safeGain },
    { sec: safeDuration, gain: safeGain }
  ]
}

export const normalizeGainEnvelopePoints = (
  value: unknown,
  durationSec?: number
): MixtapeGainPoint[] => {
  const points = Array.isArray(value)
    ? value
        .map((item) => {
          const sec = Number((item as any)?.sec)
          const gain = Number((item as any)?.gain)
          if (!Number.isFinite(sec) || sec < 0) return null
          if (!Number.isFinite(gain) || gain <= 0) return null
          return {
            sec: Number(sec.toFixed(4)),
            gain: clampNumber(Number(gain.toFixed(6)), MIN_VALID_GAIN, 16)
          }
        })
        .filter(Boolean)
    : []
  if (!points.length) {
    if (typeof durationSec !== 'number') return []
    return buildFlatGainEnvelope(durationSec)
  }
  points.sort((a, b) => a!.sec - b!.sec)
  const unique: MixtapeGainPoint[] = []
  for (const point of points as MixtapeGainPoint[]) {
    const last = unique[unique.length - 1]
    if (!last || Math.abs(last.sec - point.sec) > 0.0001) {
      unique.push(point)
    } else {
      last.gain = point.gain
    }
  }
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  if (!unique.length) return buildFlatGainEnvelope(safeDuration)
  if (unique[0].sec > 0.0001) {
    unique.unshift({ sec: 0, gain: unique[0].gain })
  } else {
    unique[0].sec = 0
  }
  if (safeDuration > 0) {
    const last = unique[unique.length - 1]
    if (!last || safeDuration - last.sec > 0.0001) {
      unique.push({ sec: safeDuration, gain: last ? last.gain : 1 })
    } else {
      last.sec = safeDuration
    }
  }
  return unique
}

export const sampleGainEnvelopeAtSec = (
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number = 1
) => {
  if (!Array.isArray(points) || points.length === 0) return fallbackGain
  const safeSec = Math.max(0, Number(sec) || 0)
  if (safeSec <= points[0].sec) return points[0].gain
  const last = points[points.length - 1]
  if (safeSec >= last.sec) return last.gain
  let left = 0
  let right = points.length - 1
  while (left <= right) {
    const middle = (left + right) >> 1
    if (points[middle].sec < safeSec) {
      left = middle + 1
    } else {
      right = middle - 1
    }
  }
  const next = points[left] || last
  const prev = points[Math.max(0, left - 1)] || points[0]
  const span = Math.max(0.0001, next.sec - prev.sec)
  const ratio = clampNumber((safeSec - prev.sec) / span, 0, 1)
  return prev.gain + (next.gain - prev.gain) * ratio
}

export const buildGainEnvelopePolyline = (params: {
  points?: MixtapeGainPoint[]
  durationSec: number
  sampleCount: number
  minDb: number
  maxDb: number
}) => {
  const { points, durationSec, sampleCount, minDb, maxDb } = params
  const safeCount = Math.max(2, Math.floor(sampleCount))
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const span = Math.max(0.0001, maxDb - minDb)
  const minAbs = Math.max(0.0001, Math.abs(minDb))
  const maxAbs = Math.max(0.0001, Math.abs(maxDb))
  const hasZeroInRange = minDb < -0.0001 && maxDb > 0.0001
  const segments: string[] = []
  for (let i = 0; i < safeCount; i += 1) {
    const ratio = safeCount > 1 ? i / (safeCount - 1) : 0
    const sec = safeDuration * ratio
    const gain = sampleGainEnvelopeAtSec(points, sec, 1)
    const db = clampNumber(linearGainToDb(gain), minDb, maxDb)
    const x = (ratio * 100).toFixed(3)
    const yValue = hasZeroInRange
      ? db >= 0
        ? 50 - (db / maxAbs) * 50
        : 50 + (Math.abs(db) / minAbs) * 50
      : ((maxDb - db) / span) * 100
    const y = clampNumber(yValue, 0, 100).toFixed(3)
    segments.push(`${x},${y}`)
  }
  return segments.join(' ')
}
