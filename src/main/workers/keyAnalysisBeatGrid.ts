const K_MAX_ANALYZE_SEC = 90
const K_TARGET_ENVELOPE_RATE = 200
const K_LOW_PASS_CUTOFF_HZ = 180
const K_FAST_ALPHA = 0.32
const K_SLOW_ALPHA = 0.04
const K_BAR_PHASE_INTERVAL = 4
const K_BAR_BEAT_WRAP_INTERVAL = 32
const K_HALF_BEAT_CORRECTION_MAX_BEATS = 96
const K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BEATS = 24
const K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BARS = 6
const K_HALF_BEAT_CORRECTION_MIN_SUPPORT_BARS = 5
const K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_LEAD_RATIO = 0.08
const K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_SUPPORT_RATE = 0.16
const K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_BAR_SPREAD = 0.035
const K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_BAR_SUPPORT_RATE = 0.55
const K_HALF_BEAT_CORRECTION_LEAD_RATIO_DELTA = 0.12
const K_HALF_BEAT_CORRECTION_SUPPORT_RATE_DELTA = 0.18
const K_HALF_BEAT_CORRECTION_BAR_SUPPORT_RATE_DELTA = 0.22
const K_HALF_BEAT_CORRECTION_BAR_SPREAD_DELTA = 0.015
const K_HALF_BEAT_CORRECTION_MIN_BAR_SPREAD = 0.04
const K_HALF_BEAT_CORRECTION_STRONG_LEAD_RATIO_DELTA = 0.22
const K_HALF_BEAT_CORRECTION_STRONG_SUPPORT_RATE_DELTA = 0.28
const K_HALF_BEAT_CORRECTION_STRONG_BAR_SUPPORT_RATE_DELTA = 0.2
const K_HALF_BEAT_CORRECTION_SUPPORT_MARGIN_ABS = 0.18
const K_HALF_BEAT_CORRECTION_SUPPORT_MARGIN_RATIO = 0.08

type AnalysisSeries = {
  stepSec: number
  energy: Float32Array
  lowEnergy: Float32Array
  onset: Float32Array
  lowOnset: Float32Array
}

type BeatFeature = {
  energy: number
  lowEnergy: number
  onset: number
  lowOnset: number
  contrast: number
  activity: number
}

type BeatFeatureContext = {
  beatIndices: number[]
  features: BeatFeature[]
  normalizedEnergy: number[]
  normalizedLowEnergy: number[]
  normalizedOnset: number[]
  normalizedLowOnset: number[]
  normalizedContrast: number[]
  normalizedActivity: number[]
  downbeatStrengthByBeat: number[]
  beatPulseStrengthByBeat: number[]
  offbeatPulseStrengthByBeat: number[]
  activeBeatThreshold: number
}

type BarPhaseScore = {
  candidateScores: number[]
  candidateWeights: number[]
  bestPhase: number
  bestScore: number
  secondScore: number
  scoreSpread: number
  activeBarCount: number
  supportBarCount: number
}

type HalfBeatAnchorCandidateScore = {
  firstBeatMs: number
  firstBeatWindow: number
  beatMean: number
  offbeatMean: number
  leadRatio: number
  netSupportRate: number
  activeBeatCount: number
  activeBarCount: number
  supportBarCount: number
  barSpread: number
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const wrapPositiveModulo = (value: number, interval: number) => {
  if (!Number.isFinite(interval) || interval <= 0) return value
  const wrapped = value % interval
  return wrapped < 0 ? wrapped + interval : wrapped
}

export const normalizeBarBeatOffset = (value: unknown, interval: number = 32) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

const toFloat32ArrayFromBuffer = (input: Buffer): Float32Array => {
  if (!input || input.length < 4) return new Float32Array(0)
  const byteOffsetAligned = input.byteOffset % 4 === 0
  const byteLengthAligned = input.byteLength % 4 === 0
  if (byteOffsetAligned && byteLengthAligned) {
    return new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4)
  }
  const usableBytes = input.byteLength - (input.byteLength % 4)
  if (usableBytes <= 0) return new Float32Array(0)
  const copied = new Uint8Array(usableBytes)
  copied.set(input.subarray(0, usableBytes))
  return new Float32Array(copied.buffer)
}

