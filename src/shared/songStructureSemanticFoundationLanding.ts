import { clamp01 } from './songStructureCommon'
import {
  resolveSongStructureSemanticActivity,
  resolveSongStructureSemanticFoundation
} from './songStructureSemanticActivity'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import type { SongStructureSpectralBoundary } from './songStructureSpectralClustering'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const LANDING_WINDOW_BLOCKS = 4
const MIN_LANDING_BOUNDARY_SCORE = 0.3
const MIN_LANDING_LOW_GAIN = 0.14
const MIN_LANDING_AFTER_LOW = 0.04
const MIN_LANDING_AFTER_ACTIVITY = 0.48
const MIN_LANDING_AFTER_FOUNDATION = 0.5
const MAX_LANDING_HIGH_GAIN = 0.08
const MAX_BUILD_LOOKBACK_BLOCKS = 64
const MAX_DIRECT_BUILD_LOOKBACK_BLOCKS = 32
const MIN_DIRECT_BUILD_BLOCKS = 8
const MIN_TENSION_LOW_DROP = 0.15
const MIN_TENSION_HIGH_GAIN = 0.12
const MIN_CONTEXT_LOW_DEFICIT = 0.25
const MAX_DIRECT_BUILD_ONSET_BACKTRACK_BLOCKS = 3
const DIRECT_BUILD_ONSET_REFERENCE_BLOCKS = 2
const MIN_DIRECT_BUILD_ONSET_LOW_DROP = 0.18
const MIN_DIRECT_BUILD_ONSET_HIGH_GAIN = 0.08
const MAX_DIRECT_BUILD_ONSET_ACTIVITY_GAIN = -0.04
const MIN_DIRECT_BUILD_ONSET_FOUNDATION_DROP = 0.08

type WindowSummary = {
  values: SongStructureSpectralValues
  activity: number
  foundation: number
}

type BoundaryEvidence = {
  boundary: SongStructureSpectralBoundary
  before: WindowSummary
  after: WindowSummary
  lowGain: number
  highGain: number
  activityGain: number
}

const createEmptyValues = (): SongStructureSpectralValues =>
  Object.fromEntries(
    SONG_STRUCTURE_SPECTRAL_VALUE_KEYS.map((key) => [key, 0])
  ) as SongStructureSpectralValues

const summarizeWindow = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
): WindowSummary => {
  const start = Math.max(0, Math.floor(startIndex))
  const end = Math.min(bars.length, Math.ceil(endIndex))
  const values = createEmptyValues()
  if (end <= start) {
    return { values, activity: 0, foundation: 0 }
  }
  for (let index = start; index < end; index += 1) {
    const normalized = bars[index]?.normalized
    if (!normalized) continue
    for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
      values[key] += normalized[key] / (end - start)
    }
  }
  return {
    values,
    activity: resolveSongStructureSemanticActivity(values),
    foundation: resolveSongStructureSemanticFoundation(values)
  }
}

const buildBoundaryEvidence = (
  bars: readonly SongStructureSpectralBarFeature[],
  boundary: SongStructureSpectralBoundary
): BoundaryEvidence | null => {
  if (
    boundary.index < LANDING_WINDOW_BLOCKS ||
    boundary.index + LANDING_WINDOW_BLOCKS > bars.length
  ) {
    return null
  }
  const before = summarizeWindow(bars, boundary.index - LANDING_WINDOW_BLOCKS, boundary.index)
  const after = summarizeWindow(bars, boundary.index, boundary.index + LANDING_WINDOW_BLOCKS)
  return {
    boundary,
    before,
    after,
    lowGain: after.values.low - before.values.low,
    highGain: after.values.high - before.values.high,
    activityGain: after.activity - before.activity
  }
}

const isFoundationLanding = (evidence: BoundaryEvidence) =>
  evidence.boundary.score >= MIN_LANDING_BOUNDARY_SCORE &&
  evidence.lowGain >= MIN_LANDING_LOW_GAIN &&
  evidence.highGain <= MAX_LANDING_HIGH_GAIN &&
  evidence.after.values.low >= MIN_LANDING_AFTER_LOW &&
  evidence.after.activity >= MIN_LANDING_AFTER_ACTIVITY &&
  evidence.after.foundation >= MIN_LANDING_AFTER_FOUNDATION

const isActiveKind = (kind: SongStructureSemanticRange['kind']) =>
  kind === 'drop' || kind === 'groove'

const mergeAdjacentRanges = (ranges: readonly SongStructureSemanticRange[]) => {
  const result: SongStructureSemanticRange[] = []
  for (const range of ranges) {
    const previous = result.at(-1)
    if (previous?.kind === range.kind && previous.endIndex === range.startIndex) {
      const previousBlocks = previous.endIndex - previous.startIndex
      const currentBlocks = range.endIndex - range.startIndex
      previous.confidence =
        (previous.confidence * previousBlocks + range.confidence * currentBlocks) /
        Math.max(1, previousBlocks + currentBlocks)
      previous.endIndex = range.endIndex
      continue
    }
    result.push({ ...range })
  }
  return result
}

