import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCache'

type MixtapeWaveformJob = {
  jobId: number
  filePath: string
  targetRate?: number
}

type MixtapeWaveformResult = {
  mixxxWaveformData?: MixxxWaveformData | null
}

type MixtapeWaveformResponse = {
  jobId: number
  filePath: string
  result?: MixtapeWaveformResult
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
    computeMixxxWaveform?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number
    ) => MixxxWaveformData
    computeMixxxWaveformWithRate?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      targetRate: number
    ) => MixxxWaveformData
  }
  return binding
}

const buildWaveform = (filePath: string, targetRate?: number): MixtapeWaveformResult => {
  const rust = loadRust()
  const decoded = rust.decodeAudioFile(filePath)
  if (decoded.error) {
    throw new Error(decoded.error)
  }
  let mixxxWaveformData: MixxxWaveformData | null = null
  const target = Number(targetRate)
  if (
    typeof rust.computeMixxxWaveformWithRate === 'function' &&
    Number.isFinite(target) &&
    target > 0
  ) {
    try {
      mixxxWaveformData = rust.computeMixxxWaveformWithRate(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels,
        target
      )
    } catch {
      mixxxWaveformData = null
    }
  } else if (typeof rust.computeMixxxWaveform === 'function') {
    try {
      mixxxWaveformData = rust.computeMixxxWaveform(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels
      )
    } catch {
      mixxxWaveformData = null
    }
  }
  return { mixxxWaveformData }
}

parentPort?.on('message', async (job: MixtapeWaveformJob) => {
  const response: MixtapeWaveformResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    response.result = buildWaveform(job.filePath, job.targetRate)
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