const sampleLocalMax = (series: Float32Array, index: number, radius: number) => {
  if (index < 0 || index >= series.length) return 0
  const left = Math.max(0, index - radius)
  const right = Math.min(series.length - 1, index + radius)
  let maxValue = 0
  for (let cursor = left; cursor <= right; cursor += 1) {
    const value = series[cursor] || 0
    if (value > maxValue) {
      maxValue = value
    }
  }
  return maxValue
}

const sampleRangeAverage = (series: Float32Array, start: number, end: number) => {
  if (!series.length) return 0
  const left = Math.max(0, Math.min(series.length - 1, start))
  const right = Math.max(left, Math.min(series.length - 1, end))
  let total = 0
  let count = 0
  for (let cursor = left; cursor <= right; cursor += 1) {
    total += series[cursor] || 0
    count += 1
  }
  return count > 0 ? total / count : 0
}

const resolvePercentile = (values: number[], percentile: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = clampNumber(
    Math.round((sorted.length - 1) * clampNumber(percentile, 0, 1)),
    0,
    sorted.length - 1
  )
  return sorted[index] || 0
}

const normalizeFeatureSeries = (values: number[]) => {
  const scale = Math.max(resolvePercentile(values, 0.9), 0.000001)
  return values.map((value) => clampNumber(value / scale, 0, 4))
}

const computeOnsetSeries = (envelope: Float32Array) => {
  const onset = new Float32Array(envelope.length)
  let fast = 0
  let slow = 0
  for (let index = 0; index < envelope.length; index += 1) {
    const value = envelope[index] || 0
    fast += K_FAST_ALPHA * (value - fast)
    slow += K_SLOW_ALPHA * (value - slow)
    const diff = fast - slow
    onset[index] = diff > 0 ? diff : 0
  }
  return onset
}

const buildAnalysisSeries = (
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number
): AnalysisSeries | null => {
  if (!pcmBuffer || !Number.isFinite(sampleRate) || sampleRate <= 0) return null
  if (!Number.isFinite(channels) || channels <= 0) return null

  const samples = toFloat32ArrayFromBuffer(pcmBuffer)
  if (!samples.length) return null

  const channelCount = Math.max(1, Math.floor(channels))
  const totalFrames = Math.floor(samples.length / channelCount)
  if (!totalFrames) return null

  const framesToUse = Math.min(totalFrames, Math.floor(sampleRate * K_MAX_ANALYZE_SEC))
  if (framesToUse < sampleRate * 2) return null

  const hopSize = Math.max(1, Math.round(sampleRate / K_TARGET_ENVELOPE_RATE))
  const stepSec = hopSize / sampleRate
  const envelopeLength = Math.floor(framesToUse / hopSize)
  if (envelopeLength < 64) return null

  const energy = new Float32Array(envelopeLength)
  const lowEnergy = new Float32Array(envelopeLength)
  const inverseChannels = 1 / channelCount
  const lowPassAlpha = 1 - Math.exp((-2 * Math.PI * K_LOW_PASS_CUTOFF_HZ) / sampleRate)
  let lowPassState = 0

  for (let windowIndex = 0; windowIndex < envelopeLength; windowIndex += 1) {
    const startFrame = windowIndex * hopSize
    const endFrame = Math.min(framesToUse, startFrame + hopSize)
    let fullEnergy = 0
    let lowBandEnergy = 0

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const base = frame * channelCount
      let mono = 0
      for (let channel = 0; channel < channelCount; channel += 1) {
        mono += samples[base + channel] || 0
      }
      mono *= inverseChannels
      lowPassState += lowPassAlpha * (mono - lowPassState)
      fullEnergy += Math.abs(mono)
      lowBandEnergy += Math.abs(lowPassState)
    }

    const frameSpan = Math.max(1, endFrame - startFrame)
    energy[windowIndex] = fullEnergy / frameSpan
    lowEnergy[windowIndex] = lowBandEnergy / frameSpan
  }

  return {
    stepSec,
    energy,
    lowEnergy,
    onset: computeOnsetSeries(energy),
    lowOnset: computeOnsetSeries(lowEnergy)
  }
}