const relabelWindow = (
  ranges: readonly SongStructureSemanticRange[],
  startIndex: number,
  endIndex: number,
  kind: SongStructureSemanticRange['kind'],
  confidence: number
) => {
  const result: SongStructureSemanticRange[] = []
  for (const range of ranges) {
    if (range.endIndex <= startIndex || range.startIndex >= endIndex) {
      result.push({ ...range })
      continue
    }
    if (range.startIndex < startIndex) {
      result.push({ ...range, endIndex: startIndex })
    }
    const overlapStart = Math.max(range.startIndex, startIndex)
    const overlapEnd = Math.min(range.endIndex, endIndex)
    if (overlapEnd > overlapStart) {
      result.push({
        ...range,
        startIndex: overlapStart,
        endIndex: overlapEnd,
        kind,
        confidence: Math.max(range.confidence, confidence)
      })
    }
    if (range.endIndex > endIndex) {
      result.push({ ...range, startIndex: endIndex })
    }
  }
  return mergeAdjacentRanges(result)
}

const findDirectBuildBoundary = (evidences: readonly BoundaryEvidence[], landingIndex: number) =>
  evidences
    .filter((evidence) => {
      const distance = landingIndex - evidence.boundary.index
      return (
        distance >= MIN_DIRECT_BUILD_BLOCKS &&
        distance <= MAX_DIRECT_BUILD_LOOKBACK_BLOCKS &&
        evidence.boundary.score >= MIN_LANDING_BOUNDARY_SCORE &&
        evidence.lowGain <= -MIN_TENSION_LOW_DROP &&
        evidence.highGain >= MIN_TENSION_HIGH_GAIN &&
        evidence.activityGain <= -0.04
      )
    })
    .sort((left, right) => {
      const leftScore = left.boundary.score + Math.abs(left.lowGain) * 0.25 + left.highGain * 0.15
      const rightScore =
        right.boundary.score + Math.abs(right.lowGain) * 0.25 + right.highGain * 0.15
      return rightScore - leftScore
    })[0]

const isSustainedDirectBuildOnset = (
  reference: WindowSummary,
  current: WindowSummary,
  next: WindowSummary
) =>
  current.values.low - reference.values.low <= -MIN_DIRECT_BUILD_ONSET_LOW_DROP &&
  next.values.low - reference.values.low <= -MIN_DIRECT_BUILD_ONSET_LOW_DROP &&
  current.values.high - reference.values.high >= MIN_DIRECT_BUILD_ONSET_HIGH_GAIN &&
  next.values.high - reference.values.high >= MIN_DIRECT_BUILD_ONSET_HIGH_GAIN &&
  current.activity - reference.activity <= MAX_DIRECT_BUILD_ONSET_ACTIVITY_GAIN &&
  next.activity - reference.activity <= MAX_DIRECT_BUILD_ONSET_ACTIVITY_GAIN &&
  reference.foundation - current.foundation >= MIN_DIRECT_BUILD_ONSET_FOUNDATION_DROP &&
  reference.foundation - next.foundation >= MIN_DIRECT_BUILD_ONSET_FOUNDATION_DROP

const refineDirectBuildOnset = (
  bars: readonly SongStructureSpectralBarFeature[],
  boundaryIndex: number
) => {
  const scanStart = Math.max(
    DIRECT_BUILD_ONSET_REFERENCE_BLOCKS,
    boundaryIndex - MAX_DIRECT_BUILD_ONSET_BACKTRACK_BLOCKS
  )
  for (let index = scanStart; index <= boundaryIndex; index += 1) {
    if (index + 1 >= bars.length) break
    const reference = summarizeWindow(bars, index - DIRECT_BUILD_ONSET_REFERENCE_BLOCKS, index)
    const current = summarizeWindow(bars, index, index + 1)
    const next = summarizeWindow(bars, index + 1, index + 2)
    if (isSustainedDirectBuildOnset(reference, current, next)) return index
  }
  return boundaryIndex
}

const hasEmbeddedDrop = (
  ranges: readonly SongStructureSemanticRange[],
  buildStart: number,
  landingIndex: number
) =>
  ranges.some((range) => {
    if (range.kind !== 'drop' || range.startIndex >= landingIndex) return false
    const embeddedStart = Math.max(range.startIndex, buildStart)
    const embeddedBlocks = Math.min(range.endIndex, landingIndex) - embeddedStart
    if (embeddedBlocks < 8) return false
    return (
      range.startIndex > buildStart ||
      (range.startIndex === buildStart && range.endIndex <= landingIndex - 8)
    )
  })

const hasLeadingCompletedDrop = (
  ranges: readonly SongStructureSemanticRange[],
  buildStart: number,
  landingIndex: number
) =>
  ranges.some(
    (range) =>
      range.kind === 'drop' &&
      range.startIndex === buildStart &&
      range.endIndex <= landingIndex - 8 &&
      range.endIndex - range.startIndex >= 8
  )

const hasProtectedFullBreakdown = (
  ranges: readonly SongStructureSemanticRange[],
  buildStart: number,
  landingIndex: number
) =>
  ranges.some(
    (range) =>
      range.kind === 'breakdown' &&
      range.startIndex === buildStart &&
      range.endIndex === landingIndex &&
      range.endIndex - range.startIndex >= 8
  )

