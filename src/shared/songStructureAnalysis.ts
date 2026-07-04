import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import {
  BEATS_PER_BAR,
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  MAX_SECTIONS,
  PHRASE_BARS,
  PHRASE_BEATS,
  clamp,
  clamp01,
  normalizeBeatOffset,
  normalizeStructureGrid,
  percentile,
  ramp,
  readByteRatio,
  resolveBassPresence,
  toFixedNumber,
  type BuildSongStructureInput,
  type SongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'
import { buildAlgorithmicSongStructureSections } from './songStructureAlgorithmic'

type SongStructureFeature = {
  startSec: number
  endSec: number
  startBar: number
  endBar: number
  phraseIndex: number
  energy: number
  attack: number
  low: number
  high: number
  bass: number
  slices: SongStructureFineFeature[]
}

type SongStructureFineFeature = SongStructureFeatureValues & {
  startSec: number
  endSec: number
  startBar: number
  endBar: number
}

type SongStructureFeatureValues = Pick<
  SongStructureFeature,
  'energy' | 'attack' | 'low' | 'high' | 'bass'
>

type SongStructureFeatureStats = {
  durationSec: number
  p25Energy: number
  medianEnergy: number
  p75Energy: number
  p25Low: number
  medianLow: number
  p75Low: number
  p25Bass: number
  medianBass: number
  p75Bass: number
  medianAttack: number
  p75Attack: number
  medianHigh: number
  p75High: number
}

type TemplateDropCandidate = { index: number; score: number }

type TemplateSectionRange = {
  startIndex: number
  endIndex: number
  kind: SongStructureSectionKind
  confidence: number
  startSec?: number
  endSec?: number
  startBar?: number
  endBar?: number
}

type TemplateBoundary = { index: number; sec?: number; startBar?: number; previousEndBar?: number }

const DROP_START_REFINE_BARS = 2

const summarizeRange = (
  values: Uint8Array | undefined,
  startFrame: number,
  endFrame: number,
  fallback = 0
) => {
  if (!values?.length || endFrame <= startFrame) return fallback
  const start = clamp(Math.floor(startFrame), 0, values.length - 1)
  const end = clamp(Math.ceil(endFrame), start + 1, values.length)
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const value = readByteRatio(values, index)
    sum += value
    peak = Math.max(peak, value)
  }
  const mean = sum / Math.max(1, end - start)
  return clamp01(mean * 0.76 + peak * 0.24)
}

const summarizeBassPresenceRange = (
  heightValues: Uint8Array | undefined,
  lowValues: Uint8Array | undefined,
  startFrame: number,
  endFrame: number
) => {
  if (!heightValues?.length || !lowValues?.length || endFrame <= startFrame) return 0
  const length = Math.min(heightValues.length, lowValues.length)
  const start = clamp(Math.floor(startFrame), 0, length - 1)
  const end = clamp(Math.ceil(endFrame), start + 1, length)
  let sum = 0
  let peak = 0
  for (let index = start; index < end; index += 1) {
    const bass = resolveBassPresence({
      energy: readByteRatio(heightValues, index),
      low: readByteRatio(lowValues, index)
    })
    sum += bass
    peak = Math.max(peak, bass)
  }
  const mean = sum / Math.max(1, end - start)
  return clamp01(mean * 0.86 + peak * 0.14)
}

const summarizeFeatureValues = (
  data: UnifiedDisplayWaveformDetailData,
  startFrame: number,
  endFrame: number
): SongStructureFeatureValues => ({
  energy: summarizeRange(data.height, startFrame, endFrame),
  attack: summarizeRange(data.attack, startFrame, endFrame),
  low: summarizeRange(data.colorLow, startFrame, endFrame),
  high: summarizeRange(data.colorHigh, startFrame, endFrame),
  bass: summarizeBassPresenceRange(data.height, data.colorLow, startFrame, endFrame)
})

const resolveBarNumber = (
  sec: number,
  firstBeatSec: number,
  beatSec: number,
  barBeatOffset: number
) => {
  const beatIndex = Math.round((sec - firstBeatSec) / beatSec)
  return Math.max(1, Math.floor((beatIndex - barBeatOffset) / BEATS_PER_BAR) + 1)
}

