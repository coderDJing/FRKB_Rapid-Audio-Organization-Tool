const K_MAX_ANALYZE_SEC = 90
const K_TARGET_ENVELOPE_RATE = 200
const K_LOW_PASS_CUTOFF_HZ = 180
const K_FAST_ALPHA = 0.32
const K_SLOW_ALPHA = 0.04
const K_BAR_PHASE_INTERVAL = 4

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

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

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

  const beatIndices: number[] = []
  for (let pos = firstBeatWindow; pos < series.energy.length; pos += beatIntervalWindows) {
    const idx = Math.round(pos)
    if (idx < 0 || idx >= series.energy.length) continue
    beatIndices.push(idx)
  }
  if (beatIndices.length < 8) return null

  const localRadius = clampNumber(Math.round(beatIntervalWindows * 0.05), 1, 6)
  const preSpan = clampNumber(Math.round(beatIntervalWindows * 0.12), 1, 12)
  const postSpan = clampNumber(Math.round(beatIntervalWindows * 0.18), 1, 18)

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

  const activityThreshold = Math.max(resolvePercentile(normalizedActivity, 0.25) * 0.65, 0.08)
  const candidateScores = new Array<number>(K_BAR_PHASE_INTERVAL).fill(0)
  const candidateWeights = new Array<number>(K_BAR_PHASE_INTERVAL).fill(0)

  for (let phase = 0; phase < K_BAR_PHASE_INTERVAL; phase += 1) {
    let phaseScore = 0
    let phaseWeight = 0

    for (
      let start = phase;
      start + (K_BAR_PHASE_INTERVAL - 1) < features.length;
      start += K_BAR_PHASE_INTERVAL
    ) {
      const barIndices = [start, start + 1, start + 2, start + 3].filter(
        (idx) => idx < features.length
      )
      if (barIndices.length < K_BAR_PHASE_INTERVAL) continue

      const activityValues = barIndices.map((idx) => normalizedActivity[idx] || 0)
      const barWeight =
        activityValues.reduce((sum, value) => sum + value, 0) / activityValues.length
      if (barWeight < activityThreshold) continue

      const downIndex = start
      const otherIndices = barIndices.slice(1)
      const downStrength = downbeatStrengthByBeat[downIndex] || 0
      const otherStrengths = otherIndices.map((idx) => downbeatStrengthByBeat[idx] || 0)
      const otherMean =
        otherStrengths.reduce((sum, value) => sum + value, 0) / Math.max(1, otherStrengths.length)
      const otherMax = Math.max(...otherStrengths)

      const downLowLead =
        (normalizedLowOnset[downIndex] || 0) * 1.3 +
        (normalizedLowEnergy[downIndex] || 0) * 0.9 +
        (normalizedContrast[downIndex] || 0) * 0.55
      const otherLowLead =
        otherIndices.reduce(
          (sum, idx) =>
            sum +
            (normalizedLowOnset[idx] || 0) * 1.3 +
            (normalizedLowEnergy[idx] || 0) * 0.9 +
            (normalizedContrast[idx] || 0) * 0.55,
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
  const scoreSpread = bestScore - secondScore

  if (!Number.isFinite(bestScore) || candidateWeights[bestPhase] <= 0) return null
  if (bestScore < 0.05 || scoreSpread < 0.035) return null

  return normalizeBarBeatOffset(bestPhase, 32)
}
