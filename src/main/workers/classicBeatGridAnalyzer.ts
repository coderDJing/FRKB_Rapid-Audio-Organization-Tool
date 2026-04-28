import type { BeatGridAnalyzeParams, BeatGridAnalyzeResult } from './beatGridAnalyzerTypes'

const DEFAULT_MAX_SCAN_SEC = 120
const FRAME_SIZE = 256
const HOP_SIZE = 128
const MIN_BPM = 55
const MAX_BPM = 210
const MIN_DURATION_SEC = 8
const PHASE_PEAK_RADIUS_FRAMES = 5
const MAX_TEMPO_CANDIDATES = 14
const MAX_PHASE_CANDIDATES_PER_TEMPO = 8

type TempoCandidate = {
  bpm: number
  lagFrames: number
  score: number
}

type PhaseSeed = {
  phaseFrame: number
  score: number
}

type GridScore = {
  phaseFrame: number
  phaseMs: number
  score: number
  beatCount: number
  hitCount: number
  meanBeatStrength: number
  medianErrorFrames: number
  coverageScore: number
  consistencyScore: number
  midpointPenalty: number
  downbeatOffset: number
  downbeatScore: number
}

type ClassicGridLineAnalysis = {
  bpm: number
  rawBpm: number
  firstBeatMs: number
  rawFirstBeatMs: number
  barBeatOffset: number
  beatCount: number
  downbeatCount: number
  durationSec: number
  beatIntervalSec: number
  tempoScore: number
  gridScore: GridScore
  qualityScore: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

const percentile = (values: number[], ratio: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * clamp01(ratio)))
  )
  return sorted[index]
}

const resolveFloatSamples = (pcmData: Buffer) => {
  const usableBytes = pcmData.byteLength - (pcmData.byteLength % 4)
  if (usableBytes <= 0) return new Float32Array()
  return new Float32Array(pcmData.buffer, pcmData.byteOffset, usableBytes / 4)
}

const buildOnsetEnvelope = (
  samples: Float32Array,
  channels: number,
  usableFrames: number
): Float64Array => {
  const frameCount = Math.floor((usableFrames - FRAME_SIZE) / HOP_SIZE) + 1
  if (frameCount <= 4) return new Float64Array()

  const energy = new Float64Array(frameCount)
  const highEnergy = new Float64Array(frameCount)
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameStart = frameIndex * HOP_SIZE
    let sum = 0
    let highSum = 0
    let previousMono = 0
    for (let offset = 0; offset < FRAME_SIZE; offset += 1) {
      const sampleFrame = frameStart + offset
      const sampleBase = sampleFrame * channels
      let mono = 0
      for (let channel = 0; channel < channels; channel += 1) {
        mono += samples[sampleBase + channel] || 0
      }
      mono /= channels
      sum += mono * mono
      const delta = offset === 0 ? 0 : mono - previousMono
      highSum += delta * delta
      previousMono = mono
    }
    energy[frameIndex] = Math.log1p((sum / FRAME_SIZE) * 10000)
    highEnergy[frameIndex] = Math.log1p((highSum / FRAME_SIZE) * 10000)
  }

  const onset = new Float64Array(frameCount)
  for (let index = 1; index < frameCount; index += 1) {
    const energyBase = Math.max(energy[index - 1], index > 1 ? energy[index - 2] * 0.96 : 0)
    const highBase = Math.max(highEnergy[index - 1], index > 1 ? highEnergy[index - 2] * 0.94 : 0)
    onset[index] =
      Math.max(0, energy[index] - energyBase) + Math.max(0, highEnergy[index] - highBase) * 0.8
  }

  const positive = Array.from(onset).filter((value) => value > 0)
  const floor = percentile(positive, 0.45) * 0.55
  let sum = 0
  let squared = 0
  for (let index = 0; index < onset.length; index += 1) {
    const value = Math.max(0, onset[index] - floor)
    onset[index] = value
    sum += value
    squared += value * value
  }

  const mean = sum / onset.length
  const variance = Math.max(0, squared / onset.length - mean * mean)
  const scale = Math.sqrt(variance) || mean || 1
  for (let index = 0; index < onset.length; index += 1) {
    const normalized = Math.max(0, (onset[index] - mean * 0.3) / scale)
    onset[index] = Math.sqrt(normalized)
  }
  return onset
}

