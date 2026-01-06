import fs from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import {
  readMixxxWaveformCache,
  writeMixxxWaveformCache,
  type MixxxWaveformData
} from '../waveformCache'

type DecodeJob = {
  jobId: number
  filePath: string
}

type DecodeResultPayload = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
}

type DecodeResponse = {
  jobId: number
  filePath: string
  result?: DecodeResultPayload
  error?: string
}

const cacheRoot = typeof workerData?.cacheRoot === 'string' ? workerData.cacheRoot : ''

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
  }
  return binding
}

const decodeWithCache = async (filePath: string): Promise<DecodeResultPayload> => {
  const stat = await fs.stat(filePath)
  let cachedWaveform: MixxxWaveformData | null = null
  if (cacheRoot) {
    try {
      cachedWaveform = await readMixxxWaveformCache(cacheRoot, filePath, stat)
    } catch {}
  }
  const rust = loadRust()
  const result = rust.decodeAudioFile(filePath)
  if (result.error) {
    throw new Error(result.error)
  }

  let mixxxWaveformData: MixxxWaveformData | null = cachedWaveform
  if (!mixxxWaveformData && typeof rust.computeMixxxWaveform === 'function') {
    mixxxWaveformData = rust.computeMixxxWaveform(
      result.pcmData,
      result.sampleRate,
      result.channels
    )
  }

  if (mixxxWaveformData && cacheRoot) {
    try {
      await writeMixxxWaveformCache(cacheRoot, filePath, stat, mixxxWaveformData)
    } catch {}
  }

  return {
    pcmData: result.pcmData,
    sampleRate: result.sampleRate,
    channels: result.channels,
    totalFrames: result.totalFrames,
    mixxxWaveformData
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
    response.result = await decodeWithCache(job.filePath)
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