const buildFineFeature = (
  data: UnifiedDisplayWaveformDetailData,
  startSec: number,
  endSec: number,
  detailRate: number,
  firstBeatSec: number,
  beatSec: number,
  barBeatOffset: number
): SongStructureFineFeature => {
  const startFrame = Math.floor(startSec * detailRate)
  const endFrame = Math.ceil(endSec * detailRate)
  const values = summarizeFeatureValues(data, startFrame, endFrame)
  return {
    startSec,
    endSec,
    startBar: resolveBarNumber(startSec, firstBeatSec, beatSec, barBeatOffset),
    endBar: resolveBarNumber(
      Math.max(startSec, endSec - beatSec),
      firstBeatSec,
      beatSec,
      barBeatOffset
    ),
    ...values
  }
}

const pushUniqueBoundary = (boundaries: number[], nextSec: number, minGapSec: number) => {
  const sec = toFixedNumber(Math.max(0, nextSec), 4)
  const last = boundaries[boundaries.length - 1]
  if (last !== undefined && Math.abs(sec - last) < minGapSec) return
  boundaries.push(sec)
}

const buildPhraseBoundaries = (
  durationSec: number,
  bpm: number,
  firstBeatMs: number,
  barBeatOffset: number
) => {
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0 || durationSec <= beatSec * BEATS_PER_BAR) {
    return []
  }

  const firstBeatSec = firstBeatMs / 1000
  const normalizedBarBeatOffset = normalizeBeatOffset(barBeatOffset) ?? 0
  const minGapSec = Math.max(beatSec * BEATS_PER_BAR * 2, 2)
  const boundaries: number[] = [0]
  const startIndex = Math.floor((0 - firstBeatSec) / beatSec) - PHRASE_BEATS * 2
  const endIndex = Math.ceil((durationSec - firstBeatSec) / beatSec) + PHRASE_BEATS * 2

  for (let index = startIndex; index <= endIndex; index += 1) {
    const shiftedIndex = index - normalizedBarBeatOffset
    const phraseMod = ((shiftedIndex % PHRASE_BEATS) + PHRASE_BEATS) % PHRASE_BEATS
    if (phraseMod !== 0) continue
    const sec = firstBeatSec + index * beatSec
    if (sec <= minGapSec * 0.5 || sec >= durationSec - minGapSec * 0.35) continue
    pushUniqueBoundary(boundaries, sec, minGapSec)
  }

  if (durationSec - (boundaries[boundaries.length - 1] ?? 0) >= minGapSec) {
    boundaries.push(toFixedNumber(durationSec, 4))
  } else {
    boundaries[boundaries.length - 1] = toFixedNumber(durationSec, 4)
  }

  return boundaries
}

const buildFeatures = (
  data: UnifiedDisplayWaveformDetailData,
  boundaries: readonly number[],
  bpm: number,
  firstBeatMs: number,
  barBeatOffset: number
) => {
  const detailRate = Math.max(1, Number(data.detailRate) || 1)
  const firstBeatSec = firstBeatMs / 1000
  const beatSec = 60 / bpm
  const features: SongStructureFeature[] = []

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startSec = boundaries[index] ?? 0
    const endSec = boundaries[index + 1] ?? startSec
    if (endSec - startSec <= beatSec * BEATS_PER_BAR) continue
    const startFrame = Math.floor(startSec * detailRate)
    const endFrame = Math.ceil(endSec * detailRate)
    const values = summarizeFeatureValues(data, startFrame, endFrame)
    const slices: SongStructureFineFeature[] = []
    const sliceDurationSec = beatSec * BEATS_PER_BAR * DROP_START_REFINE_BARS
    for (
      let sliceStartSec = startSec;
      sliceStartSec < endSec - beatSec;
      sliceStartSec += sliceDurationSec
    ) {
      const sliceEndSec = Math.min(endSec, sliceStartSec + sliceDurationSec)
      if (sliceEndSec - sliceStartSec <= beatSec * BEATS_PER_BAR * 0.5) continue
      slices.push(
        buildFineFeature(
          data,
          sliceStartSec,
          sliceEndSec,
          detailRate,
          firstBeatSec,
          beatSec,
          barBeatOffset
        )
      )
    }
    features.push({
      startSec,
      endSec,
      startBar: resolveBarNumber(startSec, firstBeatSec, beatSec, barBeatOffset),
      endBar: resolveBarNumber(
        Math.max(startSec, endSec - beatSec),
        firstBeatSec,
        beatSec,
        barBeatOffset
      ),
      phraseIndex: index,
      ...values,
      slices
    })
  }

  return features
}