const normalizedCorrelation = (envelope: Float64Array, lag: number) => {
  if (lag <= 1 || lag >= envelope.length) return 0
  let numerator = 0
  let leftEnergy = 0
  let rightEnergy = 0
  for (let index = lag; index < envelope.length; index += 1) {
    const left = envelope[index]
    const right = envelope[index - lag]
    numerator += left * right
    leftEnergy += left * left
    rightEnergy += right * right
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy)
  return denominator > 0 ? numerator / denominator : 0
}

const scoreTempoLag = (envelope: Float64Array, lag: number) => {
  const direct = normalizedCorrelation(envelope, lag)
  const double = lag * 2 < envelope.length ? normalizedCorrelation(envelope, lag * 2) : 0
  const triple = lag * 3 < envelope.length ? normalizedCorrelation(envelope, lag * 3) : 0
  const half = lag > 3 ? normalizedCorrelation(envelope, Math.max(2, Math.round(lag / 2))) : 0
  return direct + double * 0.48 + triple * 0.18 - half * 0.1
}

const addTempoCandidate = (candidates: TempoCandidate[], candidate: TempoCandidate) => {
  if (!Number.isFinite(candidate.bpm) || candidate.bpm < MIN_BPM || candidate.bpm > MAX_BPM) return
  if (candidates.some((item) => Math.abs(item.bpm - candidate.bpm) < 0.35)) return
  candidates.push(candidate)
}

const estimateTempoCandidates = (envelope: Float64Array, hopSec: number) => {
  const minLag = Math.max(2, Math.floor(60 / MAX_BPM / hopSec))
  const maxLag = Math.min(envelope.length - 2, Math.ceil(60 / MIN_BPM / hopSec))
  const scored: Array<{ lag: number; score: number }> = []

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = scoreTempoLag(envelope, lag)
    if (score <= 0) continue
    scored.push({ lag, score })
  }

  scored.sort((left, right) => right.score - left.score)
  const candidates: TempoCandidate[] = []
  for (const item of scored.slice(0, 28)) {
    const previousScore = scoreTempoLag(envelope, item.lag - 1)
    const nextScore = scoreTempoLag(envelope, item.lag + 1)
    const denominator = previousScore - item.score * 2 + nextScore
    const delta =
      Math.abs(denominator) > 0.000001
        ? Math.max(-0.45, Math.min(0.45, (previousScore - nextScore) / (2 * denominator)))
        : 0
    const lagFrames = Math.max(2, item.lag + delta)
    const bpm = 60 / (lagFrames * hopSec)
    addTempoCandidate(candidates, { bpm, lagFrames, score: item.score })

    if (bpm < 105) {
      addTempoCandidate(candidates, {
        bpm: bpm * 2,
        lagFrames: lagFrames / 2,
        score: item.score * 0.94
      })
    }
    if (bpm > 135) {
      addTempoCandidate(candidates, {
        bpm: bpm / 2,
        lagFrames: lagFrames * 2,
        score: item.score * 0.82
      })
    }
    if (candidates.length >= MAX_TEMPO_CANDIDATES) break
  }
  candidates.sort((left, right) => right.score - left.score)
  return candidates
}

const sampleEnvelope = (envelope: Float64Array, frameIndex: number) => {
  const index = Math.round(frameIndex)
  if (index < 0 || index >= envelope.length) return 0
  return envelope[index]
}

