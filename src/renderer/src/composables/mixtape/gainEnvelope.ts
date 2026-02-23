import type { MixtapeEnvelopeParamId, MixtapeGainPoint } from '@renderer/composables/mixtape/types'

const MIN_VALID_GAIN = 0.0001
const MAX_GAIN_DEFAULT = 16

export const MIXTAPE_GAIN_KNOB_MIN_DB = -26
export const MIXTAPE_GAIN_KNOB_MAX_DB = 12
export const MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN = 1
export const MIXTAPE_ENVELOPE_PARAMS: MixtapeEnvelopeParamId[] = [
  'gain',
  'high',
  'mid',
  'low',
  'volume'
]
export const MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM = {
  gain: 'gainEnvelope',
  high: 'highEnvelope',
  mid: 'midEnvelope',
  low: 'lowEnvelope',
  volume: 'volumeEnvelope'
} as const

type EnvelopeParamConfig = {
  minDb: number
  maxDb: number
  minGain: number
  maxGain: number
  defaultGain: number
}

const MIXTAPE_ENVELOPE_PARAM_CONFIG: Record<MixtapeEnvelopeParamId, EnvelopeParamConfig> = {
  gain: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  high: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  mid: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  low: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MAX_GAIN_DEFAULT,
    defaultGain: 1
  },
  volume: {
    minDb: MIXTAPE_GAIN_KNOB_MIN_DB,
    maxDb: MIXTAPE_GAIN_KNOB_MAX_DB,
    minGain: MIN_VALID_GAIN,
    maxGain: MIXTAPE_VOLUME_ENVELOPE_MAX_GAIN,
    defaultGain: 1
  }
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveEnvelopeConfig = (param: MixtapeEnvelopeParamId): EnvelopeParamConfig =>
  MIXTAPE_ENVELOPE_PARAM_CONFIG[param]

export const linearGainToDb = (gain: number) => 20 * Math.log10(Math.max(MIN_VALID_GAIN, gain))

export const dbToLinearGain = (db: number) => Math.pow(10, db / 20)

export const clampMixEnvelopeGain = (param: MixtapeEnvelopeParamId, gain: number) => {
  const config = resolveEnvelopeConfig(param)
  return clampNumber(Number(gain) || config.defaultGain, config.minGain, config.maxGain)
}

export const buildFlatMixEnvelope = (
  param: MixtapeEnvelopeParamId,
  durationSec: number,
  gain?: number
): MixtapeGainPoint[] => {
  const config = resolveEnvelopeConfig(param)
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const safeGain = clampNumber(Number(gain) || config.defaultGain, config.minGain, config.maxGain)
  return [
    { sec: 0, gain: safeGain },
    { sec: safeDuration, gain: safeGain }
  ]
}

export const buildFlatGainEnvelope = (durationSec: number, gain: number = 1): MixtapeGainPoint[] =>
  buildFlatMixEnvelope('gain', durationSec, gain)