const resolvePulseStrengthAtIndex = (
  series: AnalysisSeries,
  index: number,
  localRadius: number
) => {
  if (index < 0 || index >= series.energy.length) return 0
  const energy = sampleRangeAverage(series.energy, index - localRadius, index + localRadius)
  const lowEnergy = sampleRangeAverage(series.lowEnergy, index - localRadius, index + localRadius)
  const onset = sampleLocalMax(series.onset, index, localRadius)
  const lowOnset = sampleLocalMax(series.lowOnset, index, localRadius)
  return lowOnset * 1.85 + lowEnergy * 1.05 + onset * 0.45 + energy * 0.12
}

const buildBeatFeatureContext = (
  series: AnalysisSeries,
  beatIntervalWindows: number,
  firstBeatWindow: number,
  maxBeatCount: number = Number.POSITIVE_INFINITY
): BeatFeatureContext | null => {
  if (!Number.isFinite(firstBeatWindow) || firstBeatWindow < 0) return null

  const beatIndices: number[] = []
  for (
    let pos = firstBeatWindow;
    pos < series.energy.length && beatIndices.length < maxBeatCount;
    pos += beatIntervalWindows
  ) {
    const idx = Math.round(pos)
    if (idx < 0 || idx >= series.energy.length) continue
    beatIndices.push(idx)
  }
  if (beatIndices.length < 8) return null

  const localRadius = clampNumber(Math.round(beatIntervalWindows * 0.05), 1, 6)
  const preSpan = clampNumber(Math.round(beatIntervalWindows * 0.12), 1, 12)
  const postSpan = clampNumber(Math.round(beatIntervalWindows * 0.18), 1, 18)
  const halfBeatOffsetWindows = beatIntervalWindows * 0.5

  const features = beatIndices.map<BeatFeature>((idx) => {
    const energy = sampleRangeAverage(series.energy, idx - localRadius, idx + localRadius)
    const lowEnergy = sampleRangeAverage(series.lowEnergy, idx - localRadius, idx + localRadius)
    const onset = sampleLocalMax(series.onset, idx, localRadius)
    const lowOnset = sampleLocalMax(series.lowOnset, idx, localRadius)
    const preEnergy = sampleRangeAverage(series.energy, idx - preSpan, idx - 1)
    const postEnergy = sampleRangeAverage(series.energy, idx, idx + postSpan)
    const preLow = sampleRangeAverage(series.lowEnergy, idx - preSpan, idx - 1)
    const postLow = sampleRangeAverage(series.lowEnergy, idx, idx + postSpan)
    const contrast =
      Math.max(0, postLow - preLow) * 0.65 + Math.max(0, postEnergy - preEnergy) * 0.35
    return {
      energy,
      lowEnergy,
      onset,
      lowOnset,
      contrast,
      activity: energy * 0.55 + lowEnergy * 0.45
    }
  })

  const normalizedEnergy = normalizeFeatureSeries(features.map((item) => item.energy))
  const normalizedLowEnergy = normalizeFeatureSeries(features.map((item) => item.lowEnergy))
  const normalizedOnset = normalizeFeatureSeries(features.map((item) => item.onset))
  const normalizedLowOnset = normalizeFeatureSeries(features.map((item) => item.lowOnset))
  const normalizedContrast = normalizeFeatureSeries(features.map((item) => item.contrast))
  const normalizedActivity = normalizeFeatureSeries(features.map((item) => item.activity))

  const downbeatStrengthByBeat = features.map((_, index) => {
    const activity = normalizedActivity[index] || 0
    return (
      (normalizedLowOnset[index] || 0) * 1.75 +
      (normalizedLowEnergy[index] || 0) * 1.1 +
      (normalizedContrast[index] || 0) * 0.65 +
      (normalizedOnset[index] || 0) * 0.3 +
      (normalizedEnergy[index] || 0) * 0.15 +
      activity * 0.2
    )
  })

  const beatPulseStrengthByBeat = beatIndices.map((idx) =>
    resolvePulseStrengthAtIndex(series, idx, localRadius)
  )
  const offbeatPulseStrengthByBeat = beatIndices.map((idx) =>
    resolvePulseStrengthAtIndex(series, Math.round(idx + halfBeatOffsetWindows), localRadius)
  )
  const activeBeatThreshold = Math.max(
    resolvePercentile(
      beatPulseStrengthByBeat.map((value, index) =>
        Math.max(value, offbeatPulseStrengthByBeat[index] || 0)
      ),
      0.38
    ) * 0.55,
    0.06
  )

  return {
    beatIndices,
    features,
    normalizedEnergy,
    normalizedLowEnergy,
    normalizedOnset,
    normalizedLowOnset,
    normalizedContrast,
    normalizedActivity,
    downbeatStrengthByBeat,
    beatPulseStrengthByBeat,
    offbeatPulseStrengthByBeat,
    activeBeatThreshold
  }
}