const localPeak = (envelope: Float64Array, centerFrame: number, radius: number) => {
  let bestFrame = Math.round(centerFrame)
  let bestValue = 0
  const start = Math.max(0, Math.floor(centerFrame - radius))
  const end = Math.min(envelope.length - 1, Math.ceil(centerFrame + radius))
  for (let frame = start; frame <= end; frame += 1) {
    const value = envelope[frame]
    if (value > bestValue) {
      bestValue = value
      bestFrame = frame
    }
  }
  return { frame: bestFrame, value: bestValue, offset: bestFrame - centerFrame }
}

const scorePhaseSeed = (
  envelope: Float64Array,
  lagFrames: number,
  phaseFrame: number,
  hitThreshold: number
): PhaseSeed => {
  let strength = 0
  let hits = 0
  let beats = 0
  let midpointStrength = 0
  for (let beatFrame = phaseFrame; beatFrame < envelope.length; beatFrame += lagFrames) {
    const peak = localPeak(envelope, beatFrame, PHASE_PEAK_RADIUS_FRAMES)
    strength += peak.value
    if (peak.value >= hitThreshold) hits += 1
    midpointStrength += localPeak(envelope, beatFrame + lagFrames * 0.5, 2).value
    beats += 1
  }
  const meanBeatStrength = beats > 0 ? strength / beats : 0
  const midpointRatio = strength > 0 ? midpointStrength / strength : 0
  const coverage = beats > 0 ? hits / beats : 0
  return {
    phaseFrame,
    score: meanBeatStrength * (0.65 + coverage * 0.35) * (1 - clamp01(midpointRatio) * 0.28)
  }
}

const selectPhaseSeeds = (
  envelope: Float64Array,
  lagFrames: number,
  hitThreshold: number
): PhaseSeed[] => {
  const phaseLimit = Math.max(2, Math.round(lagFrames))
  const seeds: PhaseSeed[] = []
  for (let phaseFrame = 0; phaseFrame < phaseLimit; phaseFrame += 1) {
    seeds.push(scorePhaseSeed(envelope, lagFrames, phaseFrame, hitThreshold))
  }
  seeds.sort((left, right) => right.score - left.score)
  const selected: PhaseSeed[] = []
  const minDistance = Math.max(2, lagFrames * 0.06)
  for (const seed of seeds) {
    const tooClose = selected.some((item) => {
      const distance = Math.abs(item.phaseFrame - seed.phaseFrame)
      return Math.min(distance, lagFrames - distance) < minDistance
    })
    if (tooClose) continue
    selected.push(seed)
    if (selected.length >= MAX_PHASE_CANDIDATES_PER_TEMPO) break
  }
  return selected
}

const refinePhaseFrame = (envelope: Float64Array, lagFrames: number, phaseFrame: number) => {
  let weightedOffset = 0
  let weightSum = 0
  for (let beatFrame = phaseFrame; beatFrame < envelope.length; beatFrame += lagFrames) {
    const peak = localPeak(envelope, beatFrame, PHASE_PEAK_RADIUS_FRAMES)
    weightedOffset += peak.offset * peak.value
    weightSum += peak.value
  }
  if (weightSum <= 0) return phaseFrame
  return (
    phaseFrame +
    Math.max(
      -PHASE_PEAK_RADIUS_FRAMES,
      Math.min(PHASE_PEAK_RADIUS_FRAMES, weightedOffset / weightSum)
    )
  )
}

const estimateDownbeat = (
  envelope: Float64Array,
  lagFrames: number,
  phaseFrame: number
): { offset: number; score: number } => {
  const scores = [0, 0, 0, 0]
  const counts = [0, 0, 0, 0]
  let beatIndex = 0
  for (let beatFrame = phaseFrame; beatFrame < envelope.length; beatFrame += lagFrames) {
    const modulo = beatIndex % 4
    const peak = localPeak(envelope, beatFrame, PHASE_PEAK_RADIUS_FRAMES)
    const nextBeat = localPeak(envelope, beatFrame + lagFrames, PHASE_PEAK_RADIUS_FRAMES)
    scores[modulo] += peak.value + Math.max(0, peak.value - nextBeat.value) * 0.18
    counts[modulo] += 1
    beatIndex += 1
  }
  const normalized = scores.map((score, index) => (counts[index] > 0 ? score / counts[index] : 0))
  let bestOffset = 0
  for (let index = 1; index < 4; index += 1) {
    if (normalized[index] > normalized[bestOffset]) bestOffset = index
  }
  const average = normalized.reduce((sum, value) => sum + value, 0) / 4 || 1
  return {
    offset: bestOffset,
    score: clamp01((normalized[bestOffset] - average) / Math.max(average, 0.0001))
  }
}

