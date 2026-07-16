import {
  createSongBeatGridMapFromFixedGrid,
  createSongBeatGridRuntime,
  type SongBeatGridLine,
  type SongBeatGridRuntime
} from './songBeatGridMap'
import {
  createUnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridRuntime
} from './songBeatGridRuntime'
import {
  clamp,
  clamp01,
  normalizeStructureGrid,
  percentile,
  readByteRatio,
  type BuildSongStructureInput
} from './songStructureCommon'
import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import type { BuildSongStructureV23Input } from './songStructureV23Common'
import {
  isValidSongStructureFeatureData,
  type SongStructureFeatureData
} from './songStructureFeatureData'

const PULSE_BINS = 16
const MIN_BAR_DURATION_SEC = 0.02
const BOUNDARY_EPSILON_SEC = 0.001
const ACTIVE_ATTACK_FLOOR = 9 / 255

export const SONG_STRUCTURE_SPECTRAL_VALUE_KEYS = [
  'energy',
  'low',
  'mid',
  'high',
  'attack',
  'attackDensity',
  'density',
  'brightness',
  'crest',
  'lowShare',
  'midShare',
  'highShare'
] as const

export type SongStructureSpectralValueKey = (typeof SONG_STRUCTURE_SPECTRAL_VALUE_KEYS)[number]

export type SongStructureSpectralValues = Record<SongStructureSpectralValueKey, number>

export type SongStructureBarSpan = {
  index: number
  startSec: number
  endSec: number
  startBar: number
  phraseIndex: number
  hasPeriodicStructurePrior: boolean
  isClipBoundary: boolean
  clipIndex: number
}

export type SongStructureSpectralBarFeature = SongStructureBarSpan & {
  values: SongStructureSpectralValues
  normalized: SongStructureSpectralValues
  pulseAttack: number[]
  pulseHigh: number[]
  localVector: number[]
  recurrenceVector: number[]
}

export type SongStructureSpectralFeatureSet = {
  bars: SongStructureSpectralBarFeature[]
  beatGridSignature?: string
}

type BoundarySeed = {
  sec: number
  hasPeriodicStructurePrior: boolean
  isClipBoundary: boolean
  clipIndex: number
}

