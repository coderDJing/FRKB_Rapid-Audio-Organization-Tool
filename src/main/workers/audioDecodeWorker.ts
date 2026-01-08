import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCache'

type DecodeJob = {
  jobId: number
  filePath: string
  analyzeKey?: boolean
  needWaveform?: boolean
}

type DecodeResultPayload = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
  keyText?: string
  keyError?: string
}

type DecodeResponse = {
  jobId: number
  filePath: string
  result?: DecodeResultPayload
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
    analyzeKeyFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => { keyText: string; error?: string }
  }
  return binding
}

const decodeWithCache = async (
  filePath: string,
  analyzeKey: boolean,
  needWaveform: boolean
): Promise<DecodeResultPayload> => {
  const rust = loadRust()
  const result = rust.decodeAudioFile(filePath)
  if (result.error) {
    throw new Error(result.error)
  }

  let mixxxWaveformData: MixxxWaveformData | null = null
  if (needWaveform && typeof rust.computeMixxxWaveform === 'function') {
    try {
      mixxxWaveformData = rust.computeMixxxWaveform(
        result.pcmData,
        result.sampleRate,
        result.channels
      )
    } catch {
      mixxxWaveformData = null
    }
  }

  let keyText: string | undefined
  let keyError: string | undefined
  if (analyzeKey && typeof rust.analyzeKeyFromPcm === 'function') {
    const keyResult = rust.analyzeKeyFromPcm(
      result.pcmData,
      result.sampleRate,
      result.channels,
      true
    )
    keyText = keyResult?.keyText
    keyError = keyResult?.error
  }

  return {
    pcmData: result.pcmData,
    sampleRate: result.sampleRate,
    channels: result.channels,
    totalFrames: result.totalFrames,
    mixxxWaveformData,
    keyText,
    keyError
  }
}

parentPort?.on('message', async (job: DecodeJob) => {
  const response: DecodeResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    response.result = await decodeWithCache(
      job.filePath,
      Boolean(job.analyzeKey),
      Boolean(job.needWaveform)
    )
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