const scoreGrid = (
  envelope: Float64Array,
  bpm: number,
  lagFrames: number,
  phaseFrame: number,
  hopSec: number,
  hitThreshold: number
): GridScore => {
  const refinedPhase = refinePhaseFrame(envelope, lagFrames, phaseFrame)
  const intervalMs = 60000 / bpm
  const frameCenterOffsetSec = (FRAME_SIZE / (2 * HOP_SIZE)) * hopSec
  const rawPhaseMs = (refinedPhase * hopSec + frameCenterOffsetSec) * 1000
  const phaseMs = ((rawPhaseMs % intervalMs) + intervalMs) % intervalMs
  const strengths: number[] = []
  const errors: number[] = []
  let midpointStrength = 0
  let hits = 0

  for (let beatFrame = refinedPhase; beatFrame < envelope.length; beatFrame += lagFrames) {
    const peak = localPeak(envelope, beatFrame, PHASE_PEAK_RADIUS_FRAMES)
    strengths.push(peak.value)
    errors.push(Math.abs(peak.offset))
    if (peak.value >= hitThreshold) hits += 1
    midpointStrength += localPeak(envelope, beatFrame + lagFrames * 0.5, 2).value
  }

  const beatCount = strengths.length
  const strengthSum = strengths.reduce((sum, value) => sum + value, 0)
  const meanBeatStrength = beatCount > 0 ? strengthSum / beatCount : 0
  const medianErrorFrames = median(errors)
  const coverageScore = beatCount > 0 ? clamp01(hits / beatCount) : 0
  const consistencyScore = clamp01(1 - (medianErrorFrames * hopSec * 1000) / 18)
  const midpointPenalty = strengthSum > 0 ? clamp01(midpointStrength / strengthSum) : 0
  const downbeat = estimateDownbeat(envelope, lagFrames, refinedPhase)
  const score =
    clamp01(meanBeatStrength / 2.2) * 0.28 +
    coverageScore * 0.22 +
    consistencyScore * 0.22 +
    downbeat.score * 0.08 +
    (1 - midpointPenalty) * 0.2

  return {
    phaseFrame: refinedPhase,
    phaseMs,
    score: clamp01(score),
    beatCount,
    hitCount: hits,
    meanBeatStrength,
    medianErrorFrames,
    coverageScore,
    consistencyScore,
    midpointPenalty,
    downbeatOffset: downbeat.offset,
    downbeatScore: downbeat.score
  }
}