const toFeatureValues = (feature: SongStructureFeature): SongStructureFeatureValues => ({
  energy: feature.energy,
  attack: feature.attack,
  low: feature.low,
  high: feature.high,
  bass: feature.bass
})

const averageFeatureValues = (
  features: readonly SongStructureFeature[],
  startIndex: number,
  endIndex: number,
  fallback: SongStructureFeature
): SongStructureFeatureValues => {
  const start = clamp(Math.floor(startIndex), 0, features.length)
  const end = clamp(Math.floor(endIndex), start, features.length)
  if (end <= start) return toFeatureValues(fallback)
  const sum: SongStructureFeatureValues = {
    energy: 0,
    attack: 0,
    low: 0,
    high: 0,
    bass: 0
  }
  for (let index = start; index < end; index += 1) {
    const feature = features[index]
    if (!feature) continue
    sum.energy += feature.energy
    sum.attack += feature.attack
    sum.low += feature.low
    sum.high += feature.high
    sum.bass += feature.bass
  }
  const count = Math.max(1, end - start)
  return {
    energy: sum.energy / count,
    attack: sum.attack / count,
    low: sum.low / count,
    high: sum.high / count,
    bass: sum.bass / count
  }
}

const resolveFeatureDistance = (
  left: SongStructureFeatureValues,
  right: SongStructureFeatureValues
) =>
  clamp01(
    Math.abs(left.energy - right.energy) * 0.28 +
      Math.abs(left.bass - right.bass) * 0.38 +
      Math.abs(left.low - right.low) * 0.12 +
      Math.abs(left.attack - right.attack) * 0.16 +
      Math.abs(left.high - right.high) * 0.06
  )

const resolveLocalNovelty = (
  current: SongStructureFeature,
  previous: SongStructureFeature | undefined,
  previousAverage: SongStructureFeatureValues
) => {
  if (!previous) return 0
  const directDistance = resolveFeatureDistance(toFeatureValues(current), toFeatureValues(previous))
  const localDistance = resolveFeatureDistance(toFeatureValues(current), previousAverage)
  return clamp01(directDistance * 0.64 + localDistance * 0.36)
}

const buildStats = (features: readonly SongStructureFeature[], durationSec: number) => {
  const energyValues = features.map((feature) => feature.energy)
  const lowValues = features.map((feature) => feature.low)
  const bassValues = features.map((feature) => feature.bass)
  const highValues = features.map((feature) => feature.high)
  const attackValues = features.map((feature) => feature.attack)
  return {
    durationSec,
    p25Energy: percentile(energyValues, 0.25),
    medianEnergy: percentile(energyValues, 0.5),
    p75Energy: percentile(energyValues, 0.75),
    p25Low: percentile(lowValues, 0.25),
    medianLow: percentile(lowValues, 0.5),
    p75Low: percentile(lowValues, 0.75),
    p25Bass: percentile(bassValues, 0.25),
    medianBass: percentile(bassValues, 0.5),
    p75Bass: percentile(bassValues, 0.75),
    medianAttack: percentile(attackValues, 0.5),
    p75Attack: percentile(attackValues, 0.75),
    medianHigh: percentile(highValues, 0.5),
    p75High: percentile(highValues, 0.75)
  } satisfies SongStructureFeatureStats
}

