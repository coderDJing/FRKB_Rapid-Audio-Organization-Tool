import type { SongStructureSectionKind } from './songStructureCommon'
import {
  resolveSongStructureSemanticActivity,
  resolveSongStructureSemanticFoundation,
  resolveActiveSemanticScore,
  type SongStructureSemanticActivitySegment
} from './songStructureSemanticActivity'

type SemanticStateSegment = SongStructureSemanticActivitySegment & {
  bars: number
  startIndex: number
  endIndex: number
  relativeReduction: number
}

const MIN_MACRO_STATE_SPAN = 0.1
const ACTIVE_MACRO_POSITION = 0.62
const INACTIVE_MACRO_POSITION = 0.38
const MAX_WEAK_BREAKDOWN_MARGIN = 0.05
const MIN_INACTIVE_RELATIVE_REDUCTION = 0.18

const resolveMacroLevel = (segment: SemanticStateSegment) =>
  resolveSongStructureSemanticActivity(segment.normalized) * 0.45 +
  resolveSongStructureSemanticFoundation(segment.normalized) * 0.55

const resolveWeightedPercentile = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[],
  ratio: number
) => {
  const samples = segments
    .flatMap((segment, index) => {
      const kind = kinds[index]
      return kind === 'intro' || kind === 'outro'
        ? []
        : [{ value: resolveMacroLevel(segment), weight: Math.max(1, segment.bars) }]
    })
    .sort((left, right) => left.value - right.value)
  const totalWeight = samples.reduce((total, sample) => total + sample.weight, 0)
  const targetWeight = totalWeight * ratio
  let accumulated = 0
  for (const sample of samples) {
    accumulated += sample.weight
    if (accumulated >= targetWeight) return sample.value
  }
  return samples.at(-1)?.value ?? 0
}

const refineMacroStateAdmissibility = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  const inactiveAnchor = resolveWeightedPercentile(segments, result, 0.2)
  const activeAnchor = resolveWeightedPercentile(segments, result, 0.75)
  const span = activeAnchor - inactiveAnchor
  if (span < MIN_MACRO_STATE_SPAN) return result
  const resolvePosition = (segment: SemanticStateSegment) =>
    (resolveMacroLevel(segment) - inactiveAnchor) / span

  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    const kind = result[index]
    const previousKind = result[index - 1]
    if (!segment || !kind) continue
    const activeScore = resolveActiveSemanticScore(segment)
    const breakdownMargin = segment.scores.breakdown - activeScore
    if (
      kind === 'breakdown' &&
      (previousKind === 'drop' || previousKind === 'groove') &&
      resolvePosition(segment) >= ACTIVE_MACRO_POSITION &&
      breakdownMargin <= MAX_WEAK_BREAKDOWN_MARGIN &&
      segment.relativeReduction < 0.32
    ) {
      result[index] = 'groove'
    }
  }

  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    const kind = result[index]
    const previousKind = result[index - 1]
    const nextKind = result[index + 1]
    if (!segment || !kind || (kind !== 'groove' && kind !== 'drop')) continue
    const activeScore = resolveActiveSemanticScore(segment)
    const inactiveTopology =
      nextKind === 'build' ||
      ((previousKind === 'drop' || previousKind === 'groove') &&
        (nextKind === 'drop' || nextKind === 'groove'))
    if (
      inactiveTopology &&
      resolvePosition(segment) <= INACTIVE_MACRO_POSITION &&
      segment.relativeReduction >= MIN_INACTIVE_RELATIVE_REDUCTION &&
      segment.scores.breakdown >= activeScore - 0.03
    ) {
      result[index] = 'breakdown'
    }
  }
  return result
}

const isPronouncedLocalInactiveValley = (
  segment: SemanticStateSegment,
  kind: SongStructureSectionKind
) => {
  if (kind !== 'drop' && kind !== 'groove') return false
  if (segment.bars < 4) return false
  const activity = resolveSongStructureSemanticActivity(segment.normalized)
  const activeScore = resolveActiveSemanticScore(segment)
  return (
    activity <= 0.46 &&
    segment.relativeReduction >= 0.32 &&
    segment.scores.breakdown >= activeScore - 0.08
  )
}

const isTerminalFalseBreakdown = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[],
  index: number
) => {
  if (kinds[index] !== 'breakdown') return false
  const segment = segments[index]
  if (!segment || resolveSongStructureSemanticActivity(segment.normalized) < 0.48) return false
  const remainingKinds = kinds.slice(index + 1)
  if (!remainingKinds.includes('outro')) return false
  if (remainingKinds.some((kind) => kind !== 'groove' && kind !== 'outro')) return false
  const alternativeScore = Math.max(resolveActiveSemanticScore(segment), segment.scores.outro)
  return alternativeScore >= segment.scores.breakdown + 0.06
}

const isInitialBreakdownContinuation = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[],
  index: number
) => {
  if (kinds[index] !== 'breakdown' || index <= 0) return false
  if (!kinds.slice(0, index).every((kind) => kind === 'intro')) return false
  const nextKind = kinds[index + 1]
  if (nextKind !== 'drop' && nextKind !== 'groove') return false
  const segment = segments[index]
  const totalBars = segments.at(-1)?.endIndex ?? 0
  return !!segment && segment.endIndex <= totalBars * 0.2
}

const isInitialIntroOverextension = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[],
  index: number
) => {
  if (kinds[index] !== 'intro' || index <= 0) return false
  if (!kinds.slice(0, index).every((kind) => kind === 'intro')) return false
  const segment = segments[index]
  const previous = segments[index - 1]
  const nextKind = kinds[index + 1]
  if (
    !segment ||
    !previous ||
    (nextKind !== 'groove' && nextKind !== 'build' && nextKind !== 'drop')
  ) {
    return false
  }
  const activityGain =
    resolveSongStructureSemanticActivity(segment.normalized) -
    resolveSongStructureSemanticActivity(previous.normalized)
  return (
    segment.bars >= 4 &&
    segment.entryRise >= 0.075 &&
    activityGain >= 0.06 &&
    segment.relativeReduction <= 0.15 &&
    segment.scores.groove >= 0.46
  )
}

const isTemplateOnlyPreBuildBreakdown = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[],
  index: number
) => {
  if (kinds[index] !== 'breakdown') return false
  const segment = segments[index]
  const previousKind = kinds[index - 1]
  const nextKind = kinds[index + 1]
  return (
    !!segment &&
    (previousKind === 'groove' || previousKind === 'drop') &&
    nextKind === 'build' &&
    segment.bars <= 8 &&
    segment.relativeReduction < 0.12 &&
    segment.entryRise < 0.05 &&
    segment.scores.groove >= segment.scores.breakdown + 0.05
  )
}

export const refineSongStructureSemanticStateKinds = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = refineMacroStateAdmissibility(segments, kinds)
  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    const kind = result[index]
    if (!segment || !kind) continue
    if (isInitialIntroOverextension(segments, result, index)) {
      result[index] = 'groove'
      continue
    }
    if (isTemplateOnlyPreBuildBreakdown(segments, result, index)) {
      result[index] = 'groove'
      continue
    }
    if (isInitialBreakdownContinuation(segments, result, index)) {
      result[index] = 'intro'
      continue
    }
    if (isPronouncedLocalInactiveValley(segment, kind)) {
      result[index] = 'breakdown'
      continue
    }
    if (isTerminalFalseBreakdown(segments, result, index)) result[index] = 'groove'
  }
  return result
}