type RawBarFeature = SongStructureBarSpan & {
  values: SongStructureSpectralValues
  pulseAttack: number[]
  pulseHigh: number[]
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

const normalizeBoundarySec = (value: number) => Number(Math.max(0, value).toFixed(6))

const mergeBoundarySeed = (target: BoundarySeed[], seed: BoundarySeed) => {
  const existing = target.find((item) => Math.abs(item.sec - seed.sec) <= BOUNDARY_EPSILON_SEC)
  if (!existing) {
    target.push(seed)
    return
  }
  existing.hasPeriodicStructurePrior ||= seed.hasPeriodicStructurePrior
  existing.isClipBoundary ||= seed.isClipBoundary
  if (seed.isClipBoundary) existing.clipIndex = seed.clipIndex
}

const toBoundarySeed = (line: SongBeatGridLine, durationSec: number): BoundarySeed | null => {
  if (line.level !== 'bar' && line.level !== 'beat4') return null
  if (line.sec <= BOUNDARY_EPSILON_SEC || line.sec >= durationSec - BOUNDARY_EPSILON_SEC) {
    return null
  }
  return {
    sec: normalizeBoundarySec(line.sec),
    hasPeriodicStructurePrior: line.level === 'bar',
    isClipBoundary: false,
    clipIndex: line.clipIndex
  }
}

const buildRuntime = (
  input: BuildSongStructureInput,
  durationSec: number
): { runtime: SongBeatGridRuntime; dynamic: boolean } | null => {
  const dynamicRuntime = createSongBeatGridRuntime(input.beatGridMap, durationSec)
  if (dynamicRuntime) {
    return {
      runtime: dynamicRuntime,
      dynamic: true
    }
  }
  const grid = normalizeStructureGrid(input)
  if (!grid) return null
  const fixedMap = createSongBeatGridMapFromFixedGrid(grid)
  const fixedRuntime = createSongBeatGridRuntime(fixedMap, durationSec)
  return fixedRuntime
    ? {
        runtime: fixedRuntime,
        dynamic: false
      }
    : null
}

const compactBoundarySeeds = (
  seeds: readonly BoundarySeed[],
  durationSec: number
): BoundarySeed[] => {
  const result: BoundarySeed[] = []
  for (const seed of [...seeds].sort((left, right) => left.sec - right.sec)) {
    const previous = result[result.length - 1]
    if (!previous || seed.sec - previous.sec >= MIN_BAR_DURATION_SEC) {
      result.push({ ...seed })
      continue
    }
    if (seed.sec >= durationSec - BOUNDARY_EPSILON_SEC) {
      result[result.length - 1] = {
        ...seed,
        hasPeriodicStructurePrior:
          previous.hasPeriodicStructurePrior || seed.hasPeriodicStructurePrior,
        isClipBoundary: previous.isClipBoundary || seed.isClipBoundary
      }
      continue
    }
    previous.hasPeriodicStructurePrior ||= seed.hasPeriodicStructurePrior
    previous.isClipBoundary ||= seed.isClipBoundary
  }
  return result
}

const attachClipBoundaryPriors = (
  seeds: BoundarySeed[],
  runtime: Pick<SongBeatGridRuntime | UnifiedSongBeatGridRuntime, 'clips'>,
  durationSec: number
) => {
  const candidates = seeds.filter(
    (seed) => seed.sec > BOUNDARY_EPSILON_SEC && seed.sec < durationSec - BOUNDARY_EPSILON_SEC
  )
  for (let clipIndex = 1; clipIndex < runtime.clips.length; clipIndex += 1) {
    const clip = runtime.clips[clipIndex]
    if (!clip || !candidates.length) continue
    const nearest = [...candidates].sort((left, right) => {
      const leftDistance = Math.abs(left.sec - clip.startSec)
      const rightDistance = Math.abs(right.sec - clip.startSec)
      if (Math.abs(leftDistance - rightDistance) > BOUNDARY_EPSILON_SEC) {
        return leftDistance - rightDistance
      }
      return Number(right.sec >= clip.startSec) - Number(left.sec >= clip.startSec)
    })[0]
    if (!nearest) continue
    nearest.isClipBoundary = true
  }
}

const finalizeBarSpans = (
  seeds: BoundarySeed[],
  runtime: Pick<SongBeatGridRuntime | UnifiedSongBeatGridRuntime, 'clips'>,
  durationSec: number
): SongStructureBarSpan[] => {
  mergeBoundarySeed(seeds, {
    sec: normalizeBoundarySec(durationSec),
    hasPeriodicStructurePrior: false,
    isClipBoundary: false,
    clipIndex: Math.max(0, runtime.clips.length - 1)
  })
  const compactedSeeds = compactBoundarySeeds(seeds, durationSec)
  attachClipBoundaryPriors(compactedSeeds, runtime, durationSec)

  const spans: SongStructureBarSpan[] = []
  let phraseIndex = 0
  for (let index = 0; index < compactedSeeds.length - 1; index += 1) {
    const start = compactedSeeds[index]
    const end = compactedSeeds[index + 1]
    if (!start || !end || end.sec <= start.sec) continue
    if (spans.length > 0 && start.hasPeriodicStructurePrior) phraseIndex += 1
    spans.push({
      index: spans.length,
      startSec: start.sec,
      endSec: end.sec,
      startBar: spans.length + 1,
      phraseIndex,
      hasPeriodicStructurePrior: start.hasPeriodicStructurePrior,
      isClipBoundary: start.isClipBoundary,
      clipIndex: start.clipIndex
    })
  }
  const typicalBarSec = percentile(
    spans.map((span) => span.endSec - span.startSec).filter((duration) => duration >= 0.25),
    0.5
  )
  if (
    spans.length > 1 &&
    typicalBarSec > 0 &&
    (spans[0]?.endSec ?? 0) - (spans[0]?.startSec ?? 0) < typicalBarSec * 0.35
  ) {
    spans[1]!.startSec = 0
    spans.shift()
  }
  const last = spans[spans.length - 1]
  const previous = spans[spans.length - 2]
  if (last && previous && typicalBarSec > 0 && last.endSec - last.startSec < typicalBarSec * 0.35) {
    previous.endSec = durationSec
    spans.pop()
  }
  const firstPhraseIndex = spans[0]?.phraseIndex ?? 0
  return spans.map((span, index) => ({
    ...span,
    index,
    startBar: index + 1,
    phraseIndex: Math.max(0, span.phraseIndex - firstPhraseIndex)
  }))
}

const buildBarSpans = (
  runtime: SongBeatGridRuntime,
  durationSec: number
): SongStructureBarSpan[] => {
  const seeds: BoundarySeed[] = [
    {
      sec: 0,
      hasPeriodicStructurePrior: runtime.lines.some(
        (line) => line.level === 'bar' && Math.abs(line.sec) <= BOUNDARY_EPSILON_SEC
      ),
      isClipBoundary: false,
      clipIndex: 0
    }
  ]

  for (const line of runtime.lines) {
    const seed = toBoundarySeed(line, durationSec)
    if (seed) mergeBoundarySeed(seeds, seed)
  }
  return finalizeBarSpans(seeds, runtime, durationSec)
}

const buildV23DownbeatSpans = (
  runtime: UnifiedSongBeatGridRuntime,
  durationSec: number
): SongStructureBarSpan[] => {
  const seeds: BoundarySeed[] = [
    {
      sec: 0,
      hasPeriodicStructurePrior: false,
      isClipBoundary: false,
      clipIndex: 0
    }
  ]
  for (const line of runtime.lines) {
    if (line.level !== 'downbeat') continue
    if (line.sec <= BOUNDARY_EPSILON_SEC || line.sec >= durationSec - BOUNDARY_EPSILON_SEC) {
      continue
    }
    mergeBoundarySeed(seeds, {
      sec: normalizeBoundarySec(line.sec),
      hasPeriodicStructurePrior: false,
      isClipBoundary: false,
      clipIndex: line.clipIndex
    })
  }
  return finalizeBarSpans(seeds, runtime, durationSec)
}

const normalizePulse = (values: readonly number[]) => {
  if (!values.length) return []
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const centered = values.map((value) => value - mean)
  const norm = Math.sqrt(centered.reduce((total, value) => total + value * value, 0))
  if (norm <= 1e-8) return values.map(() => 0)
  return centered.map((value) => value / norm)
}

const summarizeBar = (
  data: UnifiedDisplayWaveformDetailData,
  span: SongStructureBarSpan
): RawBarFeature => {
  const detailRate = Math.max(1, Number(data.detailRate) || 1)
  const frameLength = Math.max(
    0,
    Math.min(
      data.height?.length || 0,
      data.attack?.length || 0,
      data.colorLow?.length || 0,
      data.colorMid?.length || 0,
      data.colorHigh?.length || 0
    )
  )
  const pulseAttack = new Array(PULSE_BINS).fill(0)
  const pulseHigh = new Array(PULSE_BINS).fill(0)
  const pulseCounts = new Array(PULSE_BINS).fill(0)
  if (frameLength <= 0) {
    return {
      ...span,
      values: createEmptyValues(),
      pulseAttack,
      pulseHigh
    }
  }

  const startFrame = clamp(Math.floor(span.startSec * detailRate), 0, frameLength - 1)
  const endFrame = clamp(Math.ceil(span.endSec * detailRate), startFrame + 1, frameLength)
  const durationSec = Math.max(0.0001, span.endSec - span.startSec)
  let energySum = 0
  let lowSum = 0
  let midSum = 0
  let highSum = 0
  let attackSum = 0
  let lowShareSum = 0
  let midShareSum = 0
  let highShareSum = 0
  let energyPeak = 0
  let activeAttackCount = 0

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const energy = readByteRatio(data.height, frame)
    const attack = readByteRatio(data.attack, frame)
    const colorLow = readByteRatio(data.colorLow, frame)
    const colorMid = readByteRatio(data.colorMid, frame)
    const colorHigh = readByteRatio(data.colorHigh, frame)
    const low = Math.sqrt(energy * colorLow)
    const mid = Math.sqrt(energy * colorMid)
    const high = Math.sqrt(energy * colorHigh)
    const bandTotal = Math.max(0.0001, low + mid + high)
    const frameSec = frame / detailRate
    const pulseIndex = clamp(
      Math.floor(((frameSec - span.startSec) / durationSec) * PULSE_BINS),
      0,
      PULSE_BINS - 1
    )

    energySum += energy
    lowSum += low
    midSum += mid
    highSum += high
    attackSum += attack
    lowShareSum += low / bandTotal
    midShareSum += mid / bandTotal
    highShareSum += high / bandTotal
    energyPeak = Math.max(energyPeak, energy)
    if (attack >= ACTIVE_ATTACK_FLOOR) activeAttackCount += 1
    pulseAttack[pulseIndex] += attack
    pulseHigh[pulseIndex] += high * (0.35 + attack * 0.65)
    pulseCounts[pulseIndex] += 1
  }

  const count = Math.max(1, endFrame - startFrame)
  const energyMean = energySum / count
  const low = lowSum / count
  const mid = midSum / count
  const high = highSum / count
  const attack = attackSum / count
  const attackDensity = activeAttackCount / count
  const density = clamp01(
    energyMean * 0.24 + low * 0.2 + mid * 0.18 + high * 0.12 + attack * 0.14 + attackDensity * 0.12
  )
  const bandTotal = Math.max(0.0001, low + mid + high)
  for (let index = 0; index < PULSE_BINS; index += 1) {
    const pulseCount = Math.max(1, pulseCounts[index] ?? 0)
    pulseAttack[index] = (pulseAttack[index] ?? 0) / pulseCount
    pulseHigh[index] = (pulseHigh[index] ?? 0) / pulseCount
  }

  return {
    ...span,
    values: {
      energy: clamp01(energyMean * 0.78 + energyPeak * 0.22),
      low: clamp01(low),
      mid: clamp01(mid),
      high: clamp01(high),
      attack: clamp01(attack),
      attackDensity: clamp01(attackDensity),
      density,
      brightness: clamp01((mid * 0.36 + high * 0.78) / bandTotal),
      crest: clamp01(energyPeak - energyMean),
      lowShare: clamp01(lowShareSum / count),
      midShare: clamp01(midShareSum / count),
      highShare: clamp01(highShareSum / count)
    },
    pulseAttack: normalizePulse(pulseAttack),
    pulseHigh: normalizePulse(pulseHigh)
  }
}