const resolveTemplateDropCandidateScore = (
  features: readonly SongStructureFeature[],
  index: number,
  stats: SongStructureFeatureStats
) => {
  const current = features[index]
  const previous = features[index - 1]
  if (!current || !previous) return 0
  const progress = stats.durationSec > 0 ? current.startSec / stats.durationSec : 0
  if (index <= 0 || index >= features.length - 1 || progress < 0.12 || progress > 0.9) return 0

  const previousAverage = averageFeatureValues(features, index - 2, index, current)
  const nextAverage = averageFeatureValues(features, index, index + 2, current)
  const sustainedBass = (current.bass + nextAverage.bass) / 2
  const activeEnergy = ramp(
    current.energy,
    Math.max(0.06, stats.p25Energy),
    Math.max(stats.p75Energy, stats.medianEnergy + 0.08)
  )
  const activeBass = ramp(
    current.bass,
    Math.max(0.05, stats.medianBass * 0.9),
    Math.max(stats.p75Bass, 0.18)
  )
  const sustainedBassScore = ramp(
    sustainedBass,
    Math.max(0.05, stats.medianBass * 0.86),
    Math.max(stats.p75Bass, 0.18)
  )
  const bassRise = ramp(current.bass - previousAverage.bass, 0.035, 0.16)
  const immediateBassRise = ramp(current.bass - previous.bass, 0.06, 0.22)
  const lowRise = ramp(current.low - previousAverage.low, 0.045, 0.18)
  const energyRise = ramp(current.energy - previousAverage.energy, 0.04, 0.16)
  const previousReduced =
    1 - ramp(previousAverage.bass, Math.max(0.04, stats.medianBass * 0.58), stats.medianBass)
  const novelty = resolveLocalNovelty(current, previous, previousAverage)
  const positionWeight = 0.62 + ramp(progress, 0.12, 0.24) * (1 - ramp(progress, 0.86, 0.94)) * 0.38

  return clamp01(
    positionWeight *
      (0.08 +
        activeBass * 0.24 +
        sustainedBassScore * 0.16 +
        bassRise * 0.18 +
        immediateBassRise * 0.24 +
        lowRise * 0.06 +
        energyRise * 0.08 +
        activeEnergy * 0.04 +
        previousReduced * 0.12 +
        novelty * 0.04)
  )
}

const resolveTemplateDropCandidates = (
  features: readonly SongStructureFeature[],
  stats: SongStructureFeatureStats
) => {
  const candidates: TemplateDropCandidate[] = []
  for (let index = 0; index < features.length; index += 1) {
    const score = resolveTemplateDropCandidateScore(features, index, stats)
    if (score >= 0.32) candidates.push({ index, score: toFixedNumber(score, 4) })
  }
  return candidates.sort((left, right) => right.score - left.score)
}

const resolveDropPositionPrior = (features: readonly SongStructureFeature[], index: number) => {
  const lastIndex = Math.max(1, features.length - 1)
  const position = index / lastIndex
  const firstDropPrior = 1 - ramp(Math.abs(position - 0.34), 0.08, 0.34)
  const secondDropPrior = 1 - ramp(Math.abs(position - 0.68), 0.08, 0.34)
  return { firstDropPrior, secondDropPrior }
}

const selectTemplateDropIndexes = (
  features: readonly SongStructureFeature[],
  stats: SongStructureFeatureStats
) => {
  const candidates = resolveTemplateDropCandidates(features, stats)
  if (!candidates.length) return []

  const minSpacing = features.length >= 12 ? 4 : 3
  let bestPair: {
    first: TemplateDropCandidate
    second: TemplateDropCandidate
    score: number
  } | null = null
  for (const first of candidates) {
    for (const second of candidates) {
      if (second.index <= first.index || second.index - first.index < minSpacing) continue
      const firstPrior = resolveDropPositionPrior(features, first.index).firstDropPrior
      const secondPrior = resolveDropPositionPrior(features, second.index).secondDropPrior
      const spacingScore = ramp(second.index - first.index, minSpacing, minSpacing + 5)
      const pairScore =
        first.score * 0.62 +
        second.score * 0.62 +
        firstPrior * 0.04 +
        secondPrior * 0.04 +
        spacingScore * 0.04
      if (!bestPair || pairScore > bestPair.score) {
        bestPair = { first, second, score: pairScore }
      }
    }
  }

  if (bestPair && bestPair.first.score >= 0.34 && bestPair.second.score >= 0.34) {
    return [bestPair.first.index, bestPair.second.index]
  }

  const best = candidates[0]
  return best && best.score >= 0.36 ? [best.index] : []
}