const solveClassicGridLines = (
  envelope: Float64Array,
  hopSec: number,
  durationSec: number
): ClassicGridLineAnalysis => {
  const tempoCandidates = estimateTempoCandidates(envelope, hopSec)
  if (!tempoCandidates.length) {
    throw new Error('Classic grid-line analyzer found no stable tempo candidate')
  }

  const positive = Array.from(envelope).filter((value) => value > 0)
  const hitThreshold = Math.max(0.08, percentile(positive, 0.72))
  let bestTempo = tempoCandidates[0]
  let bestGrid: GridScore | null = null
  let bestScore = -1

  for (const tempo of tempoCandidates) {
    const seeds = selectPhaseSeeds(envelope, tempo.lagFrames, hitThreshold)
    for (const seed of seeds) {
      const grid = scoreGrid(
        envelope,
        tempo.bpm,
        tempo.lagFrames,
        seed.phaseFrame,
        hopSec,
        hitThreshold
      )
      const tempoConfidence = clamp01(tempo.score / Math.max(tempo.score + 0.16, 0.0001))
      const candidateScore = grid.score * 0.82 + tempoConfidence * 0.18
      if (candidateScore > bestScore) {
        bestTempo = tempo
        bestGrid = grid
        bestScore = candidateScore
      }
    }
  }

  if (!bestGrid) {
    throw new Error('Classic grid-line analyzer found no stable phase candidate')
  }

  const beatIntervalSec = 60 / bestTempo.bpm
  const tempoScore = clamp01(bestTempo.score / Math.max(bestTempo.score + 0.16, 0.0001))
  const downbeatCount = Math.floor(bestGrid.beatCount / 4)
  const qualityScore = clamp01(bestGrid.score * 0.75 + tempoScore * 0.25)

  return {
    bpm: Number(bestTempo.bpm.toFixed(6)),
    rawBpm: Number(bestTempo.bpm.toFixed(6)),
    firstBeatMs: Number(bestGrid.phaseMs.toFixed(3)),
    rawFirstBeatMs: Number(bestGrid.phaseMs.toFixed(3)),
    barBeatOffset: bestGrid.downbeatOffset % 32,
    beatCount: bestGrid.beatCount,
    downbeatCount,
    durationSec: Number(durationSec.toFixed(3)),
    beatIntervalSec: Number(beatIntervalSec.toFixed(6)),
    tempoScore,
    gridScore: bestGrid,
    qualityScore
  }
}

const toBeatGridResult = (analysis: ClassicGridLineAnalysis): BeatGridAnalyzeResult => ({
  analyzerProvider: 'classic',
  bpm: analysis.bpm,
  rawBpm: analysis.rawBpm,
  firstBeatMs: analysis.firstBeatMs,
  rawFirstBeatMs: analysis.rawFirstBeatMs,
  barBeatOffset: analysis.barBeatOffset,
  beatCount: analysis.beatCount,
  downbeatCount: analysis.downbeatCount,
  durationSec: analysis.durationSec,
  beatIntervalSec: analysis.beatIntervalSec,
  beatCoverageScore: Number(analysis.gridScore.coverageScore.toFixed(6)),
  beatStabilityScore: Number(analysis.gridScore.consistencyScore.toFixed(6)),
  downbeatCoverageScore: Number(analysis.gridScore.coverageScore.toFixed(6)),
  downbeatStabilityScore: Number(analysis.gridScore.downbeatScore.toFixed(6)),
  qualityScore: Number(analysis.qualityScore.toFixed(6)),
  anchorCorrectionMs: 0,
  anchorConfidenceScore: Number(analysis.gridScore.score.toFixed(6)),
  anchorMatchedBeatCount: analysis.gridScore.hitCount,
  anchorStrategy: 'classic-grid-line-lattice-v2',
  windowStartSec: 0,
  windowDurationSec: analysis.durationSec,
  windowIndex: 0
})

export const analyzeBeatGridWithClassicFromPcm = async (
  params: BeatGridAnalyzeParams
): Promise<BeatGridAnalyzeResult> => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const samples = resolveFloatSamples(pcmData)
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const sampleRate = Math.max(1, Math.floor(Number(params.sampleRate) || 0))
  const totalFrames = Math.floor(samples.length / channels)
  const maxScanSec = Math.max(1, Number(params.maxScanSec) || DEFAULT_MAX_SCAN_SEC)
  const usableFrames = Math.min(totalFrames, Math.floor(maxScanSec * sampleRate))
  const durationSec = usableFrames / sampleRate
  if (durationSec < MIN_DURATION_SEC) {
    throw new Error('Classic grid-line analysis requires at least 8 seconds of PCM')
  }

  const envelope = buildOnsetEnvelope(samples, channels, usableFrames)
  if (envelope.length <= 4) {
    throw new Error('Classic grid-line analyzer decoded too little onset data')
  }

  const analysis = solveClassicGridLines(envelope, HOP_SIZE / sampleRate, durationSec)
  return toBeatGridResult(analysis)
}
