import { clamp, clamp01, ramp } from './songStructureCommon'
import type { SongStructureSpectralBoundary } from './songStructureSpectralClustering'
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
const MIN_STRUCTURAL_REENTRY_BOUNDARY_SCORE = 0.34
const MAX_STRUCTURAL_REENTRY_FOUNDATION_GAP = 0.07
const MAX_STRUCTURAL_REENTRY_ACTIVITY_GAP = 0.07
const MIN_INITIAL_DROP_BOUNDARY_SCORE = 0.72
const MIN_INITIAL_DROP_ACTIVITY = 0.57
const MIN_INITIAL_DROP_ACTIVITY_GAIN = 0.07
const MIN_INITIAL_DROP_BARS = 8
const MIN_DIRECT_INITIAL_DROP_BARS = 32
const MIN_DIRECT_INITIAL_DROP_ACTIVITY = 0.42
const MIN_DIRECT_INITIAL_DROP_ACTIVITY_GAIN = 0.15
const MIN_LONG_POST_BREAK_DROP_BARS = 24
const MIN_LONG_POST_BREAK_ACTIVITY = 0.56
const MIN_LONG_POST_BREAK_BOUNDARY_SCORE = 0.28
const MIN_TERMINAL_DROP_BARS = 24
const MAX_TERMINAL_CONTINUATION_GROOVE_BARS = 16
const MAX_TERMINAL_CONTINUATION_ACTIVITY_GAIN = 0.035
const MAX_TERMINAL_CONTINUATION_FOUNDATION_GAIN = 0.035

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

const isStructuralBoundary = (
  bars: readonly SongStructureSpectralBarFeature[],
  index: number,
  spectralBoundaryIndexes: ReadonlySet<number>,
  allowSpectralBoundary: boolean
) => {
  const bar = bars[index]
  return (
    !!bar &&
    (bar.isPhraseBoundary ||
      bar.isClipBoundary ||
      (allowSpectralBoundary && spectralBoundaryIndexes.has(index)))
  )
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
  startIndex: number,
  spectralBoundaryIndexes: ReadonlySet<number>,
  allowSpectralBoundary = false
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
    if (!isStructuralBoundary(bars, reentryIndex, spectralBoundaryIndexes, allowSpectralBoundary)) {
      continue
    }
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
  searchStartIndex: number,
  spectralBoundaryIndexes: ReadonlySet<number>
) => {
  const start = Math.max(range.startIndex + REFERENCE_BARS, searchStartIndex)
  const end = range.endIndex - MIN_VALLEY_BARS - WINDOW_BARS
  for (let index = start; index <= end; index += 1) {
    if (!isStructuralBoundary(bars, index, spectralBoundaryIndexes, false)) continue
    const candidate = buildInactiveValleyCandidate(bars, range, index, spectralBoundaryIndexes)
    if (candidate) return candidate
  }
  return null
}

