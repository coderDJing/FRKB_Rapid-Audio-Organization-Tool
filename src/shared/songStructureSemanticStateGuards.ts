import type { SongStructureSectionKind } from './songStructureCommon'
import {
  resolveSongStructureSemanticActivity,
  resolveActiveSemanticScore,
  type SongStructureSemanticActivitySegment
} from './songStructureSemanticActivity'

type SemanticStateSegment = SongStructureSemanticActivitySegment & {
  bars: number
  startIndex: number
  endIndex: number
  relativeReduction: number
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

export const refineSongStructureSemanticStateKinds = (
  segments: readonly SemanticStateSegment[],
  kinds: readonly SongStructureSectionKind[]
) => {
  const result = [...kinds]
  for (let index = 0; index < result.length; index += 1) {
    const segment = segments[index]
    const kind = result[index]
    if (!segment || !kind) continue
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
