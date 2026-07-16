import { clamp, clamp01 } from './songStructureCommon'
import { resolveSongStructureSemanticActivity } from './songStructureSemanticActivity'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import {
  resolveSongStructureBuildRampScore,
  type SongStructureSpectralBoundary
} from './songStructureSpectralClustering'
import type { SongStructureSpectralBarFeature } from './songStructureSpectralFeatures'

const MIN_REENTRY_PREFIX_BARS = 8
const MIN_REENTRY_DROP_BARS = 16
const MIN_REENTRY_BOUNDARY_SCORE = 0.5
const MIN_REENTRY_ACTIVITY_GAIN = 0.055
const REENTRY_ACTIVITY_WINDOW_BARS = 8
const STRUCTURAL_BUILD_MIN_RAMP = 0.3
const STRUCTURAL_BUILD_BAR_OPTIONS = [16, 8] as const

const averageActivity = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  if (end <= start) return 0
  let total = 0
  for (let index = start; index < end; index += 1) {
    const bar = bars[index]
    if (bar) total += resolveSongStructureSemanticActivity(bar.normalized)
  }
  return total / Math.max(1, end - start)
}

const findStructuralReentry = (
  bars: readonly SongStructureSpectralBarFeature[],
  boundaries: readonly SongStructureSpectralBoundary[],
  range: SongStructureSemanticRange
) =>
  boundaries
    .filter(
      (boundary) =>
        boundary.index >= range.startIndex + MIN_REENTRY_PREFIX_BARS &&
        boundary.index <= range.endIndex - MIN_REENTRY_DROP_BARS &&
        boundary.score >= MIN_REENTRY_BOUNDARY_SCORE
    )
    .map((boundary) => {
      const beforeActivity = averageActivity(
        bars,
        boundary.index - REENTRY_ACTIVITY_WINDOW_BARS,
        boundary.index
      )
      const afterActivity = averageActivity(
        bars,
        boundary.index,
        boundary.index + REENTRY_ACTIVITY_WINDOW_BARS
      )
      return { boundary, activityGain: afterActivity - beforeActivity }
    })
    .filter((candidate) => candidate.activityGain >= MIN_REENTRY_ACTIVITY_GAIN)
    .sort(
      (left, right) =>
        right.activityGain +
        right.boundary.score * 0.25 -
        (left.activityGain + left.boundary.score * 0.25)
    )[0]

const findBuildStart = (
  bars: readonly SongStructureSpectralBarFeature[],
  rangeStartIndex: number,
  reentryIndex: number
) => {
  for (const buildBars of STRUCTURAL_BUILD_BAR_OPTIONS) {
    const startIndex = reentryIndex - buildBars
    if (startIndex < rangeStartIndex) continue
    if (
      resolveSongStructureBuildRampScore(bars, startIndex, reentryIndex) >=
      STRUCTURAL_BUILD_MIN_RAMP
    ) {
      return startIndex
    }
  }
  return reentryIndex
}

export const refinePostBreakdownStructuralReentries = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  boundaries: readonly SongStructureSpectralBoundary[]
) => {
  const result: SongStructureSemanticRange[] = []
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]
    const previous = ranges[index - 1]
    if (!range || range.kind !== 'groove' || previous?.kind !== 'breakdown') {
      if (range) result.push({ ...range })
      continue
    }
    const reentry = findStructuralReentry(bars, boundaries, range)
    if (!reentry) {
      result.push({ ...range })
      continue
    }
    const reentryIndex = reentry.boundary.index
    const buildStartIndex = findBuildStart(bars, range.startIndex, reentryIndex)
    if (buildStartIndex > range.startIndex) {
      result.push({ ...range, endIndex: buildStartIndex, kind: 'breakdown' })
    }
    if (buildStartIndex < reentryIndex) {
      result.push({
        ...range,
        startIndex: buildStartIndex,
        endIndex: reentryIndex,
        kind: 'build',
        confidence: clamp01(0.52 + reentry.activityGain * 0.8)
      })
    }
    result.push({
      ...range,
      startIndex: reentryIndex,
      kind: 'drop',
      confidence: Math.max(range.confidence, clamp01(0.56 + reentry.activityGain * 0.9)),
      entryBoundaryScore: Math.max(range.entryBoundaryScore, reentry.boundary.score)
    })
  }
  return result
}