const summarizeAbsoluteBar = (
  data: SongStructureFeatureData,
  span: SongStructureBarSpan
): RawBarFeature => {
  const frameRate = Math.max(1, Number(data.frameRate) || 1)
  const frameLength = Math.min(
    data.bands.all.body.length,
    data.bands.all.peak.length,
    data.bands.all.onset.length,
    data.bands.low.body.length,
    data.bands.low.peak.length,
    data.bands.low.onset.length,
    data.bands.mid.body.length,
    data.bands.mid.peak.length,
    data.bands.mid.onset.length,
    data.bands.high.body.length,
    data.bands.high.peak.length,
    data.bands.high.onset.length
  )
  const pulseAttack = new Array(PULSE_BINS).fill(0)
  const pulseHigh = new Array(PULSE_BINS).fill(0)
  const pulseCounts = new Array(PULSE_BINS).fill(0)
  if (frameLength <= 0) {
    return {
      ...span,
      values: createEmptyValues(),
      pulseAttack,
      pulseHigh
    }
  }

  const startFrame = clamp(Math.floor(span.startSec * frameRate), 0, frameLength - 1)
  const endFrame = clamp(Math.ceil(span.endSec * frameRate), startFrame + 1, frameLength)
  const durationSec = Math.max(0.0001, span.endSec - span.startSec)
  const readBandValue = (key: 'low' | 'mid' | 'high' | 'all', frame: number) => {
    const band = data.bands[key]
    const body = readByteRatio(band.body, frame)
    const peak = readByteRatio(band.peak, frame)
    const peakWeight = key === 'all' ? 0.15 : 0.22
    return clamp01(body * (1 - peakWeight) + peak * peakWeight)
  }
  const readBandOnset = (key: 'low' | 'mid' | 'high' | 'all', frame: number) =>
    readByteRatio(data.bands[key].onset, frame)
  let previousEnergy = readBandValue('all', Math.max(0, startFrame - 1))
  let previousLow = readBandValue('low', Math.max(0, startFrame - 1))
  let previousMid = readBandValue('mid', Math.max(0, startFrame - 1))
  let previousHigh = readBandValue('high', Math.max(0, startFrame - 1))
  let energySum = 0
  let lowSum = 0
  let midSum = 0
  let highSum = 0
  let attackSum = 0
  let lowShareSum = 0
  let midShareSum = 0
  let highShareSum = 0
  let crestSum = 0
  let energyPeak = 0
  let activeAttackCount = 0

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const energy = readBandValue('all', frame)
    const low = readBandValue('low', frame)
    const mid = readBandValue('mid', frame)
    const high = readBandValue('high', frame)
    const energyFlux = Math.max(0, energy - previousEnergy)
    const lowFlux = Math.max(0, low - previousLow)
    const midFlux = Math.max(0, mid - previousMid)
    const highFlux = Math.max(0, high - previousHigh)
    const onset = clamp01(
      readBandOnset('all', frame) * 0.18 +
        readBandOnset('low', frame) * 0.2 +
        readBandOnset('mid', frame) * 0.28 +
        readBandOnset('high', frame) * 0.34
    )
    const attack = clamp01(
      onset * 1.8 + (energyFlux * 0.22 + lowFlux * 0.2 + midFlux * 0.27 + highFlux * 0.31) * 2.2
    )
    const bandTotal = Math.max(0.0001, low + mid + high)
    const frameSec = frame / frameRate
    const pulseIndex = clamp(
      Math.floor(((frameSec - span.startSec) / durationSec) * PULSE_BINS),
      0,
      PULSE_BINS - 1
    )

    energySum += energy
    lowSum += low
    midSum += mid
    highSum += high
    attackSum += attack
    lowShareSum += low / bandTotal
    midShareSum += mid / bandTotal
    highShareSum += high / bandTotal
    crestSum += Math.max(
      0,
      readByteRatio(data.bands.all.peak, frame) - readByteRatio(data.bands.all.body, frame)
    )
    energyPeak = Math.max(energyPeak, energy)
    if (attack >= ACTIVE_ATTACK_FLOOR) activeAttackCount += 1
    pulseAttack[pulseIndex] += attack
    pulseHigh[pulseIndex] += high * (0.3 + attack * 0.55) + readBandOnset('high', frame) * 0.15
    pulseCounts[pulseIndex] += 1

    previousEnergy = energy
    previousLow = low
    previousMid = mid
    previousHigh = high
  }

  const count = Math.max(1, endFrame - startFrame)
  const energyMean = energySum / count
  const low = lowSum / count
  const mid = midSum / count
  const high = highSum / count
  const attack = attackSum / count
  const attackDensity = activeAttackCount / count
  const density = clamp01(
    energyMean * 0.22 + low * 0.2 + mid * 0.2 + high * 0.12 + attack * 0.14 + attackDensity * 0.12
  )
  const bandTotal = Math.max(0.0001, low + mid + high)
  for (let index = 0; index < PULSE_BINS; index += 1) {
    const pulseCount = Math.max(1, pulseCounts[index] ?? 0)
    pulseAttack[index] = (pulseAttack[index] ?? 0) / pulseCount
    pulseHigh[index] = (pulseHigh[index] ?? 0) / pulseCount
  }

  return {
    ...span,
    values: {
      energy: clamp01(energyMean * 0.78 + energyPeak * 0.22),
      low: clamp01(low),
      mid: clamp01(mid),
      high: clamp01(high),
      attack: clamp01(attack),
      attackDensity: clamp01(attackDensity),
      density,
      brightness: clamp01((mid * 0.34 + high * 0.82) / bandTotal),
      crest: clamp01(crestSum / count),
      lowShare: clamp01(lowShareSum / count),
      midShare: clamp01(midShareSum / count),
      highShare: clamp01(highShareSum / count)
    },
    pulseAttack: normalizePulse(pulseAttack),
    pulseHigh: normalizePulse(pulseHigh)
  }
}