const findContextualBuildStart = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  landing: BoundaryEvidence,
  landingIndexes: ReadonlySet<number>
) => {
  const candidates = ranges
    .filter(
      (range) =>
        range.kind === 'build' &&
        range.startIndex < landing.boundary.index &&
        landing.boundary.index - range.startIndex <= MAX_BUILD_LOOKBACK_BLOCKS
    )
    .reverse()
  for (const range of candidates) {
    if (
      [...landingIndexes].some((index) => index > range.endIndex && index < landing.boundary.index)
    ) {
      continue
    }
    const hasActiveContinuation = ranges.some(
      (candidate) =>
        isActiveKind(candidate.kind) &&
        candidate.startIndex < landing.boundary.index &&
        candidate.endIndex > range.endIndex
    )
    if (!hasActiveContinuation) continue
    const continuation = summarizeWindow(bars, range.endIndex, landing.boundary.index)
    if (landing.after.values.low - continuation.values.low < MIN_CONTEXT_LOW_DEFICIT) continue
    return range.startIndex
  }
  return undefined
}

const findLeadingBreakdownEnd = (
  evidences: readonly BoundaryEvidence[],
  buildStart: number,
  landingIndex: number
) => {
  const onset = evidences.find((evidence) => evidence.boundary.index === buildStart)
  if (!onset || onset.lowGain > -0.18 || onset.activityGain > -0.12 || onset.highGain > 0.02) {
    return undefined
  }
  return evidences.find((evidence) => {
    const distance = evidence.boundary.index - buildStart
    return (
      distance >= 4 &&
      distance <= 16 &&
      evidence.boundary.index < landingIndex &&
      evidence.boundary.score >= 0.25 &&
      evidence.highGain >= 0.08 &&
      evidence.activityGain >= 0.03
    )
  })?.boundary.index
}

const promoteLandingContinuation = (
  ranges: readonly SongStructureSemanticRange[],
  landingIndex: number,
  confidence: number
) => {
  const containing = ranges.find(
    (range) => range.startIndex <= landingIndex && range.endIndex > landingIndex
  )
  if (!containing || !isActiveKind(containing.kind)) return [...ranges]
  return relabelWindow(ranges, landingIndex, containing.endIndex, 'drop', confidence)
}

export const refineFoundationLandingBuildRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  boundaries: readonly SongStructureSpectralBoundary[],
  protectedRanges: readonly SongStructureSemanticRange[] = ranges
) => {
  const evidences = boundaries.flatMap((boundary) => {
    const evidence = buildBoundaryEvidence(bars, boundary)
    return evidence ? [evidence] : []
  })
  const landings = evidences.filter(isFoundationLanding)
  const landingIndexes = new Set(landings.map((landing) => landing.boundary.index))
  let result = [...ranges]
  for (const landing of landings) {
    const landingIndex = landing.boundary.index
    const landingContinuation = result.find(
      (range) => range.startIndex <= landingIndex && range.endIndex > landingIndex
    )
    if (!landingContinuation || !isActiveKind(landingContinuation.kind)) continue
    const directBuildBoundary = findDirectBuildBoundary(evidences, landingIndex)
    const directBuildStart = directBuildBoundary
      ? refineDirectBuildOnset(bars, directBuildBoundary.boundary.index)
      : undefined
    const contextualBuildStart = findContextualBuildStart(bars, result, landing, landingIndexes)
    const buildStart =
      (directBuildStart !== undefined &&
      !hasEmbeddedDrop(ranges, directBuildStart, landingIndex) &&
      !hasEmbeddedDrop(protectedRanges, directBuildStart, landingIndex) &&
      !hasProtectedFullBreakdown(protectedRanges, directBuildStart, landingIndex)
        ? directBuildStart
        : undefined) ??
      (contextualBuildStart !== undefined &&
      !hasLeadingCompletedDrop(ranges, contextualBuildStart, landingIndex) &&
      !hasLeadingCompletedDrop(protectedRanges, contextualBuildStart, landingIndex)
        ? contextualBuildStart
        : undefined)
    if (buildStart === undefined || landingIndex - buildStart < 4) continue
    const confidence = clamp01(0.56 + landing.boundary.score * 0.22 + landing.lowGain * 0.24)
    result = relabelWindow(result, buildStart, landingIndex, 'build', confidence)
    const protectedLeadingBreakdown = [...ranges, ...protectedRanges].find(
      (range) =>
        range.kind === 'breakdown' &&
        range.startIndex === buildStart &&
        range.endIndex < landingIndex
    )
    const breakdownEnd =
      protectedLeadingBreakdown?.endIndex ??
      findLeadingBreakdownEnd(evidences, buildStart, landingIndex)
    if (breakdownEnd !== undefined) {
      result = relabelWindow(result, buildStart, breakdownEnd, 'breakdown', confidence)
    }
    result = promoteLandingContinuation(result, landingIndex, confidence)
  }
  return mergeAdjacentRanges(result)
}
