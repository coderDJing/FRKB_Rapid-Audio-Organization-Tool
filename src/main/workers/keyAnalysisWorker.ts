import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCache'

type KeyJob = {
  jobId: number
  filePath: string
  fastAnalysis?: boolean
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
}

type KeyResultPayload = {
  keyText?: string
  keyError?: string
  bpm?: number
  firstBeatMs?: number
  bpmError?: string
  mixxxWaveformData?: MixxxWaveformData | null
}

type KeyResponse = {
  jobId: number
  filePath: string
  result?: KeyResultPayload
  error?: string
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

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

const resolveLocalMax = (series: Float32Array, index: number) => {
  if (index < 0 || index >= series.length) return 0
  const prev = index > 0 ? series[index - 1] || 0 : 0
  const current = series[index] || 0
  const next = index + 1 < series.length ? series[index + 1] || 0 : 0
  return Math.max(prev, current, next)
}

const estimateFirstBeatMsFromPcm = (
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bpm: number
): number | null => {
  if (!pcmBuffer || !sampleRate || !channels) return null
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null
  if (!Number.isFinite(channels) || channels <= 0) return null
  if (!Number.isFinite(bpm) || bpm <= 0) return null

  const samples = toFloat32ArrayFromBuffer(pcmBuffer)
  if (!samples.length) return null
  const channelCount = Math.max(1, Math.floor(channels))
  const totalFrames = Math.floor(samples.length / channelCount)
  if (!totalFrames) return null

  const maxAnalyzeSec = 90
  const framesToUse = Math.min(totalFrames, Math.floor(sampleRate * maxAnalyzeSec))
  if (framesToUse < sampleRate * 2) return null

  const targetEnvelopeRate = 200
  const hopSize = Math.max(1, Math.round(sampleRate / targetEnvelopeRate))
  const envelopeStepSec = hopSize / sampleRate
  const envelopeLength = Math.floor(framesToUse / hopSize)
  if (envelopeLength < 64) return null

  const envelope = new Float32Array(envelopeLength)
  const inverseChannels = 1 / channelCount
  for (let win = 0; win < envelopeLength; win += 1) {
    const startFrame = win * hopSize
    const endFrame = Math.min(framesToUse, startFrame + hopSize)
    let energy = 0
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const base = frame * channelCount
      let monoAbs = 0
      for (let ch = 0; ch < channelCount; ch += 1) {
        monoAbs += Math.abs(samples[base + ch] || 0)
      }
      energy += monoAbs * inverseChannels
    }
    const frameSpan = Math.max(1, endFrame - startFrame)
    envelope[win] = energy / frameSpan
  }

  const onset = new Float32Array(envelopeLength)
  let fast = 0
  let slow = 0
  const fastAlpha = 0.32
  const slowAlpha = 0.04
  for (let i = 0; i < envelopeLength; i += 1) {
    const value = envelope[i] || 0
    fast += fastAlpha * (value - fast)
    slow += slowAlpha * (value - slow)
    const diff = fast - slow
    onset[i] = diff > 0 ? diff : 0
  }

  const beatIntervalWindows = 60 / bpm / envelopeStepSec
  if (!Number.isFinite(beatIntervalWindows) || beatIntervalWindows < 2) return null
  const phaseSpan = Math.max(2, Math.round(beatIntervalWindows))
  if (phaseSpan >= onset.length) return null

  let bestPhase = 0
  let bestScore = -Infinity
  for (let phase = 0; phase < phaseSpan; phase += 1) {
    let score = 0
    let weightTotal = 0
    for (let pos = phase; pos < onset.length; pos += beatIntervalWindows) {
      const idx = Math.round(pos)
      if (idx < 0 || idx >= onset.length) continue
      const value = resolveLocalMax(onset, idx)
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

  const sortedOnset = Array.from(onset).sort((a, b) => a - b)
  const percentileIndex = clampNumber(
    Math.floor(sortedOnset.length * 0.78),
    0,
    sortedOnset.length - 1
  )
  const percentileValue = sortedOnset[percentileIndex] || 0
  const threshold = Math.max(percentileValue * 0.72, bestScore * 0.35, 0.000001)

  let firstBeatIndex = -1
  for (let pos = bestPhase; pos < onset.length; pos += beatIntervalWindows) {
    const idx = Math.round(pos)
    if (idx < 0 || idx >= onset.length) continue
    const value = resolveLocalMax(onset, idx)
    if (value < threshold) continue
    const sec = idx * envelopeStepSec
    if (sec < 0) continue
    firstBeatIndex = idx
    break
  }
  if (firstBeatIndex < 0) {
    firstBeatIndex = Math.round(bestPhase)
  }

  const estimatedMs = firstBeatIndex * envelopeStepSec * 1000
  if (!Number.isFinite(estimatedMs) || estimatedMs < 0) return null
  return Number(estimatedMs.toFixed(3))
}

const loadRust = () => {
  const binding = require('rust_package') as {
    decodeAudioFile: (filePath: string) => {
      pcmData: Buffer
      sampleRate: number
      channels: number
      totalFrames: number
      error?: string
    }
    analyzeKeyFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => { keyText: string; error?: string }
    analyzeKeyAndBpmFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => {
      keyText: string
      keyError?: string
      bpm: number
      firstBeatMs?: number
      bpmError?: string
    }
    computeMixxxWaveform?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number
    ) => MixxxWaveformData
  }
  return binding
}

const analyzeKeyForFile = (
  filePath: string,
  options: { fastAnalysis: boolean; needsKey: boolean; needsBpm: boolean; needsWaveform: boolean }
): KeyResultPayload => {
  const rust = loadRust()
  const decoded = rust.decodeAudioFile(filePath)
  if (decoded.error) {
    throw new Error(decoded.error)
  }
  const result: KeyResultPayload = {}
  const needsKey = Boolean(options.needsKey)
  const needsBpm = Boolean(options.needsBpm)
  const needsWaveform = Boolean(options.needsWaveform)

  if (needsKey || needsBpm) {
    const analyzeKeyAndBpm = rust.analyzeKeyAndBpmFromPcm
    if (typeof analyzeKeyAndBpm !== 'function') {
      throw new Error('analyzeKeyAndBpmFromPcm not available')
    }
    const analysis = analyzeKeyAndBpm(
      decoded.pcmData,
      decoded.sampleRate,
      decoded.channels,
      options.fastAnalysis
    )
    if (needsKey) {
      result.keyText = analysis.keyText
      result.keyError = analysis.keyError
    }
    if (needsBpm) {
      result.bpm = analysis.bpm
      if (
        typeof analysis.firstBeatMs === 'number' &&
        Number.isFinite(analysis.firstBeatMs) &&
        analysis.firstBeatMs >= 0
      ) {
        result.firstBeatMs = analysis.firstBeatMs
      }
      const firstBeatMsValue = Number(result.firstBeatMs)
      const bpmValue = Number(result.bpm)
      const shouldEstimateFirstBeat =
        (!Number.isFinite(firstBeatMsValue) || firstBeatMsValue <= 0) &&
        Number.isFinite(bpmValue) &&
        bpmValue > 0
      if (shouldEstimateFirstBeat) {
        const estimatedFirstBeatMs = estimateFirstBeatMsFromPcm(
          decoded.pcmData,
          decoded.sampleRate,
          decoded.channels,
          bpmValue
        )
        if (typeof estimatedFirstBeatMs === 'number' && Number.isFinite(estimatedFirstBeatMs)) {
          result.firstBeatMs = estimatedFirstBeatMs
        }
      }
      result.bpmError = analysis.bpmError
    }
  }

  if (needsWaveform && typeof rust.computeMixxxWaveform === 'function') {
    try {
      result.mixxxWaveformData = rust.computeMixxxWaveform(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels
      )
    } catch {
      result.mixxxWaveformData = null
    }
  }

  return result
}

parentPort?.on('message', async (job: KeyJob) => {
  const response: KeyResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    const result = analyzeKeyForFile(job.filePath, {
      fastAnalysis: Boolean(job.fastAnalysis),
      needsKey: Boolean(job.needsKey),
      needsBpm: Boolean(job.needsBpm),
      needsWaveform: Boolean(job.needsWaveform)
    })
    response.result = result
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
