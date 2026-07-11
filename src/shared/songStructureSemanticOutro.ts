import { clamp, clamp01, ramp, type SongStructureSectionKind } from './songStructureCommon'
import {
  SONG_STRUCTURE_SPECTRAL_VALUE_KEYS,
  type SongStructureSpectralBarFeature,
  type SongStructureSpectralValues
} from './songStructureSpectralFeatures'

export type SongStructureSemanticRange = {
  startIndex: number
  endIndex: number
  kind: SongStructureSectionKind
  confidence: number
  clusterId: number
  entryBoundaryScore: number
}

type TerminalActivityWindow = {
  normalizedValues: SongStructureSpectralValues
  rawValues: SongStructureSpectralValues
  normalizedFoundation: number
  rawFoundation: number
}

export type SongStructureTerminalOutroDiagnostic = {
  index: number
  normalizedReduction: number
  foundationDrop: number
  layerDrop: number
  rawReduction: number
  persistence: number
  hasDecisiveRecovery: boolean
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

const averageValues = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number,
  field: 'values' | 'normalized'
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const result = createEmptyValues()
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const values = bars[index]?.[field]
    if (!values) continue
    for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
      result[key] += values[key] / (end - start)
    }
  }
  return result
}

const toRank = (value: number) => clamp01(value * 0.5 + 0.5)

const resolveOutroFoundation = (values: SongStructureSpectralValues, normalized: boolean) => {
  const read = normalized ? toRank : clamp01
  return clamp01(
    read(values.energy) * 0.28 +
      read(values.low) * 0.28 +
      read(values.attackDensity) * 0.18 +
      read(values.density) * 0.26
  )
}

const resolvePositiveLayerReduction = (
  reference: SongStructureSpectralValues,
  current: SongStructureSpectralValues,
  normalized: boolean
) => {
  const read = normalized ? toRank : clamp01
  return clamp01(
    Math.max(0, read(reference.energy) - read(current.energy)) * 0.24 +
      Math.max(0, read(reference.low) - read(current.low)) * 0.22 +
      Math.max(0, read(reference.mid) - read(current.mid)) * 0.16 +
      Math.max(0, read(reference.high) - read(current.high)) * 0.1 +
      Math.max(0, read(reference.attackDensity) - read(current.attackDensity)) * 0.12 +
      Math.max(0, read(reference.density) - read(current.density)) * 0.16
  )
}

const summarizeTerminalActivityWindow = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
): TerminalActivityWindow => {
  const normalizedValues = averageValues(bars, startIndex, endIndex, 'normalized')
  const rawValues = averageValues(bars, startIndex, endIndex, 'values')
  return {
    normalizedValues,
    rawValues,
    normalizedFoundation: resolveOutroFoundation(normalizedValues, true),
    rawFoundation: resolveOutroFoundation(rawValues, false)
  }
}

const resolveTerminalPersistence = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  reference: TerminalActivityWindow,
  initial: TerminalActivityWindow,
  initialDrop: number
) => {
  let persistentWindows = 0
  let totalWindows = 0
  let peakFoundation = initial.normalizedFoundation
  for (let index = startIndex; index <= bars.length - 4; index += 2) {
    const current = summarizeTerminalActivityWindow(bars, index, index + 4)
    const foundationDrop = reference.normalizedFoundation - current.normalizedFoundation
    const layerDrop = resolvePositiveLayerReduction(
      reference.normalizedValues,
      current.normalizedValues,
      true
    )
    const rawDrop = Math.max(
      reference.rawFoundation - current.rawFoundation,
      resolvePositiveLayerReduction(reference.rawValues, current.rawValues, false)
    )
    if (Math.max(foundationDrop, layerDrop) >= 0.045 || rawDrop >= 0.012) {
      persistentWindows += 1
    }
    if (index >= startIndex + 4) {
      peakFoundation = Math.max(peakFoundation, current.normalizedFoundation)
    }
    totalWindows += 1
  }
  const recoveryGain = peakFoundation - initial.normalizedFoundation
  const recoveredDropLevel = peakFoundation >= reference.normalizedFoundation - 0.1
  return {
    persistence: persistentWindows / Math.max(1, totalWindows),
    hasDecisiveRecovery: recoveryGain >= Math.max(0.12, initialDrop * 0.55) && recoveredDropLevel
  }
}

const hasRecoveredDropBaseline = (
  bars: readonly SongStructureSpectralBarFeature[],
  activeReentryIndexes: readonly number[],
  candidateIndex: number,
  reference: TerminalActivityWindow,
  initial: TerminalActivityWindow,
  initialDrop: number
) =>
  activeReentryIndexes.some((reentryIndex) => {
    if (reentryIndex <= candidateIndex + 3 || reentryIndex >= bars.length - 3) return false
    const reentry = summarizeTerminalActivityWindow(bars, reentryIndex, reentryIndex + 4)
    const recoveryGain = reentry.normalizedFoundation - initial.normalizedFoundation
    return (
      reentry.normalizedFoundation >= reference.normalizedFoundation - 0.06 &&
      recoveryGain >= Math.max(0.1, initialDrop * 0.6)
    )
  })

