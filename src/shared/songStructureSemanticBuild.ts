import { clamp, clamp01, ramp } from './songStructureCommon'
import { resolveSongStructureBuildRampScore } from './songStructureSpectralClustering'
import type { SongStructureSpectralBarFeature } from './songStructureSpectralFeatures'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'

const CONTEXTUAL_BUILD_BAR_OPTIONS = [16, 8] as const
const MAX_BUILD_START_AFTER_BREAKDOWN_BARS = 8
const MAX_BUILD_REENTRY_AFTER_BREAKDOWN_BARS = 24
const CONTEXTUAL_BUILD_MIN_RAMP = 0.42
const CONTEXTUAL_BUILD_MIN_DROP_ACTIVITY = 0.45
const CONTEXTUAL_BUILD_MIN_FOUNDATION_RECOVERY = 0.08

type NormalizedBuildValues = Pick<
  SongStructureSpectralBarFeature['normalized'],
  'energy' | 'low' | 'mid' | 'high' | 'attackDensity' | 'density'
>

type ContextualBuildCandidate = {
  startIndex: number
  endIndex: number
  rampScore: number
}

const createEmptyValues = (): NormalizedBuildValues => ({
  energy: 0,
  low: 0,
  mid: 0,
  high: 0,
  attackDensity: 0,
  density: 0
})

const averageNormalizedValues = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const result = createEmptyValues()
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const values = bars[index]?.normalized
    if (!values) continue
    result.energy += values.energy / (end - start)
    result.low += values.low / (end - start)
    result.mid += values.mid / (end - start)
    result.high += values.high / (end - start)
    result.attackDensity += values.attackDensity / (end - start)
    result.density += values.density / (end - start)
  }
  return result
}

const toRank = (value: number) => clamp01(value * 0.5 + 0.5)

const resolveBuildActivity = (values: NormalizedBuildValues) =>
  clamp01(
    toRank(values.energy) * 0.2 +
      toRank(values.low) * 0.23 +
      toRank(values.mid) * 0.1 +
      toRank(values.high) * 0.08 +
      toRank(values.attackDensity) * 0.17 +
      toRank(values.density) * 0.22
  )

const resolveBuildFoundation = (values: NormalizedBuildValues) =>
  clamp01(
    toRank(values.energy) * 0.28 +
      toRank(values.low) * 0.28 +
      toRank(values.attackDensity) * 0.18 +
      toRank(values.density) * 0.26
  )

const findBreakdownContext = (
  ranges: readonly SongStructureSemanticRange[],
  buildStartIndex: number,
  reentryIndex: number
) =>
  [...ranges]
    .reverse()
    .find(
      (range) =>
        range.kind === 'breakdown' &&
        range.startIndex <= buildStartIndex &&
        buildStartIndex <= range.endIndex + MAX_BUILD_START_AFTER_BREAKDOWN_BARS &&
        reentryIndex >= range.endIndex &&
        reentryIndex <= range.endIndex + MAX_BUILD_REENTRY_AFTER_BREAKDOWN_BARS
    )

const buildContextualBuildCandidate = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  reentryIndex: number
): ContextualBuildCandidate | null => {
  const reentryBar = bars[reentryIndex]
  if (
    reentryIndex + 4 > bars.length ||
    (!reentryBar?.isPhraseBoundary && !reentryBar?.isClipBoundary)
  ) {
    return null
  }

  const dropValues = averageNormalizedValues(bars, reentryIndex, reentryIndex + 4)
  if (resolveBuildActivity(dropValues) < CONTEXTUAL_BUILD_MIN_DROP_ACTIVITY) return null

  for (const buildBars of CONTEXTUAL_BUILD_BAR_OPTIONS) {
    const startIndex = reentryIndex - buildBars
    if (startIndex < 0 || !findBreakdownContext(ranges, startIndex, reentryIndex)) continue

    const rampScore = resolveSongStructureBuildRampScore(bars, startIndex, reentryIndex)
    if (rampScore < CONTEXTUAL_BUILD_MIN_RAMP) continue

    const buildValues = averageNormalizedValues(bars, startIndex, reentryIndex)
    const foundationRecovery =
      resolveBuildFoundation(dropValues) - resolveBuildFoundation(buildValues)
    if (foundationRecovery < CONTEXTUAL_BUILD_MIN_FOUNDATION_RECOVERY) continue

    return {
      startIndex,
      endIndex: reentryIndex,
      rampScore
    }
  }
  return null
}

const mergeAdjacentRanges = (ranges: readonly SongStructureSemanticRange[]) => {
  const result: SongStructureSemanticRange[] = []
  for (const range of ranges) {
    const previous = result[result.length - 1]
    if (previous?.kind === range.kind && previous.endIndex === range.startIndex) {
      const previousBars = previous.endIndex - previous.startIndex
      const currentBars = range.endIndex - range.startIndex
      previous.confidence =
        (previous.confidence * previousBars + range.confidence * currentBars) /
        Math.max(1, previousBars + currentBars)
      previous.endIndex = range.endIndex
      continue
    }
    result.push({ ...range })
  }
  return result
}

const relabelRangeWindowAsBuild = (
  ranges: readonly SongStructureSemanticRange[],
  candidate: ContextualBuildCandidate
) => {
  const result: SongStructureSemanticRange[] = []
  const buildConfidence = clamp01(
    0.5 + ramp(candidate.rampScore, CONTEXTUAL_BUILD_MIN_RAMP, 0.65) * 0.25
  )
  for (const range of ranges) {
    if (range.endIndex <= candidate.startIndex || range.startIndex >= candidate.endIndex) {
      result.push({ ...range })
      continue
    }
    if (range.startIndex < candidate.startIndex) {
      result.push({
        ...range,
        endIndex: candidate.startIndex
      })
    }
    const buildStart = Math.max(range.startIndex, candidate.startIndex)
    const buildEnd = Math.min(range.endIndex, candidate.endIndex)
    if (buildEnd > buildStart) {
      result.push({
        ...range,
        startIndex: buildStart,
        endIndex: buildEnd,
        kind: 'build',
        confidence: buildConfidence,
        entryBoundaryScore:
          buildStart === candidate.startIndex
            ? Math.max(range.entryBoundaryScore, candidate.rampScore)
            : range.entryBoundaryScore
      })
    }
    if (range.endIndex > candidate.endIndex) {
      result.push({
        ...range,
        startIndex: candidate.endIndex,
        entryBoundaryScore: Math.max(range.entryBoundaryScore, candidate.rampScore)
      })
    }
  }
  return mergeAdjacentRanges(result)
}

export const refineContextualBuildRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  activeReentryIndexes: readonly number[]
) => {
  let result = [...ranges]
  let lastBuildEndIndex = -1
  for (const reentryIndex of [...new Set(activeReentryIndexes)].sort(
    (left, right) => left - right
  )) {
    const candidate = buildContextualBuildCandidate(bars, result, reentryIndex)
    if (!candidate || candidate.startIndex < lastBuildEndIndex) continue
    result = relabelRangeWindowAsBuild(result, candidate)
    lastBuildEndIndex = candidate.endIndex
  }
  return result
}