const buildNormalizedValues = (bars: readonly RawBarFeature[]): SongStructureSpectralValues[] => {
  const result = bars.map(() => createEmptyValues())
  for (const key of SONG_STRUCTURE_SPECTRAL_VALUE_KEYS) {
    const values = bars.map((bar) => bar.values[key])
    const median = percentile(values, 0.5)
    const deviations = values.map((value) => Math.abs(value - median))
    const mad = percentile(deviations, 0.5)
    const spread = percentile(values, 0.9) - percentile(values, 0.1)
    const scale = Math.max(mad * 1.4826, spread * 0.12, 0.012)
    for (let index = 0; index < bars.length; index += 1) {
      result[index]![key] = clamp((values[index]! - median) / scale, -4, 4) / 4
    }
  }
  return result
}

const buildLocalVector = (
  current: SongStructureSpectralValues,
  previous: SongStructureSpectralValues | undefined
) => {
  const prior = previous ?? current
  return [
    current.energy * 0.78,
    current.low * 0.9,
    current.mid * 1.08,
    current.high,
    current.attack,
    current.attackDensity,
    current.density,
    current.brightness * 0.8,
    current.crest * 0.55,
    current.lowShare * 0.7,
    current.midShare * 0.85,
    current.highShare * 0.85,
    (current.energy - prior.energy) * 0.72,
    (current.low - prior.low) * 0.82,
    (current.mid - prior.mid) * 1.05,
    (current.high - prior.high) * 0.95,
    (current.attackDensity - prior.attackDensity) * 0.95,
    (current.density - prior.density) * 0.9
  ]
}