export const normalizeMixEnvelopePoints = (
  param: MixtapeEnvelopeParamId,
  value: unknown,
  durationSec?: number
): MixtapeGainPoint[] => {
  const config = resolveEnvelopeConfig(param)
  const points = Array.isArray(value)
    ? value
        .map((item) => {
          const sec = Number((item as any)?.sec)
          const gain = Number((item as any)?.gain)
          if (!Number.isFinite(sec) || sec < 0) return null
          if (!Number.isFinite(gain) || gain <= 0) return null
          return {
            sec: Number(sec.toFixed(4)),
            gain: clampNumber(Number(gain.toFixed(6)), config.minGain, config.maxGain)
          }
        })
        .filter(Boolean)
    : []
  if (!points.length) {
    if (typeof durationSec !== 'number') return []
    return buildFlatMixEnvelope(param, durationSec, config.defaultGain)
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
  if (!unique.length) return buildFlatMixEnvelope(param, safeDuration, config.defaultGain)
  if (unique[0].sec > 0.0001) {
    unique.unshift({ sec: 0, gain: unique[0].gain })
  } else {
    unique[0].sec = 0
  }
  if (safeDuration > 0) {
    const last = unique[unique.length - 1]
    if (!last || safeDuration - last.sec > 0.0001) {
      unique.push({ sec: safeDuration, gain: last ? last.gain : config.defaultGain })
    } else {
      last.sec = safeDuration
    }
  }
  return unique
}

export const normalizeGainEnvelopePoints = (
  value: unknown,
  durationSec?: number
): MixtapeGainPoint[] => normalizeMixEnvelopePoints('gain', value, durationSec)

const sampleEnvelopeAtSec = (
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number
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

export const sampleMixEnvelopeAtSec = (
  param: MixtapeEnvelopeParamId,
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number = 1
) => {
  const config = resolveEnvelopeConfig(param)
  const sampled = sampleEnvelopeAtSec(points, sec, fallbackGain)
  return clampNumber(sampled, config.minGain, config.maxGain)
}

export const sampleGainEnvelopeAtSec = (
  points: MixtapeGainPoint[] | undefined,
  sec: number,
  fallbackGain: number = 1
) => sampleMixEnvelopeAtSec('gain', points, sec, fallbackGain)

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
  const segments: string[] = []
  for (let i = 0; i < safeCount; i += 1) {
    const ratio = safeCount > 1 ? i / (safeCount - 1) : 0
    const sec = safeDuration * ratio
    const gain = sampleGainEnvelopeAtSec(points, sec, 1)
    const y = mapGainToEnvelopeYPercent(gain, minDb, maxDb).toFixed(3)
    const x = (ratio * 100).toFixed(3)
    segments.push(`${x},${y}`)
  }
  return segments.join(' ')
}

export const mapGainToEnvelopeYPercent = (gain: number, minDb: number, maxDb: number) => {
  const span = Math.max(0.0001, maxDb - minDb)
  const minAbs = Math.max(0.0001, Math.abs(minDb))
  const maxAbs = Math.max(0.0001, Math.abs(maxDb))
  const hasZeroInRange = minDb < -0.0001 && maxDb > 0.0001
  const db = clampNumber(linearGainToDb(gain), minDb, maxDb)
  const yValue = hasZeroInRange
    ? db >= 0
      ? 50 - (db / maxAbs) * 50
      : 50 + (Math.abs(db) / minAbs) * 50
    : ((maxDb - db) / span) * 100
  return clampNumber(yValue, 0, 100)
}

export const mapMixEnvelopeGainToYPercent = (param: MixtapeEnvelopeParamId, gain: number) => {
  const config = resolveEnvelopeConfig(param)
  return mapGainToEnvelopeYPercent(
    clampNumber(gain, config.minGain, config.maxGain),
    config.minDb,
    config.maxDb
  )
}

export const mapMixEnvelopeYPercentToGain = (param: MixtapeEnvelopeParamId, yPercent: number) => {
  const config = resolveEnvelopeConfig(param)
  const minDb = config.minDb
  const maxDb = config.maxDb
  const safeY = clampNumber(yPercent, 0, 100)
  const minAbs = Math.max(0.0001, Math.abs(minDb))
  const maxAbs = Math.max(0.0001, Math.abs(maxDb))
  const hasZeroInRange = minDb < -0.0001 && maxDb > 0.0001
  let db = minDb
  if (hasZeroInRange) {
    if (safeY <= 50) {
      db = ((50 - safeY) / 50) * maxAbs
    } else {
      db = -((safeY - 50) / 50) * minAbs
    }
  } else {
    const span = Math.max(0.0001, maxDb - minDb)
    db = maxDb - (safeY / 100) * span
  }
  return clampNumber(dbToLinearGain(db), config.minGain, config.maxGain)
}

export const buildGainEnvelopePolylineByControlPoints = (params: {
  points?: MixtapeGainPoint[]
  durationSec: number
  minDb: number
  maxDb: number
}) => {
  const { points, durationSec, minDb, maxDb } = params
  const safeDuration = Math.max(0, Number(durationSec) || 0)
  const normalized = normalizeGainEnvelopePoints(points, safeDuration)
  if (!normalized.length) return ''
  const segments: string[] = []
  for (const point of normalized) {
    const ratio = safeDuration > 0 ? clampNumber(point.sec / safeDuration, 0, 1) : 0
    const x = (ratio * 100).toFixed(3)
    const y = mapGainToEnvelopeYPercent(point.gain, minDb, maxDb).toFixed(3)
    segments.push(`${x},${y}`)
  }
  if (segments.length === 1) {
    segments.push(segments[0])
  }
  return segments.join(' ')
}

export const buildMixEnvelopePolylineByControlPoints = (params: {
  param: MixtapeEnvelopeParamId
  points?: MixtapeGainPoint[]
  durationSec: number
}) => {
  const { param, points, durationSec } = params
  const config = resolveEnvelopeConfig(param)
  return buildGainEnvelopePolylineByControlPoints({
    points: normalizeMixEnvelopePoints(param, points, durationSec),
    durationSec,
    minDb: config.minDb,
    maxDb: config.maxDb
  })
}
