import { clamp01 } from './songStructureCommon'
import type { SongStructureSpectralValues } from './songStructureSpectralFeatures'

type SemanticActivityScores = {
  groove: number
  breakdown: number
  drop: number
  outro: number
}

export type SongStructureSemanticActivitySegment = {
  normalized: SongStructureSpectralValues
  entryRise: number
  entryTimbre: number
  scores: SemanticActivityScores
}

const toRank = (value: number) => clamp01(value * 0.5 + 0.5)

export const positiveSongStructureActivityDifference = (
  current: SongStructureSpectralValues,
  previous: SongStructureSpectralValues
) =>
  clamp01(
    Math.max(0, current.energy - previous.energy) * 0.2 +
      Math.max(0, current.low - previous.low) * 0.22 +
      Math.max(0, current.mid - previous.mid) * 0.14 +
      Math.max(0, current.high - previous.high) * 0.12 +
      Math.max(0, current.attackDensity - previous.attackDensity) * 0.14 +
      Math.max(0, current.density - previous.density) * 0.18
  )

export const resolveSongStructureSemanticActivity = (values: SongStructureSpectralValues) =>
  clamp01(
    toRank(values.energy) * 0.2 +
      toRank(values.low) * 0.23 +
      toRank(values.mid) * 0.1 +
      toRank(values.high) * 0.08 +
      toRank(values.attackDensity) * 0.17 +
      toRank(values.density) * 0.22
  )

export const resolveSongStructureSemanticFoundation = (values: SongStructureSpectralValues) =>
  clamp01(
    toRank(values.energy) * 0.28 +
      toRank(values.low) * 0.28 +
      toRank(values.attackDensity) * 0.18 +
      toRank(values.density) * 0.26
  )

export const resolveActiveSemanticScore = (segment: SongStructureSemanticActivitySegment) =>
  Math.max(segment.scores.drop, segment.scores.groove)

export const resolveInactiveSemanticScore = (segment: SongStructureSemanticActivitySegment) =>
  Math.max(segment.scores.breakdown, segment.scores.outro)

export const isDecisiveActiveReentry = (
  previous: SongStructureSemanticActivitySegment,
  current: SongStructureSemanticActivitySegment
) => {
  const previousActivity = resolveSongStructureSemanticActivity(previous.normalized)
  const currentActivity = resolveSongStructureSemanticActivity(current.normalized)
  const componentRise = positiveSongStructureActivityDifference(
    current.normalized,
    previous.normalized
  )
  const activeDominates =
    resolveActiveSemanticScore(current) >= resolveInactiveSemanticScore(current) - 0.015
  const entryEvidence =
    current.entryRise >= 0.085 ||
    currentActivity - previousActivity >= 0.075 ||
    componentRise >= 0.08 ||
    (current.entryTimbre >= 0.3 && currentActivity - previousActivity >= 0.035)
  const strongWaveformLanding =
    current.entryRise >= 0.22 && currentActivity >= 0.36 && componentRise >= 0.06
  return activeDominates && ((currentActivity >= 0.45 && entryEvidence) || strongWaveformLanding)
}