const buildRecurrenceVector = (
  current: SongStructureSpectralValues,
  previous: SongStructureSpectralValues | undefined,
  pulseAttack: readonly number[],
  pulseHigh: readonly number[]
) => {
  const prior = previous ?? current
  return [
    current.energy * 0.45,
    current.low * 0.8,
    current.mid,
    current.high * 0.9,
    current.attackDensity * 0.85,
    current.density * 0.75,
    current.brightness * 0.7,
    current.lowShare * 0.75,
    current.midShare * 0.85,
    current.highShare * 0.85,
    prior.low * 0.35,
    prior.mid * 0.45,
    prior.high * 0.4,
    prior.attackDensity * 0.35,
    ...pulseAttack.map((value) => value * 0.55),
    ...pulseHigh.map((value) => value * 0.45)
  ]
}

const buildSpectralFeaturesFromSpans = (
  data: UnifiedDisplayWaveformDetailData | null | undefined,
  structureFeatureDataInput: SongStructureFeatureData | null | undefined,
  spans: readonly SongStructureBarSpan[],
  beatGridSignature?: string
): SongStructureSpectralFeatureSet | null => {
  const structureFeatureData = isValidSongStructureFeatureData(structureFeatureDataInput)
    ? structureFeatureDataInput
    : null
  if (!data && !structureFeatureData) return null
  if (spans.length < 8) return null
  const rawBars = structureFeatureData
    ? spans.map((span) => summarizeAbsoluteBar(structureFeatureData, span))
    : spans.map((span) => summarizeBar(data!, span))
  const normalizedBars = buildNormalizedValues(rawBars)
  const bars = rawBars.map((bar, index): SongStructureSpectralBarFeature => {
    const normalized = normalizedBars[index] ?? createEmptyValues()
    const previous = normalizedBars[index - 1]
    return {
      ...bar,
      normalized,
      localVector: buildLocalVector(normalized, previous),
      recurrenceVector: buildRecurrenceVector(normalized, previous, bar.pulseAttack, bar.pulseHigh)
    }
  })
  return { bars, beatGridSignature }
}