const scoreBarPhaseCandidates = (context: BeatFeatureContext): BarPhaseScore => {
  const activityThreshold = Math.max(
    resolvePercentile(context.normalizedActivity, 0.25) * 0.65,
    0.08
  )
  const candidateScores = new Array<number>(K_BAR_PHASE_INTERVAL).fill(0)
  const candidateWeights = new Array<number>(K_BAR_PHASE_INTERVAL).fill(0)

  for (let phase = 0; phase < K_BAR_PHASE_INTERVAL; phase += 1) {
    let phaseScore = 0
    let phaseWeight = 0

    for (
      let start = phase;
      start + (K_BAR_PHASE_INTERVAL - 1) < context.features.length;
      start += K_BAR_PHASE_INTERVAL
    ) {
      const barIndices = [start, start + 1, start + 2, start + 3].filter(
        (idx) => idx < context.features.length
      )
      if (barIndices.length < K_BAR_PHASE_INTERVAL) continue

      const activityValues = barIndices.map((idx) => context.normalizedActivity[idx] || 0)
      const barWeight =
        activityValues.reduce((sum, value) => sum + value, 0) / activityValues.length
      if (barWeight < activityThreshold) continue

      const downIndex = start
      const otherIndices = barIndices.slice(1)
      const downStrength = context.downbeatStrengthByBeat[downIndex] || 0
      const otherStrengths = otherIndices.map((idx) => context.downbeatStrengthByBeat[idx] || 0)
      const otherMean =
        otherStrengths.reduce((sum, value) => sum + value, 0) / Math.max(1, otherStrengths.length)
      const otherMax = Math.max(...otherStrengths)

      const downLowLead =
        (context.normalizedLowOnset[downIndex] || 0) * 1.3 +
        (context.normalizedLowEnergy[downIndex] || 0) * 0.9 +
        (context.normalizedContrast[downIndex] || 0) * 0.55
      const otherLowLead =
        otherIndices.reduce(
          (sum, idx) =>
            sum +
            (context.normalizedLowOnset[idx] || 0) * 1.3 +
            (context.normalizedLowEnergy[idx] || 0) * 0.9 +
            (context.normalizedContrast[idx] || 0) * 0.55,
          0
        ) / Math.max(1, otherIndices.length)

      let score = (downStrength - otherMean) * 0.85 + (downStrength - otherMax) * 0.65
      score += (downLowLead - otherLowLead) * 0.45
      if (downStrength >= Math.max(...otherStrengths, downStrength)) {
        score += 0.15
      }

      const timeWeight = 1 / (1 + start * 0.012)
      phaseScore += score * barWeight * timeWeight
      phaseWeight += barWeight * timeWeight
    }

    if (phaseWeight > 0) {
      candidateScores[phase] = phaseScore / phaseWeight
      candidateWeights[phase] = phaseWeight
    }
  }

  const bestPhase = candidateScores.reduce(
    (best, score, index) => (score > candidateScores[best] ? index : best),
    0
  )
  const sortedScores = [...candidateScores].sort((a, b) => b - a)
  const bestScore = sortedScores[0] || 0
  const secondScore = sortedScores[1] || 0
  let activeBarCount = 0
  let supportBarCount = 0

  if (candidateWeights[bestPhase] > 0) {
    for (
      let start = 0;
      start + (K_BAR_PHASE_INTERVAL - 1) < context.features.length;
      start += K_BAR_PHASE_INTERVAL
    ) {
      const barIndices = [start, start + 1, start + 2, start + 3]
      const activityValues = barIndices.map((idx) => context.normalizedActivity[idx] || 0)
      const activeBeatCount = barIndices.filter(
        (idx) =>
          Math.max(
            context.beatPulseStrengthByBeat[idx] || 0,
            context.offbeatPulseStrengthByBeat[idx] || 0
          ) >= context.activeBeatThreshold
      ).length
      const barWeight =
        activityValues.reduce((sum, value) => sum + value, 0) / Math.max(1, activityValues.length)
      if (barWeight < activityThreshold || activeBeatCount < 3) continue

      activeBarCount += 1
      const barLeadMean =
        barIndices.reduce(
          (sum, idx) =>
            sum +
            ((context.beatPulseStrengthByBeat[idx] || 0) -
              (context.offbeatPulseStrengthByBeat[idx] || 0)),
          0
        ) / barIndices.length
      const leadWins = barIndices.filter(
        (idx) =>
          (context.beatPulseStrengthByBeat[idx] || 0) >
          (context.offbeatPulseStrengthByBeat[idx] || 0)
      ).length
      if (barLeadMean > 0 && leadWins >= 3) {
        supportBarCount += 1
      }
    }
  }

  return {
    candidateScores,
    candidateWeights,
    bestPhase,
    bestScore,
    secondScore,
    scoreSpread: bestScore - secondScore,
    activeBarCount,
    supportBarCount
  }
}

