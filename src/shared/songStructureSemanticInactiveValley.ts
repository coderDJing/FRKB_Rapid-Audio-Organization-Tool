import { clamp, clamp01, ramp } from './songStructureCommon'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const REFERENCE_BARS = 8
const WINDOW_BARS = 4
const MIN_VALLEY_BARS = 8
const MAX_VALLEY_BARS = 32
const MIN_REENTRY_BARS = 8
const MIN_INITIAL_FOUNDATION_DROP = 0.06
const MIN_INITIAL_ACTIVITY_DROP = 0.045
const MIN_AVERAGE_FOUNDATION_DROP = 0.04
const MIN_AVERAGE_ACTIVITY_DROP = 0.035
const MIN_INACTIVE_PERSISTENCE = 0.7
const MAX_REENTRY_FOUNDATION_GAP = 0.04
const MAX_REENTRY_ACTIVITY_GAP = 0.04
const MAX_FOUNDATION_LED_REENTRY_ACTIVITY_GAP = 0.05
const MIN_REENTRY_FOUNDATION_GAIN = 0.065
const MIN_REENTRY_ACTIVITY_GAIN = 0.05
const MIN_SECONDARY_REENTRY_GAIN = 0.015
const MIN_GROOVE_SCAN_BARS = 48

type InactiveWindowSummary = {
  activity: number
  foundation: number
}

type InactiveValleyCandidate = {
  startIndex: number
  endIndex: number
  confidence: number
  entryEvidence: number
  reentryEvidence: number
}

const createEmptyValues = (): SongStructureSpectralValues => ({
  energy: 0,
  low: 0,
  mid: 0,
  high: 0,
  attack: 0,
  attackDensity: 0,
  density: 0,
  brightness: 0,
  crest: 0,
  lowShare: 0,
  midShare: 0,
  highShare: 0
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
    result.attack += values.attack / (end - start)
    result.attackDensity += values.attackDensity / (end - start)
    result.density += values.density / (end - start)
    result.brightness += values.brightness / (end - start)
    result.crest += values.crest / (end - start)
    result.lowShare += values.lowShare / (end - start)
    result.midShare += values.midShare / (end - start)
    result.highShare += values.highShare / (end - start)
  }
  return result
}

const toRank = (value: number) => clamp01(value * 0.5 + 0.5)

const resolveActivity = (values: SongStructureSpectralValues) =>
  clamp01(
    toRank(values.energy) * 0.2 +
      toRank(values.low) * 0.23 +
      toRank(values.mid) * 0.1 +
      toRank(values.high) * 0.08 +
      toRank(values.attackDensity) * 0.17 +
      toRank(values.density) * 0.22
  )

const resolveFoundation = (values: SongStructureSpectralValues) =>
  clamp01(
    toRank(values.energy) * 0.28 +
      toRank(values.low) * 0.28 +
      toRank(values.attackDensity) * 0.18 +
      toRank(values.density) * 0.26
  )

const summarizeWindow = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
): InactiveWindowSummary => {
  const values = averageNormalizedValues(bars, startIndex, endIndex)
  return {
    activity: resolveActivity(values),
    foundation: resolveFoundation(values)
  }
}

const isStructuralBoundary = (bars: readonly SongStructureSpectralBarFeature[], index: number) => {
  const bar = bars[index]
  return !!bar && (bar.isPhraseBoundary || bar.isClipBoundary)
}

const resolveInactivePersistence = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number,
  reference: InactiveWindowSummary
) => {
  let inactiveWindows = 0
  let totalWindows = 0
  for (let index = startIndex; index + WINDOW_BARS <= endIndex; index += WINDOW_BARS) {
    const current = summarizeWindow(bars, index, index + WINDOW_BARS)
    if (
      reference.foundation - current.foundation >= 0.025 &&
      reference.activity - current.activity >= 0.02
    ) {
      inactiveWindows += 1
    }
    totalWindows += 1
  }
  return inactiveWindows / Math.max(1, totalWindows)
}