const selectFallbackDropIndex = (
  features: readonly SongStructureFeature[],
  stats: SongStructureFeatureStats
) => {
  let best: TemplateDropCandidate | null = null
  for (let index = 1; index < features.length - 1; index += 1) {
    const current = features[index]
    if (!current) continue
    const progress = stats.durationSec > 0 ? current.startSec / stats.durationSec : 0
    if (progress < 0.16 || progress > 0.88) continue
    const previousAverage = averageFeatureValues(features, index - 2, index, current)
    const score = clamp01(
      ramp(current.bass, Math.max(0.05, stats.medianBass * 0.92), Math.max(stats.p75Bass, 0.18)) *
        0.5 +
        ramp(current.energy, stats.medianEnergy, Math.max(stats.p75Energy, 0.16)) * 0.22 +
        ramp(current.bass - previousAverage.bass, 0.025, 0.12) * 0.18 +
        resolveDropPositionPrior(features, index).firstDropPrior * 0.1
    )
    if (!best || score > best.score) best = { index, score }
  }
  return best && best.score >= 0.52 ? best.index : undefined
}

const isDropBodyFeature = (
  feature: SongStructureFeature | undefined,
  stats: SongStructureFeatureStats
) => {
  if (!feature) return false
  const bassFloor = Math.max(stats.medianBass * 0.94, stats.p25Bass + 0.045)
  const energyFloor = Math.max(stats.medianEnergy * 0.84, stats.p25Energy + 0.035)
  return (
    feature.bass >= bassFloor &&
    feature.energy >= energyFloor &&
    (feature.low >= stats.medianLow * 0.84 || feature.bass >= stats.p75Bass * 0.9)
  )
}

const isDropTailFeature = (
  feature: SongStructureFeature | undefined,
  stats: SongStructureFeatureStats
) => {
  if (!feature) return false
  const bassFloor = Math.max(stats.medianBass * 0.82, stats.p25Bass + 0.025)
  const energyFloor = Math.max(stats.medianEnergy * 0.76, stats.p25Energy + 0.025)
  return feature.bass >= bassFloor && feature.energy >= energyFloor
}

const isFinalOutroTailFeature = (
  current: SongStructureFeature,
  previousAverage: SongStructureFeatureValues,
  stats: SongStructureFeatureStats
) => {
  const energyDrop = previousAverage.energy - current.energy
  const bassDrop = previousAverage.bass - current.bass
  const activeButThinned =
    current.energy <= Math.max(stats.medianEnergy * 0.98, stats.p75Energy * 0.9) &&
    current.bass <= Math.max(stats.medianBass * 1.04, stats.p75Bass * 0.86)
  const clearStepDown =
    (energyDrop >= 0.06 && bassDrop >= 0.04) ||
    (bassDrop >= 0.085 && current.energy <= stats.p75Energy)
  return activeButThinned && clearStepDown
}

const resolveDropBlockStartIndex = (
  features: readonly SongStructureFeature[],
  entryIndex: number,
  minIndex: number,
  stats: SongStructureFeatureStats
) => {
  let startIndex = clamp(entryIndex, 0, Math.max(0, features.length - 1))
  for (let index = startIndex - 1; index >= minIndex; index -= 1) {
    const current = features[index]
    const next = features[index + 1]
    if (!current || !next) break
    const strongBuildTension =
      current.bass <= Math.max(stats.p25Bass, stats.medianBass * 0.74) &&
      (current.high >= stats.p75High || current.attack >= stats.p75Attack)
    if (strongBuildTension || !isDropBodyFeature(current, stats)) break
    startIndex = index
  }
  return Math.max(minIndex, startIndex)
}

const createIndexBoundary = (index: number): TemplateBoundary => ({ index })

const createFineBoundary = (
  index: number,
  feature: SongStructureFineFeature
): TemplateBoundary => ({
  index,
  sec: feature.startSec,
  startBar: feature.startBar,
  previousEndBar: Math.max(1, feature.startBar - 1)
})