export const buildSongStructureSpectralFeatures = (
  input: BuildSongStructureInput,
  durationSec: number
): SongStructureSpectralFeatureSet | null => {
  const data = input.waveformData
  if ((!data && !input.structureFeatureData) || durationSec <= 0) return null
  const runtimeResult = buildRuntime(input, durationSec)
  if (!runtimeResult) return null
  const spans = buildBarSpans(runtimeResult.runtime, durationSec)
  return buildSpectralFeaturesFromSpans(
    data,
    input.structureFeatureData,
    spans,
    runtimeResult.dynamic ? runtimeResult.runtime.signature : undefined
  )
}

export const buildSongStructureV23SpectralFeatures = (
  input: BuildSongStructureV23Input,
  durationSec: number
): SongStructureSpectralFeatureSet | null => {
  if (durationSec <= 0) return null
  const runtime = createUnifiedSongBeatGridRuntime(input.beatGridMap, durationSec)
  if (!runtime) return null
  const spans = buildV23DownbeatSpans(runtime, durationSec)
  return buildSpectralFeaturesFromSpans(
    input.waveformData,
    input.structureFeatureData,
    spans,
    runtime.signature
  )
}

export const cosineSimilarity = (left: readonly number[], right: readonly number[]) => {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (leftNorm <= 1e-12 && rightNorm <= 1e-12) return 1
  if (leftNorm <= 1e-12 || rightNorm <= 1e-12) return 0
  return clamp(dot / Math.sqrt(leftNorm * rightNorm), -1, 1)
}