const buildInactiveValleyCandidate = (
  bars: readonly SongStructureSpectralBarFeature[],
  range: SongStructureSemanticRange,
  startIndex: number
): InactiveValleyCandidate | null => {
  const reference = summarizeWindow(bars, startIndex - REFERENCE_BARS, startIndex)
  const initial = summarizeWindow(bars, startIndex, startIndex + WINDOW_BARS)
  const initialFoundationDrop = reference.foundation - initial.foundation
  const initialActivityDrop = reference.activity - initial.activity
  if (
    initialFoundationDrop < MIN_INITIAL_FOUNDATION_DROP ||
    initialActivityDrop < MIN_INITIAL_ACTIVITY_DROP
  ) {
    return null
  }

  const scanEnd = Math.min(range.endIndex - MIN_REENTRY_BARS, startIndex + MAX_VALLEY_BARS)
  for (
    let reentryIndex = startIndex + MIN_VALLEY_BARS;
    reentryIndex <= scanEnd;
    reentryIndex += 1
  ) {
    if (!isStructuralBoundary(bars, reentryIndex)) continue
    const valley = summarizeWindow(bars, startIndex, reentryIndex)
    const averageFoundationDrop = reference.foundation - valley.foundation
    const averageActivityDrop = reference.activity - valley.activity
    if (
      averageFoundationDrop < MIN_AVERAGE_FOUNDATION_DROP ||
      averageActivityDrop < MIN_AVERAGE_ACTIVITY_DROP
    ) {
      continue
    }
    const persistence = resolveInactivePersistence(bars, startIndex, reentryIndex, reference)
    if (persistence < MIN_INACTIVE_PERSISTENCE) continue

    const previous = summarizeWindow(
      bars,
      Math.max(startIndex, reentryIndex - WINDOW_BARS),
      reentryIndex
    )
    const reentry = summarizeWindow(bars, reentryIndex, reentryIndex + WINDOW_BARS)
    const foundationGap = reference.foundation - reentry.foundation
    const activityGap = reference.activity - reentry.activity
    const foundationGain = reentry.foundation - previous.foundation
    const activityGain = reentry.activity - previous.activity
    const hasFoundationReentry =
      foundationGain >= MIN_REENTRY_FOUNDATION_GAIN && activityGain >= MIN_SECONDARY_REENTRY_GAIN
    const hasActivityReentry =
      activityGain >= MIN_REENTRY_ACTIVITY_GAIN && foundationGain >= MIN_SECONDARY_REENTRY_GAIN
    const allowedActivityGap = hasFoundationReentry
      ? MAX_FOUNDATION_LED_REENTRY_ACTIVITY_GAP
      : MAX_REENTRY_ACTIVITY_GAP
    if (
      foundationGap > MAX_REENTRY_FOUNDATION_GAP ||
      activityGap > allowedActivityGap ||
      (!hasFoundationReentry && !hasActivityReentry)
    ) {
      continue
    }

    const entryEvidence = Math.max(initialFoundationDrop, initialActivityDrop)
    const reentryEvidence = Math.max(foundationGain, activityGain)
    return {
      startIndex,
      endIndex: reentryIndex,
      confidence: clamp01(
        0.55 +
          ramp(entryEvidence, 0.06, 0.2) * 0.18 +
          ramp(averageFoundationDrop, 0.04, 0.16) * 0.12 +
          ramp(persistence, 0.7, 1) * 0.08 +
          ramp(reentryEvidence, 0.065, 0.2) * 0.07
      ),
      entryEvidence,
      reentryEvidence
    }
  }
  return null
}

const findInactiveValleyCandidate = (
  bars: readonly SongStructureSpectralBarFeature[],
  range: SongStructureSemanticRange,
  searchStartIndex: number
) => {
  const start = Math.max(range.startIndex + REFERENCE_BARS, searchStartIndex)
  const end = range.endIndex - MIN_VALLEY_BARS - WINDOW_BARS
  for (let index = start; index <= end; index += 1) {
    if (!isStructuralBoundary(bars, index)) continue
    const candidate = buildInactiveValleyCandidate(bars, range, index)
    if (candidate) return candidate
  }
  return null
}

const splitActiveRangeAtInactiveValleys = (
  bars: readonly SongStructureSpectralBarFeature[],
  range: SongStructureSemanticRange
) => {
  const result: SongStructureSemanticRange[] = []
  let cursor = range.startIndex
  let activeKind = range.kind
  let lastReentryEvidence = 0
  while (cursor < range.endIndex) {
    const candidate = findInactiveValleyCandidate(bars, range, cursor + REFERENCE_BARS)
    if (!candidate) break
    if (candidate.startIndex > cursor) {
      result.push({
        ...range,
        startIndex: cursor,
        endIndex: candidate.startIndex,
        kind: activeKind,
        entryBoundaryScore:
          cursor === range.startIndex
            ? range.entryBoundaryScore
            : Math.max(range.entryBoundaryScore, lastReentryEvidence)
      })
    }
    result.push({
      ...range,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      kind: 'breakdown',
      confidence: candidate.confidence,
      entryBoundaryScore: Math.max(range.entryBoundaryScore, candidate.entryEvidence)
    })
    cursor = candidate.endIndex
    activeKind = 'drop'
    lastReentryEvidence = candidate.reentryEvidence
  }
  if (!result.length) return [{ ...range }]
  if (cursor < range.endIndex) {
    result.push({
      ...range,
      startIndex: cursor,
      kind: activeKind,
      entryBoundaryScore: Math.max(range.entryBoundaryScore, lastReentryEvidence)
    })
  }
  return result
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

export const refineInactiveDropValleyRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[]
) =>
  mergeAdjacentRanges(
    ranges.flatMap((range) =>
      range.kind === 'drop' ||
      (range.kind === 'groove' && range.endIndex - range.startIndex >= MIN_GROOVE_SCAN_BARS)
        ? splitActiveRangeAtInactiveValleys(bars, range)
        : [{ ...range }]
    )
  )
