import type { SongStructureSemanticRange } from './songStructureSemanticOutro'

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

const isActiveKind = (kind: SongStructureSemanticRange['kind']) =>
  kind === 'drop' || kind === 'groove'

const isInactiveTransitionKind = (kind: SongStructureSemanticRange['kind']) =>
  kind === 'breakdown' || kind === 'build'

const absorbOneBarTransitions = (ranges: readonly SongStructureSemanticRange[]) =>
  ranges.map((range, index) => {
    if (range.endIndex - range.startIndex > 4 || !isInactiveTransitionKind(range.kind)) {
      return { ...range }
    }
    const previous = ranges[index - 1]
    const next = ranges[index + 1]
    if (next?.kind === 'build') return { ...range, kind: 'build' as const }
    if (previous && next && previous.kind === next.kind) {
      return { ...range, kind: previous.kind }
    }
    if (next?.kind === 'outro') return { ...range, kind: 'outro' as const }
    return { ...range }
  })

const absorbUnstableActiveBursts = (ranges: readonly SongStructureSemanticRange[]) =>
  ranges.map((range, index) => {
    if (range.endIndex - range.startIndex >= 4 || !isActiveKind(range.kind)) return { ...range }
    const previous = ranges[index - 1]
    const next = ranges[index + 1]
    if (!previous || !next) return { ...range }
    if (previous.kind === 'breakdown' && next.kind === 'build') {
      return { ...range, kind: 'build' as const }
    }
    if (isInactiveTransitionKind(previous.kind) && previous.kind === next.kind) {
      return { ...range, kind: previous.kind }
    }
    return { ...range }
  })

const normalizeBreakdownBuildTopology = (ranges: readonly SongStructureSemanticRange[]) =>
  ranges.map((range, index) => {
    const previous = ranges[index - 1]
    const next = ranges[index + 1]
    if (
      isActiveKind(range.kind) &&
      range.endIndex - range.startIndex <= 16 &&
      previous?.kind === 'breakdown' &&
      next?.kind === 'build'
    ) {
      return { ...range, kind: 'breakdown' as const }
    }
    if (range.kind === 'groove' && previous?.kind === 'build') {
      return { ...range, kind: 'drop' as const }
    }
    return { ...range }
  })

export const stabilizeSongStructureSemanticRanges = (
  ranges: readonly SongStructureSemanticRange[]
) =>
  mergeAdjacentRanges(
    normalizeBreakdownBuildTopology(
      mergeAdjacentRanges(
        absorbUnstableActiveBursts(mergeAdjacentRanges(absorbOneBarTransitions(ranges)))
      )
    )
  )
