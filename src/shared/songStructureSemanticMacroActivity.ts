import { clamp01, type SongStructureSectionKind } from './songStructureCommon'
import {
  isDecisiveActiveReentry,
  resolveSongStructureSemanticActivity,
  resolveSongStructureSemanticFoundation,
  type SongStructureSemanticActivitySegment
} from './songStructureSemanticActivity'

type MacroActivitySegment = SongStructureSemanticActivitySegment & {
  bars: number
  relativeReduction: number
}

const MAX_INTERRUPTED_BREAKDOWN_BARS = 32
const MIN_ACTIVE_ANCHOR_GAP = 0.075
const MAX_VALLEY_RECOVERY_RATIO = 0.52
const MIN_VALLEY_RELATIVE_REDUCTION = 0.12

const resolveWeightedAverage = (
  segments: readonly MacroActivitySegment[],
  startIndex: number,
  endIndex: number,
  resolveValue: (segment: MacroActivitySegment) => number
) => {
  let total = 0
  let bars = 0
  for (let index = startIndex; index < endIndex; index += 1) {
    const segment = segments[index]
    if (!segment) continue
    total += resolveValue(segment) * segment.bars
    bars += segment.bars
  }
  return bars > 0 ? total / bars : 0
}

const bridgeInterruptedBreakdowns = (
  segments: readonly MacroActivitySegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  for (let left = 0; left < result.length - 2; left += 1) {
    if (result[left] !== 'breakdown') continue
    let gapBars = 0
    let hasActiveReentry = false
    for (let right = left + 1; right < result.length; right += 1) {
      const kind = result[right]
      const segment = segments[right]
      const previous = segments[right - 1]
      if (!segment || !kind || kind === 'intro' || kind === 'outro') break
      if (kind === 'drop') break
      if (kind === 'breakdown') {
        if (!hasActiveReentry && gapBars <= MAX_INTERRUPTED_BREAKDOWN_BARS) {
          for (let index = left + 1; index < right; index += 1) result[index] = 'breakdown'
        }
        break
      }
      gapBars += segment.bars
      if (previous && isDecisiveActiveReentry(previous, segment)) hasActiveReentry = true
      if (gapBars > MAX_INTERRUPTED_BREAKDOWN_BARS || hasActiveReentry) break
    }
  }
  return result
}

const resolveRecoveryRatio = (floor: number, plateau: number, anchor: number) => {
  const span = anchor - floor
  if (span < MIN_ACTIVE_ANCHOR_GAP) return 1
  return clamp01((plateau - floor) / span)
}

const preserveMacroValleys = (
  segments: readonly MacroActivitySegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  let index = 0
  while (index < result.length) {
    if (result[index] !== 'breakdown') {
      index += 1
      continue
    }
    const breakdownStart = index
    while (result[index] === 'breakdown') index += 1
    const breakdownEnd = index
    const previousIndex = breakdownStart - 1
    if (result[previousIndex] !== 'drop' && result[previousIndex] !== 'groove') continue

    const plateauStart = index
    while (result[index] === 'groove') index += 1
    const plateauEnd = index
    if (plateauEnd <= plateauStart || (result[index] !== 'drop' && result[index] !== 'groove')) {
      continue
    }
    const plateauBars = segments
      .slice(plateauStart, plateauEnd)
      .reduce((total, segment) => total + segment.bars, 0)
    if (plateauBars > MAX_INTERRUPTED_BREAKDOWN_BARS) continue

    const previous = segments[previousIndex]
    const preReentry = segments[plateauEnd - 1]
    const next = segments[index]
    if (!previous || !preReentry || !next || !isDecisiveActiveReentry(preReentry, next)) continue

    const floorActivity = resolveWeightedAverage(
      segments,
      breakdownStart,
      breakdownEnd,
      (segment) => resolveSongStructureSemanticActivity(segment.normalized)
    )
    const plateauActivity = resolveWeightedAverage(segments, plateauStart, plateauEnd, (segment) =>
      resolveSongStructureSemanticActivity(segment.normalized)
    )
    const activityAnchor = Math.min(
      resolveSongStructureSemanticActivity(previous.normalized),
      resolveSongStructureSemanticActivity(next.normalized)
    )
    const floorFoundation = resolveWeightedAverage(
      segments,
      breakdownStart,
      breakdownEnd,
      (segment) => resolveSongStructureSemanticFoundation(segment.normalized)
    )
    const plateauFoundation = resolveWeightedAverage(
      segments,
      plateauStart,
      plateauEnd,
      (segment) => resolveSongStructureSemanticFoundation(segment.normalized)
    )
    const foundationAnchor = Math.min(
      resolveSongStructureSemanticFoundation(previous.normalized),
      resolveSongStructureSemanticFoundation(next.normalized)
    )
    const recoveryRatio =
      resolveRecoveryRatio(floorActivity, plateauActivity, activityAnchor) * 0.42 +
      resolveRecoveryRatio(floorFoundation, plateauFoundation, foundationAnchor) * 0.58
    const relativeReduction = resolveWeightedAverage(
      segments,
      plateauStart,
      plateauEnd,
      (segment) => segment.relativeReduction
    )
    if (
      recoveryRatio > MAX_VALLEY_RECOVERY_RATIO ||
      relativeReduction < MIN_VALLEY_RELATIVE_REDUCTION
    ) {
      continue
    }
    for (let cursor = plateauStart; cursor < plateauEnd; cursor += 1) {
      result[cursor] = 'breakdown'
    }
    if (result[index] === 'groove') result[index] = 'drop'
  }
  return result
}

export const resolveSongStructureMacroActivityKinds = (
  segments: readonly MacroActivitySegment[],
  kinds: readonly SongStructureSectionKind[]
) => preserveMacroValleys(segments, bridgeInterruptedBreakdowns(segments, kinds))