export const buildSongStructureTerminalOutroDiagnostics = (
  bars: readonly SongStructureSpectralBarFeature[]
): SongStructureTerminalOutroDiagnostic[] => {
  const result: SongStructureTerminalOutroDiagnostic[] = []
  for (let index = Math.max(8, bars.length - 48); index <= bars.length - 4; index += 1) {
    const reference = summarizeTerminalActivityWindow(bars, index - 8, index)
    const initial = summarizeTerminalActivityWindow(bars, index, index + 4)
    const foundationDrop = reference.normalizedFoundation - initial.normalizedFoundation
    const layerDrop = resolvePositiveLayerReduction(
      reference.normalizedValues,
      initial.normalizedValues,
      true
    )
    const rawReduction = Math.max(
      reference.rawFoundation - initial.rawFoundation,
      resolvePositiveLayerReduction(reference.rawValues, initial.rawValues, false)
    )
    const normalizedReduction = Math.max(foundationDrop, layerDrop)
    const persistence = resolveTerminalPersistence(
      bars,
      index,
      reference,
      initial,
      normalizedReduction
    )
    result.push({
      index,
      normalizedReduction,
      foundationDrop,
      layerDrop,
      rawReduction,
      persistence: persistence.persistence,
      hasDecisiveRecovery: persistence.hasDecisiveRecovery
    })
  }
  return result
}

const findTerminalOutroBoundary = (
  bars: readonly SongStructureSpectralBarFeature[],
  finalDropRange: SongStructureSemanticRange,
  activeReentryIndexes: readonly number[]
) => {
  if (bars.length < 24 || finalDropRange.endIndex - finalDropRange.startIndex < 8) return null
  const scanStart = Math.max(
    finalDropRange.startIndex + 8,
    bars.length - 48,
    Math.floor(bars.length * 0.6)
  )
  const scanEnd = bars.length - 4
  let weakAlignedCandidateIndex: number | null = null
  for (let index = scanStart; index <= scanEnd; index += 1) {
    const reference = summarizeTerminalActivityWindow(bars, Math.max(0, index - 8), index)
    const initial = summarizeTerminalActivityWindow(bars, index, index + 4)
    const onset = summarizeTerminalActivityWindow(bars, index, index + 1)
    const foundationDrop = reference.normalizedFoundation - initial.normalizedFoundation
    const layerDrop = resolvePositiveLayerReduction(
      reference.normalizedValues,
      initial.normalizedValues,
      true
    )
    const rawReduction = Math.max(
      reference.rawFoundation - initial.rawFoundation,
      resolvePositiveLayerReduction(reference.rawValues, initial.rawValues, false)
    )
    const normalizedReduction = Math.max(foundationDrop, layerDrop)
    if (
      hasRecoveredDropBaseline(
        bars,
        activeReentryIndexes,
        index,
        reference,
        initial,
        normalizedReduction
      )
    ) {
      continue
    }
    const onsetReduction = Math.max(
      reference.normalizedFoundation - onset.normalizedFoundation,
      resolvePositiveLayerReduction(reference.normalizedValues, onset.normalizedValues, true)
    )
    const rawOnsetReduction = Math.max(
      reference.rawFoundation - onset.rawFoundation,
      resolvePositiveLayerReduction(reference.rawValues, onset.rawValues, false)
    )
    if (onsetReduction < 0.015 && rawOnsetReduction < 0.006) continue
    const aligned = bars[index]?.isPhraseBoundary ?? false
    const strongNormalizedRelease = aligned
      ? normalizedReduction >= 0.055
      : foundationDrop >= 0.12 || layerDrop >= 0.12
    if (!strongNormalizedRelease || (rawReduction < 0.012 && normalizedReduction < 0.14)) continue
    const persistence = resolveTerminalPersistence(
      bars,
      index,
      reference,
      initial,
      normalizedReduction
    )
    if (persistence.persistence < 0.75 || persistence.hasDecisiveRecovery) continue
    if (
      aligned &&
      normalizedReduction < 0.08 &&
      (persistence.persistence < 0.9 || rawReduction < 0.012)
    ) {
      continue
    }
    if (aligned && normalizedReduction < 0.075) {
      if (weakAlignedCandidateIndex === null || index - weakAlignedCandidateIndex !== 8) {
        weakAlignedCandidateIndex = index
        continue
      }
    }
    return {
      index,
      confidence: clamp01(
        0.55 +
          ramp(normalizedReduction, 0.075, 0.25) * 0.25 +
          ramp(rawReduction, 0.012, 0.1) * 0.12 +
          ramp(persistence.persistence, 0.75, 1) * 0.08
      )
    }
  }
  return null
}

const mergeAdjacentSemanticRanges = (ranges: readonly SongStructureSemanticRange[]) => {
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

export const refineTerminalOutroRanges = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[],
  activeReentryIndexes: readonly number[]
) => {
  const finalDropRange = [...ranges].reverse().find((range) => range.kind === 'drop')
  if (!finalDropRange) return [...ranges]
  const boundary = findTerminalOutroBoundary(bars, finalDropRange, activeReentryIndexes)
  if (!boundary) return [...ranges]
  const refined: SongStructureSemanticRange[] = []
  let boundaryClusterId = finalDropRange.clusterId
  for (const range of ranges) {
    if (range.endIndex <= boundary.index) {
      refined.push({
        ...range,
        kind: range.kind === 'outro' ? 'drop' : range.kind
      })
      continue
    }
    boundaryClusterId = range.clusterId
    if (range.startIndex < boundary.index) {
      refined.push({
        ...range,
        endIndex: boundary.index,
        kind: range.kind === 'outro' ? 'drop' : range.kind
      })
    }
    break
  }
  refined.push({
    startIndex: boundary.index,
    endIndex: bars.length,
    kind: 'outro',
    confidence: boundary.confidence,
    clusterId: boundaryClusterId,
    entryBoundaryScore: 0
  })
  return mergeAdjacentSemanticRanges(refined)
}