const evaluateHalfBeatAnchorCandidate = (
  series: AnalysisSeries,
  beatIntervalWindows: number,
  firstBeatWindow: number
): HalfBeatAnchorCandidateScore | null => {
  const context = buildBeatFeatureContext(
    series,
    beatIntervalWindows,
    firstBeatWindow,
    K_HALF_BEAT_CORRECTION_MAX_BEATS
  )
  if (!context) return null

  let weightTotal = 0
  let beatTotal = 0
  let offbeatTotal = 0
  let supportWeight = 0
  let lossWeight = 0
  let activeBeatCount = 0

  for (let index = 0; index < context.beatIndices.length; index += 1) {
    const beatStrength = context.beatPulseStrengthByBeat[index] || 0
    const offbeatStrength = context.offbeatPulseStrengthByBeat[index] || 0
    if (Math.max(beatStrength, offbeatStrength) < context.activeBeatThreshold) continue

    activeBeatCount += 1
    const timeWeight = 1 / (1 + context.beatIndices[index] * 0.003)
    const activityWeight = clampNumber(
      (context.normalizedActivity[index] || 0) * 0.35 + 0.65,
      0.65,
      2
    )
    const weight = timeWeight * activityWeight
    const lead = beatStrength - offbeatStrength
    const supportMargin = Math.max(
      K_HALF_BEAT_CORRECTION_SUPPORT_MARGIN_ABS,
      (beatStrength + offbeatStrength) * K_HALF_BEAT_CORRECTION_SUPPORT_MARGIN_RATIO
    )

    weightTotal += weight
    beatTotal += beatStrength * weight
    offbeatTotal += offbeatStrength * weight
    if (lead > supportMargin) {
      supportWeight += weight
    } else if (lead < -supportMargin) {
      lossWeight += weight
    }
  }

  if (weightTotal <= 0 || activeBeatCount <= 0) return null

  const beatMean = beatTotal / weightTotal
  const offbeatMean = offbeatTotal / weightTotal
  const phaseScore = scoreBarPhaseCandidates(context)

  return {
    firstBeatMs: Number((firstBeatWindow * series.stepSec * 1000).toFixed(3)),
    firstBeatWindow,
    beatMean,
    offbeatMean,
    leadRatio: (beatMean - offbeatMean) / Math.max(0.5, beatMean + offbeatMean),
    netSupportRate: (supportWeight - lossWeight) / weightTotal,
    activeBeatCount,
    activeBarCount: phaseScore.activeBarCount,
    supportBarCount: phaseScore.supportBarCount,
    barSpread: phaseScore.scoreSpread
  }
}

const resolveShiftedFirstBeatWindow = (
  firstBeatWindow: number,
  shiftWindows: number,
  beatIntervalWindows: number
) => {
  if (!Number.isFinite(firstBeatWindow) || !Number.isFinite(shiftWindows)) return null
  const shifted = firstBeatWindow + shiftWindows
  if (!Number.isFinite(shifted)) return null
  if (firstBeatWindow <= beatIntervalWindows * 1.5) {
    return wrapPositiveModulo(shifted, beatIntervalWindows)
  }
  return shifted >= 0 ? shifted : null
}

