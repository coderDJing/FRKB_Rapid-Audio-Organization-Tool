import { clamp, clamp01, ramp } from './songStructureCommon'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  cosineSimilarity,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValueKey
} from './songStructureSpectralFeatures'

const DISCRIMINATIVE_WINDOW_BARS = 4
const SHORT_DISCRIMINATIVE_WINDOW_BARS = 2

const FEATURE_WEIGHTS: Record<SongStructureSpectralValueKey, number> = {
  energy: 0.6,
  low: 0.9,
  mid: 1,
  high: 0.9,
  attack: 0.8,
  attackDensity: 1,
  density: 1,
  brightness: 0.85,
  crest: 0.55,
  lowShare: 0.9,
  midShare: 0.95,
  highShare: 0.95
}

type WindowContrast = {
  feature: number
  local: number
  recurrence: number
  combined: number
}

export type SongStructureDiscriminativeBoundaryEvidence = WindowContrast & {
  score: number
  persistence: number
}

export type SongStructureMotifRange = {
  startIndex: number
  endIndex: number
  clusterId: number
}

const averageVector = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number,
  resolveVector: (bar: SongStructureSpectralBarFeature) => readonly number[]
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const dimensions = end > start ? resolveVector(bars[start]!).length : 0
  const result = new Array(dimensions).fill(0)
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const vector = resolveVector(bars[index]!)
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      result[dimension] += (vector[dimension] ?? 0) / (end - start)
    }
  }
  return result
}

const resolveVectorContrast = (left: readonly number[], right: readonly number[]) =>
  ramp(clamp01((1 - cosineSimilarity(left, right)) / 2), 0.018, 0.34)

const resolveFeatureContrast = (
  bars: readonly SongStructureSpectralBarFeature[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
) => {
  let weightedContrast = 0
  let weightTotal = 0
  for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
    const left = bars.slice(leftStart, leftEnd).map((bar) => bar.normalized[key])
    const right = bars.slice(rightStart, rightEnd).map((bar) => bar.normalized[key])
    if (!left.length || !right.length) continue
    const leftMean = left.reduce((total, value) => total + value, 0) / left.length
    const rightMean = right.reduce((total, value) => total + value, 0) / right.length
    const leftDeviation =
      left.reduce((total, value) => total + Math.abs(value - leftMean), 0) / left.length
    const rightDeviation =
      right.reduce((total, value) => total + Math.abs(value - rightMean), 0) / right.length
    const pooledDeviation = (leftDeviation + rightDeviation) / 2
    const standardizedDifference =
      Math.abs(rightMean - leftMean) / Math.max(0.16, 0.22 + pooledDeviation * 1.35)
    const weight = FEATURE_WEIGHTS[key]
    weightedContrast += ramp(standardizedDifference, 0.18, 1.5) * weight
    weightTotal += weight
  }
  return weightTotal > 0 ? clamp01(weightedContrast / weightTotal) : 0
}

const resolveWindowContrast = (
  bars: readonly SongStructureSpectralBarFeature[],
  index: number,
  radius: number
): WindowContrast => {
  const leftStart = clamp(index - radius, 0, bars.length)
  const leftEnd = clamp(index, leftStart, bars.length)
  const rightStart = clamp(index, 0, bars.length)
  const rightEnd = clamp(index + radius, rightStart, bars.length)
  if (leftEnd <= leftStart || rightEnd <= rightStart) {
    return { feature: 0, local: 0, recurrence: 0, combined: 0 }
  }
  const feature = resolveFeatureContrast(bars, leftStart, leftEnd, rightStart, rightEnd)
  const local = resolveVectorContrast(
    averageVector(bars, leftStart, leftEnd, (bar) => bar.localVector),
    averageVector(bars, rightStart, rightEnd, (bar) => bar.localVector)
  )
  const recurrence = resolveVectorContrast(
    averageVector(bars, leftStart, leftEnd, (bar) => bar.recurrenceVector),
    averageVector(bars, rightStart, rightEnd, (bar) => bar.recurrenceVector)
  )
  return {
    feature,
    local,
    recurrence,
    combined: clamp01(feature * 0.52 + local * 0.25 + recurrence * 0.23)
  }
}

export const resolveSongStructureDiscriminativeBoundaryEvidence = (
  bars: readonly SongStructureSpectralBarFeature[],
  index: number
): SongStructureDiscriminativeBoundaryEvidence => {
  const short = resolveWindowContrast(bars, index, SHORT_DISCRIMINATIVE_WINDOW_BARS)
  const sustained = resolveWindowContrast(bars, index, DISCRIMINATIVE_WINDOW_BARS)
  const persistence = clamp01(
    ramp(sustained.combined, short.combined * 0.48, Math.max(0.12, short.combined * 1.08)) * 0.72 +
      ramp(sustained.feature, 0.12, 0.72) * 0.28
  )
  return {
    feature: sustained.feature,
    local: sustained.local,
    recurrence: sustained.recurrence,
    combined: sustained.combined,
    persistence,
    score: clamp01(
      (short.combined * 0.34 + sustained.combined * 0.66) * (0.68 + persistence * 0.32)
    )
  }
}

const resolveRangeMotifVector = (
  bars: readonly SongStructureSpectralBarFeature[],
  range: SongStructureMotifRange
) => [
  ...averageVector(bars, range.startIndex, range.endIndex, (bar) => bar.recurrenceVector),
  ...averageVector(bars, range.startIndex, range.endIndex, (bar) => bar.localVector).map(
    (value) => value * 0.55
  )
]

export const resolveSongStructureSoftMotifRepetition = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureMotifRange[]
) => {
  const vectors = ranges.map((range) => resolveRangeMotifVector(bars, range))
  return ranges.map((range, index) => {
    const duration = Math.max(1, range.endIndex - range.startIndex)
    let strongest = 0
    let secondStrongest = 0
    for (let candidateIndex = 0; candidateIndex < ranges.length; candidateIndex += 1) {
      if (candidateIndex === index) continue
      const candidate = ranges[candidateIndex]!
      const candidateDuration = Math.max(1, candidate.endIndex - candidate.startIndex)
      const gap = Math.max(
        0,
        Math.max(range.startIndex, candidate.startIndex) -
          Math.min(range.endIndex, candidate.endIndex)
      )
      const separation = gap > 0 ? 1 : 0.42
      const durationCompatibility = Math.sqrt(
        Math.min(duration, candidateDuration) / Math.max(duration, candidateDuration)
      )
      const similarity = clamp01(
        (cosineSimilarity(vectors[index] ?? [], vectors[candidateIndex] ?? []) + 1) / 2
      )
      const clusterSupport = range.clusterId === candidate.clusterId ? 1 : 0.82
      const score =
        ramp(similarity, 0.76, 0.965) *
        (0.62 + durationCompatibility * 0.38) *
        separation *
        clusterSupport
      if (score > strongest) {
        secondStrongest = strongest
        strongest = score
      } else if (score > secondStrongest) {
        secondStrongest = score
      }
    }
    return clamp01(strongest * 0.82 + secondStrongest * 0.18)
  })
}