const resolveDropStartBoundary = (
  features: readonly SongStructureFeature[],
  dropStartIndex: number,
  stats: SongStructureFeatureStats
): TemplateBoundary => {
  const previous = features[dropStartIndex - 1]
  const drop = features[dropStartIndex]
  if (!previous || !drop) return createIndexBoundary(dropStartIndex)

  for (let sliceIndex = 1; sliceIndex < previous.slices.length; sliceIndex += 1) {
    const slice = previous.slices[sliceIndex]
    if (!slice) continue
    const previousSlice = previous.slices[sliceIndex - 1]
    const nextSlice = previous.slices[sliceIndex + 1]
    const previousBass = previousSlice?.bass ?? previous.bass
    const nextBass = nextSlice?.bass ?? drop.bass
    const nextEnergy = nextSlice?.energy ?? drop.energy
    const activeBass = slice.bass >= Math.max(stats.medianBass * 0.92, stats.p25Bass + 0.035)
    const activeEnergy = slice.energy >= Math.max(stats.medianEnergy * 0.78, stats.p25Energy + 0.03)
    const sustained =
      (slice.bass + nextBass) / 2 >= Math.max(stats.medianBass * 0.9, stats.p25Bass + 0.04) &&
      (slice.energy + nextEnergy) / 2 >= Math.max(stats.medianEnergy * 0.76, stats.p25Energy + 0.03)
    const entranceRise =
      slice.bass - previousBass >= 0.08 ||
      slice.energy - (previousSlice?.energy ?? previous.energy) >= 0.06
    const lowCue = slice.low >= stats.medianLow * 0.78 || slice.bass >= stats.p75Bass * 0.86
    const buildRiserOnly =
      slice.bass <= Math.max(stats.p25Bass, stats.medianBass * 0.74) &&
      slice.high >= Math.max(stats.p75High, stats.medianHigh + 0.08)

    if (!buildRiserOnly && activeBass && activeEnergy && sustained && (entranceRise || lowCue)) {
      return createFineBoundary(dropStartIndex - 1, slice)
    }
  }

  return createIndexBoundary(dropStartIndex)
}

const resolveDropBlockEndIndex = (
  features: readonly SongStructureFeature[],
  startIndex: number,
  maxIndex: number,
  stats: SongStructureFeatureStats,
  stopOnFinalOutroTail = false
) => {
  const upper = clamp(maxIndex, startIndex + 1, features.length)
  let endIndex = Math.min(startIndex + 1, upper)
  let softTailCount = 0

  for (let index = startIndex + 1; index < upper; index += 1) {
    const current = features[index]
    if (!current) break
    const previousAverage = averageFeatureValues(features, index - 2, index, current)
    const majorBassDrop =
      previousAverage.bass - current.bass >= 0.14 ||
      current.bass <= Math.max(stats.p25Bass, stats.medianBass * 0.68)
    const body = isDropBodyFeature(current, stats)
    const tail = isDropTailFeature(current, stats)
    if (
      stopOnFinalOutroTail &&
      index - startIndex >= 2 &&
      isFinalOutroTailFeature(current, previousAverage, stats)
    ) {
      break
    }

    if (body || (tail && !majorBassDrop && softTailCount <= 1)) {
      endIndex = index + 1
      softTailCount = body ? 0 : softTailCount + 1
      continue
    }

    if (index - startIndex < 2 && tail) {
      endIndex = index + 1
      softTailCount += 1
      continue
    }

    break
  }

  return clamp(endIndex, startIndex + 1, upper)
}

const resolveBuildStartIndex = (
  features: readonly SongStructureFeature[],
  dropIndex: number,
  minIndex: number,
  stats: SongStructureFeatureStats
) => {
  if (dropIndex <= minIndex) return dropIndex
  const previous = features[dropIndex - 1]
  const drop = features[dropIndex]
  if (!previous || !drop) return dropIndex

  let startIndex = dropIndex - 1
  for (let index = dropIndex - 2; index >= minIndex && dropIndex - index <= 3; index -= 1) {
    const current = features[index]
    const next = features[index + 1]
    if (!current || !next) break
    const brightOrAttack =
      current.high >= Math.max(stats.medianHigh * 0.9, 0.1) ||
      current.attack >= Math.max(stats.medianAttack * 0.94, 0.08)
    const lowBassWithRiser =
      current.bass <= Math.min(stats.p25Bass, stats.medianBass * 0.86) &&
      (next.high - current.high >= 0.1 || next.attack - current.attack >= 0.06)
    const risesToDrop =
      drop.bass - current.bass >= 0.07 ||
      next.bass - current.bass >= 0.035 ||
      drop.energy - current.energy >= 0.06
    if (!(brightOrAttack || lowBassWithRiser) || !risesToDrop) break
    startIndex = index
  }

  return Math.max(minIndex, startIndex)
}