const splitActiveRangeAtInactiveValleys = (
  bars: readonly SongStructureSpectralBarFeature[],
  range: SongStructureSemanticRange,
  spectralBoundaryIndexes: ReadonlySet<number>,
  leadingCandidate?: InactiveValleyCandidate | null
) => {
  const result: SongStructureSemanticRange[] = []
  let cursor = range.startIndex
  let activeKind = range.kind
  let lastReentryEvidence = 0
  while (cursor < range.endIndex) {
    const candidate =
      cursor === range.startIndex && leadingCandidate
        ? leadingCandidate
        : findInactiveValleyCandidate(bars, range, cursor + REFERENCE_BARS, spectralBoundaryIndexes)
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

const findInactiveFamilyStart = (
  ranges: readonly SongStructureSemanticRange[],
  activeIndex: number
) => {
  let index = activeIndex - 1
  let hasBreakdown = false
  while (index >= 0) {
    const kind = ranges[index]?.kind
    if (kind === 'breakdown') {
      hasBreakdown = true
      index -= 1
      continue
    }
    if (kind === 'build') {
      index -= 1
      continue
    }
    break
  }
  return hasBreakdown ? index + 1 : null
}

const promoteStructuralDropReentries = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[]
) =>
  ranges.map((range, index) => {
    if (range.kind !== 'groove' || range.endIndex - range.startIndex < MIN_REENTRY_BARS) {
      return { ...range }
    }
    if (range.entryBoundaryScore < MIN_STRUCTURAL_REENTRY_BOUNDARY_SCORE) return { ...range }

    const inactiveStart = findInactiveFamilyStart(ranges, index)
    if (inactiveStart === null || inactiveStart <= 0) return { ...range }
    const anchor = ranges[inactiveStart - 1]
    if (!anchor || (anchor.kind !== 'drop' && anchor.kind !== 'groove')) return { ...range }

    const inactiveBars = range.startIndex - ranges[inactiveStart]!.startIndex
    if (inactiveBars < MIN_VALLEY_BARS) return { ...range }
    const reference = summarizeWindow(
      bars,
      Math.max(anchor.startIndex, anchor.endIndex - REFERENCE_BARS),
      anchor.endIndex
    )
    const inactiveTail = summarizeWindow(
      bars,
      Math.max(ranges[inactiveStart]!.startIndex, range.startIndex - WINDOW_BARS),
      range.startIndex
    )
    const reentry = summarizeWindow(bars, range.startIndex, range.startIndex + WINDOW_BARS)
    const foundationDrop = reference.foundation - inactiveTail.foundation
    const activityDrop = reference.activity - inactiveTail.activity
    const foundationGain = reentry.foundation - inactiveTail.foundation
    const activityGain = reentry.activity - inactiveTail.activity
    const foundationGap = reference.foundation - reentry.foundation
    const activityGap = reference.activity - reentry.activity
    const hasClearReturn =
      (foundationGain >= MIN_REENTRY_FOUNDATION_GAIN &&
        activityGain >= MIN_SECONDARY_REENTRY_GAIN) ||
      (activityGain >= MIN_REENTRY_ACTIVITY_GAIN && foundationGain >= MIN_SECONDARY_REENTRY_GAIN)
    const hasLongPostBreakPlateau =
      range.endIndex - range.startIndex >= MIN_LONG_POST_BREAK_DROP_BARS &&
      range.entryBoundaryScore >= MIN_LONG_POST_BREAK_BOUNDARY_SCORE &&
      reentry.activity >= MIN_LONG_POST_BREAK_ACTIVITY &&
      foundationGap <= MAX_STRUCTURAL_REENTRY_FOUNDATION_GAP &&
      activityGap <= MAX_STRUCTURAL_REENTRY_ACTIVITY_GAP &&
      (foundationGain >= MIN_SECONDARY_REENTRY_GAIN || activityGain >= MIN_SECONDARY_REENTRY_GAIN)
    if (
      !hasLongPostBreakPlateau &&
      (foundationDrop < MIN_AVERAGE_FOUNDATION_DROP ||
        activityDrop < MIN_AVERAGE_ACTIVITY_DROP ||
        foundationGap > MAX_STRUCTURAL_REENTRY_FOUNDATION_GAP ||
        activityGap > MAX_STRUCTURAL_REENTRY_ACTIVITY_GAP ||
        !hasClearReturn)
    ) {
      return { ...range }
    }

    return {
      ...range,
      kind: 'drop' as const,
      confidence: Math.max(
        range.confidence,
        clamp01(0.58 + ramp(Math.max(foundationGain, activityGain), 0.05, 0.2) * 0.2)
      )
    }
  })

const splitInitialGrooveAtStructuralDrop = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  spectralBoundaries: readonly SongStructureSpectralBoundary[]
) => {
  const result: SongStructureSemanticRange[] = []
  let hasDrop = false
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    const range = ranges[rangeIndex]
    if (!range) continue
    const previous = ranges[rangeIndex - 1]
    const next = ranges[rangeIndex + 1]
    if (range.kind === 'drop') hasDrop = true
    const isDirectInitialDrop =
      !hasDrop &&
      range.kind === 'groove' &&
      previous?.kind === 'intro' &&
      next?.kind === 'breakdown' &&
      range.endIndex - range.startIndex >= MIN_DIRECT_INITIAL_DROP_BARS &&
      range.entryBoundaryScore >= MIN_INITIAL_DROP_BOUNDARY_SCORE
    if (isDirectInitialDrop) {
      const before = summarizeWindow(
        bars,
        Math.max(previous.startIndex, range.startIndex - WINDOW_BARS),
        range.startIndex
      )
      const entry = summarizeWindow(bars, range.startIndex, range.startIndex + WINDOW_BARS)
      if (
        entry.activity >= MIN_DIRECT_INITIAL_DROP_ACTIVITY &&
        entry.activity - before.activity >= MIN_DIRECT_INITIAL_DROP_ACTIVITY_GAIN
      ) {
        result.push({
          ...range,
          kind: 'drop',
          confidence: Math.max(
            range.confidence,
            clamp01(0.58 + ramp(entry.activity - before.activity, 0.15, 0.35) * 0.2)
          )
        })
        hasDrop = true
        continue
      }
    }
    const canResolveInitialDrop =
      !hasDrop &&
      range.kind === 'groove' &&
      next?.kind === 'breakdown' &&
      range.endIndex - range.startIndex >= MIN_INITIAL_DROP_BARS * 2
    if (!canResolveInitialDrop) {
      result.push({ ...range })
      continue
    }

    const candidate = spectralBoundaries.find((boundary) => {
      if (
        boundary.index <= range.startIndex ||
        boundary.index + MIN_INITIAL_DROP_BARS > range.endIndex
      ) {
        return false
      }
      if (boundary.score < MIN_INITIAL_DROP_BOUNDARY_SCORE) return false
      const before = summarizeWindow(bars, boundary.index - WINDOW_BARS, boundary.index)
      const after = summarizeWindow(bars, boundary.index, boundary.index + WINDOW_BARS)
      return (
        after.activity >= MIN_INITIAL_DROP_ACTIVITY &&
        after.activity - before.activity >= MIN_INITIAL_DROP_ACTIVITY_GAIN
      )
    })
    if (!candidate) {
      result.push({ ...range })
      continue
    }

    result.push({ ...range, endIndex: candidate.index })
    result.push({
      ...range,
      startIndex: candidate.index,
      kind: 'drop',
      confidence: Math.max(range.confidence, clamp01(0.6 + candidate.score * 0.2)),
      entryBoundaryScore: Math.max(range.entryBoundaryScore, candidate.score)
    })
    hasDrop = true
  }
  return result
}