export const estimateFirstBeatMsFromPcm = (
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bpm: number
): number | null => {
  if (!Number.isFinite(bpm) || bpm <= 0) return null

  const series = buildAnalysisSeries(pcmBuffer, sampleRate, channels)
  if (!series) return null

  const beatIntervalWindows = 60 / bpm / series.stepSec
  if (!Number.isFinite(beatIntervalWindows) || beatIntervalWindows < 2) return null
  const phaseSpan = Math.max(2, Math.round(beatIntervalWindows))
  if (phaseSpan >= series.onset.length) return null

  let bestPhase = 0
  let bestScore = -Infinity
  for (let phase = 0; phase < phaseSpan; phase += 1) {
    let score = 0
    let weightTotal = 0
    for (let pos = phase; pos < series.onset.length; pos += beatIntervalWindows) {
      const idx = Math.round(pos)
      if (idx < 0 || idx >= series.onset.length) continue
      const value = sampleLocalMax(series.onset, idx, 1)
      const timeWeight = 1 / (1 + idx * 0.0015)
      score += value * timeWeight
      weightTotal += timeWeight
    }
    if (weightTotal <= 0) continue
    const normalized = score / weightTotal
    if (normalized > bestScore) {
      bestScore = normalized
      bestPhase = phase
    }
  }

  if (!Number.isFinite(bestScore) || bestScore <= 0) return null

  const threshold = Math.max(
    resolvePercentile(Array.from(series.onset), 0.78) * 0.72,
    bestScore * 0.35,
    0.000001
  )

  let firstBeatIndex = -1
  for (let pos = bestPhase; pos < series.onset.length; pos += beatIntervalWindows) {
    const idx = Math.round(pos)
    if (idx < 0 || idx >= series.onset.length) continue
    if (sampleLocalMax(series.onset, idx, 1) < threshold) continue
    firstBeatIndex = idx
    break
  }
  if (firstBeatIndex < 0) {
    firstBeatIndex = Math.round(bestPhase)
  }

  const estimatedMs = firstBeatIndex * series.stepSec * 1000
  if (!Number.isFinite(estimatedMs) || estimatedMs < 0) return null
  return Number(estimatedMs.toFixed(3))
}