const buildSectionFromRange = (
  features: readonly SongStructureFeature[],
  range: TemplateSectionRange
): SongStructureSection | null => {
  const startIndex = clamp(Math.floor(range.startIndex), 0, features.length)
  const endIndex = clamp(Math.floor(range.endIndex), startIndex, features.length)
  if (endIndex <= startIndex) return null

  const first = features[startIndex]
  const last = features[endIndex - 1]
  if (!first || !last) return null
  const startSec = range.startSec ?? first.startSec
  const endSec = range.endSec ?? last.endSec
  if (endSec <= startSec) return null
  let energy = 0
  let low = 0
  let high = 0
  let novelty = 0
  for (let index = startIndex; index < endIndex; index += 1) {
    const feature = features[index]
    if (!feature) continue
    energy += feature.energy
    low += feature.low
    high += feature.high
    if (index > startIndex) {
      novelty = Math.max(
        novelty,
        resolveFeatureDistance(
          toFeatureValues(feature),
          toFeatureValues(features[index - 1] ?? feature)
        )
      )
    }
  }
  const count = Math.max(1, endIndex - startIndex)
  return {
    startSec: toFixedNumber(startSec, 3),
    endSec: toFixedNumber(endSec, 3),
    startBar: range.startBar ?? first.startBar,
    endBar: range.endBar ?? last.endBar,
    phraseIndex: first.phraseIndex,
    kind: range.kind,
    confidence: toFixedNumber(clamp01(range.confidence), 3),
    energy: toFixedNumber(energy / count, 3),
    low: toFixedNumber(low / count, 3),
    high: toFixedNumber(high / count, 3),
    novelty: toFixedNumber(novelty, 3)
  }
}