const mergeTerminalDropContinuationGroove = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[]
) => {
  const result: SongStructureSemanticRange[] = []
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]
    if (!range) continue
    const previous = result.at(-1)
    const next = ranges[index + 1]
    const isTerminalContinuation =
      previous?.kind === 'drop' &&
      next?.kind === 'outro' &&
      previous.endIndex - previous.startIndex >= MIN_TERMINAL_DROP_BARS &&
      range.kind === 'groove' &&
      range.endIndex - range.startIndex <= MAX_TERMINAL_CONTINUATION_GROOVE_BARS
    if (!isTerminalContinuation || !previous) {
      result.push({ ...range })
      continue
    }
    const dropTail = summarizeWindow(
      bars,
      Math.max(previous.startIndex, previous.endIndex - WINDOW_BARS),
      previous.endIndex
    )
    const continuation = summarizeWindow(
      bars,
      range.startIndex,
      Math.min(range.endIndex, range.startIndex + WINDOW_BARS)
    )
    const hasIndependentReentry =
      continuation.activity - dropTail.activity > MAX_TERMINAL_CONTINUATION_ACTIVITY_GAIN ||
      continuation.foundation - dropTail.foundation > MAX_TERMINAL_CONTINUATION_FOUNDATION_GAIN
    if (hasIndependentReentry) {
      result.push({ ...range })
      continue
    }
    const previousBars = previous.endIndex - previous.startIndex
    const continuationBars = range.endIndex - range.startIndex
    previous.confidence =
      (previous.confidence * previousBars + range.confidence * continuationBars) /
      Math.max(1, previousBars + continuationBars)
    previous.endIndex = range.endIndex
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

export const refineInitialGrooveDropRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  spectralBoundaries: readonly SongStructureSpectralBoundary[]
) =>
  mergeAdjacentRanges(
    mergeTerminalDropContinuationGroove(
      bars,
      splitInitialGrooveAtStructuralDrop(bars, ranges, spectralBoundaries)
    )
  )

export const refineInactiveDropValleyRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  spectralBoundaries: readonly SongStructureSpectralBoundary[] = []
) => {
  const boundarySet = new Set(spectralBoundaries.map((boundary) => boundary.index))
  return mergeAdjacentRanges(
    promoteStructuralDropReentries(
      bars,
      ranges.flatMap((range, index) => {
        const previous = ranges[index - 1]
        const leadingCandidate =
          range.kind === 'groove' && previous?.kind === 'drop'
            ? buildInactiveValleyCandidate(bars, range, range.startIndex, boundarySet, true)
            : null
        const shouldScan =
          range.kind === 'drop' ||
          range.endIndex - range.startIndex >= MIN_GROOVE_SCAN_BARS ||
          leadingCandidate !== null
        return shouldScan
          ? splitActiveRangeAtInactiveValleys(bars, range, boundarySet, leadingCandidate)
          : [{ ...range }]
      })
    )
  )
}