export const refineHalfBeatFirstBeatMsFromPcm = (
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bpm: number,
  firstBeatMs: number
): number | null => {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(firstBeatMs) || firstBeatMs < 0) return null

  const series = buildAnalysisSeries(pcmBuffer, sampleRate, channels)
  if (!series) return null

  const beatIntervalWindows = 60 / bpm / series.stepSec
  if (!Number.isFinite(beatIntervalWindows) || beatIntervalWindows < 2) return null

  const currentWindow = firstBeatMs / 1000 / series.stepSec
  if (!Number.isFinite(currentWindow) || currentWindow < 0) return null

  const candidateWindows = [
    currentWindow,
    resolveShiftedFirstBeatWindow(currentWindow, beatIntervalWindows * 0.5, beatIntervalWindows),
    resolveShiftedFirstBeatWindow(currentWindow, -beatIntervalWindows * 0.5, beatIntervalWindows)
  ].filter((value): value is number => Number.isFinite(value))

  const uniqueCandidateWindows = candidateWindows.filter(
    (value, index, source) => source.findIndex((item) => Math.abs(item - value) <= 0.01) === index
  )
  if (uniqueCandidateWindows.length < 2) return null

  const currentCandidate = evaluateHalfBeatAnchorCandidate(
    series,
    beatIntervalWindows,
    currentWindow
  )
  if (!currentCandidate) return null

  const alternativeCandidates = uniqueCandidateWindows
    .filter((value) => Math.abs(value - currentWindow) > 0.01)
    .map((value) => evaluateHalfBeatAnchorCandidate(series, beatIntervalWindows, value))
    .filter((value): value is HalfBeatAnchorCandidateScore => value !== null)
  if (!alternativeCandidates.length) return null

  const bestAlternative = alternativeCandidates.reduce((best, candidate) => {
    const bestScore = best.leadRatio * 1.1 + best.netSupportRate * 1.25 + best.barSpread * 0.8
    const candidateScore =
      candidate.leadRatio * 1.1 + candidate.netSupportRate * 1.25 + candidate.barSpread * 0.8
    return candidateScore > bestScore ? candidate : best
  }, alternativeCandidates[0]!)
  const currentSupportBarRate =
    currentCandidate.activeBarCount > 0
      ? currentCandidate.supportBarCount / currentCandidate.activeBarCount
      : 0
  const bestSupportBarRate =
    bestAlternative.activeBarCount > 0
      ? bestAlternative.supportBarCount / bestAlternative.activeBarCount
      : 0

  const currentLowConfidence =
    currentCandidate.leadRatio < K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_LEAD_RATIO ||
    currentCandidate.netSupportRate < K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_SUPPORT_RATE ||
    currentCandidate.barSpread < K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_BAR_SPREAD ||
    (currentCandidate.activeBarCount >= K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BARS &&
      currentSupportBarRate < K_HALF_BEAT_CORRECTION_LOW_CONFIDENCE_BAR_SUPPORT_RATE)
  const alternativeStrongEnough =
    bestAlternative.activeBeatCount >= K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BEATS &&
    bestAlternative.activeBarCount >= K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BARS &&
    bestAlternative.supportBarCount >= K_HALF_BEAT_CORRECTION_MIN_SUPPORT_BARS &&
    bestAlternative.leadRatio >=
      currentCandidate.leadRatio + K_HALF_BEAT_CORRECTION_LEAD_RATIO_DELTA &&
    bestAlternative.netSupportRate >=
      currentCandidate.netSupportRate + K_HALF_BEAT_CORRECTION_SUPPORT_RATE_DELTA &&
    (bestSupportBarRate >= currentSupportBarRate + K_HALF_BEAT_CORRECTION_BAR_SUPPORT_RATE_DELTA ||
      bestAlternative.barSpread >=
        Math.max(
          K_HALF_BEAT_CORRECTION_MIN_BAR_SPREAD,
          currentCandidate.barSpread + K_HALF_BEAT_CORRECTION_BAR_SPREAD_DELTA
        ))
  const alternativeOverwhelminglyBetter =
    bestAlternative.activeBeatCount >= K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BEATS &&
    bestAlternative.activeBarCount >= K_HALF_BEAT_CORRECTION_MIN_ACTIVE_BARS &&
    bestAlternative.leadRatio >=
      currentCandidate.leadRatio + K_HALF_BEAT_CORRECTION_STRONG_LEAD_RATIO_DELTA &&
    bestAlternative.netSupportRate >=
      currentCandidate.netSupportRate + K_HALF_BEAT_CORRECTION_STRONG_SUPPORT_RATE_DELTA &&
    bestSupportBarRate >=
      currentSupportBarRate + K_HALF_BEAT_CORRECTION_STRONG_BAR_SUPPORT_RATE_DELTA

  if (!alternativeStrongEnough) return null
  if (!currentLowConfidence && !alternativeOverwhelminglyBetter) return null
  if (Math.abs(bestAlternative.firstBeatMs - firstBeatMs) <= 0.001) return null

  return bestAlternative.firstBeatMs
}

export const estimateBarBeatOffsetFromPcm = (
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bpm: number,
  firstBeatMs: number
): number | null => {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(firstBeatMs) || firstBeatMs < 0) return null

  const series = buildAnalysisSeries(pcmBuffer, sampleRate, channels)
  if (!series) return null

  const beatIntervalWindows = 60 / bpm / series.stepSec
  if (!Number.isFinite(beatIntervalWindows) || beatIntervalWindows < 2) return null

  const firstBeatWindow = firstBeatMs / 1000 / series.stepSec
  if (!Number.isFinite(firstBeatWindow) || firstBeatWindow < 0) return null
  const context = buildBeatFeatureContext(series, beatIntervalWindows, firstBeatWindow)
  if (!context) return null

  const phaseScore = scoreBarPhaseCandidates(context)
  if (
    !Number.isFinite(phaseScore.bestScore) ||
    phaseScore.candidateWeights[phaseScore.bestPhase] <= 0
  ) {
    return null
  }
  if (phaseScore.bestScore < 0.05 || phaseScore.scoreSpread < 0.035) return null

  return normalizeBarBeatOffset(phaseScore.bestPhase, K_BAR_BEAT_WRAP_INTERVAL)
}