const buildTemplateStructureSections = (
  features: readonly SongStructureFeature[],
  stats: SongStructureFeatureStats
) => {
  const selectedDropIndexes = selectTemplateDropIndexes(features, stats)
  const fallbackDropIndex = selectedDropIndexes.length
    ? undefined
    : selectFallbackDropIndex(features, stats)
  const dropIndexes = selectedDropIndexes.length
    ? selectedDropIndexes
    : fallbackDropIndex === undefined
      ? []
      : [fallbackDropIndex]
  if (!dropIndexes.length) return null

  const ranges: TemplateSectionRange[] = []
  const addBoundaryRange = (
    start: TemplateBoundary,
    end: TemplateBoundary,
    kind: SongStructureSectionKind,
    confidence: number
  ) => {
    const startIndex = clamp(Math.floor(start.index), 0, features.length)
    const endIndex = end.sec === undefined ? end.index : end.index + 1
    if (endIndex <= startIndex) return
    ranges.push({
      startIndex,
      endIndex,
      kind,
      confidence,
      startSec: start.sec,
      endSec: end.sec,
      startBar: start.startBar,
      endBar: end.previousEndBar
    })
  }

  const firstDropEntryIndex = dropIndexes[0] ?? 0
  const firstDropStartIndex = resolveDropBlockStartIndex(features, firstDropEntryIndex, 1, stats)
  const firstDropStartBoundary = resolveDropStartBoundary(features, firstDropStartIndex, stats)
  const firstBuildStartIndex = resolveBuildStartIndex(features, firstDropStartIndex, 1, stats)

  if (dropIndexes.length >= 2) {
    const secondDropEntryIndex = dropIndexes[1] ?? firstDropEntryIndex
    const secondDropStartIndex = resolveDropBlockStartIndex(
      features,
      secondDropEntryIndex,
      firstDropStartIndex + 1,
      stats
    )
    const secondDropStartBoundary = resolveDropStartBoundary(features, secondDropStartIndex, stats)
    const secondBuildStartIndex = resolveBuildStartIndex(
      features,
      secondDropStartIndex,
      firstDropStartIndex + 1,
      stats
    )
    const firstDropEndIndex = resolveDropBlockEndIndex(
      features,
      firstDropStartIndex,
      secondBuildStartIndex,
      stats
    )
    const secondDropEndIndex = resolveDropBlockEndIndex(
      features,
      secondDropStartIndex,
      features.length,
      stats,
      true
    )

    addBoundaryRange(
      createIndexBoundary(0),
      createIndexBoundary(firstBuildStartIndex),
      'intro',
      0.78
    )
    addBoundaryRange(
      createIndexBoundary(firstBuildStartIndex),
      firstDropStartBoundary,
      'build',
      0.78
    )
    addBoundaryRange(firstDropStartBoundary, createIndexBoundary(firstDropEndIndex), 'drop', 0.84)
    addBoundaryRange(
      createIndexBoundary(firstDropEndIndex),
      createIndexBoundary(secondBuildStartIndex),
      'breakdown',
      0.78
    )
    addBoundaryRange(
      createIndexBoundary(secondBuildStartIndex),
      secondDropStartBoundary,
      'build',
      0.8
    )
    addBoundaryRange(secondDropStartBoundary, createIndexBoundary(secondDropEndIndex), 'drop', 0.86)
    addBoundaryRange(
      createIndexBoundary(secondDropEndIndex),
      createIndexBoundary(features.length),
      'outro',
      0.76
    )
  } else {
    const firstDropEndIndex = resolveDropBlockEndIndex(
      features,
      firstDropStartIndex,
      features.length,
      stats,
      true
    )
    addBoundaryRange(
      createIndexBoundary(0),
      createIndexBoundary(firstBuildStartIndex),
      'intro',
      0.76
    )
    addBoundaryRange(
      createIndexBoundary(firstBuildStartIndex),
      firstDropStartBoundary,
      'build',
      0.78
    )
    addBoundaryRange(firstDropStartBoundary, createIndexBoundary(firstDropEndIndex), 'drop', 0.84)
    addBoundaryRange(
      createIndexBoundary(firstDropEndIndex),
      createIndexBoundary(features.length),
      'outro',
      0.74
    )
  }

  const sections = ranges
    .map((range) => buildSectionFromRange(features, range))
    .filter((section): section is SongStructureSection => section !== null)

  return sections.length ? sections.slice(0, MAX_SECTIONS) : null
}

export const buildSongStructureAnalysisCore = (
  input: BuildSongStructureInput
): SongStructureAnalysis | null => {
  const waveformData = input.waveformData
  const grid = normalizeStructureGrid(input)
  if (!waveformData || !grid) return null
  const durationSec = Math.max(0, Number(waveformData.duration) || 0)
  const detailFrames = waveformData.height?.length || 0
  if (durationSec <= 0 || detailFrames <= 0) return null

  const boundaries = buildPhraseBoundaries(
    durationSec,
    grid.bpm,
    grid.firstBeatMs,
    grid.barBeatOffset
  )
  if (boundaries.length < 2) return null

  const features = buildFeatures(
    waveformData,
    boundaries,
    grid.bpm,
    grid.firstBeatMs,
    grid.barBeatOffset
  )
  if (!features.length) return null

  const stats = buildStats(features, durationSec)
  const templateSections = buildTemplateStructureSections(features, stats)
  const algorithmicCandidate = buildAlgorithmicSongStructureSections(
    waveformData,
    durationSec,
    grid.bpm,
    grid.firstBeatMs,
    grid.barBeatOffset,
    templateSections ?? undefined
  )
  const sections = algorithmicCandidate?.sections ?? templateSections
  if (!sections?.length) return null

  return {
    algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
    source: 'algorithmic',
    durationSec: toFixedNumber(durationSec, 3),
    bpm: grid.bpm,
    firstBeatMs: grid.firstBeatMs,
    barBeatOffset: grid.barBeatOffset,
    phraseBars: PHRASE_BARS,
    sections
  }
}
