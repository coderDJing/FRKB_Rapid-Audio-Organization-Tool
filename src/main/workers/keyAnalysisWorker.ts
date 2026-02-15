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
