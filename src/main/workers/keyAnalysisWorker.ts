import { parentPort } from 'node:worker_threads'

type KeyJob = {
  jobId: number
  filePath: string
  fastAnalysis?: boolean
}

type KeyResultPayload = {
  keyText: string
  keyError?: string
  bpm?: number
  bpmError?: string
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
    ) => { keyText: string; keyError?: string; bpm: number; bpmError?: string }
  }
  return binding
}

const analyzeKeyForFile = (filePath: string, fastAnalysis: boolean): KeyResultPayload => {
  const rust = loadRust()
  const decoded = rust.decodeAudioFile(filePath)
  if (decoded.error) {
    throw new Error(decoded.error)
  }
  if (typeof rust.analyzeKeyAndBpmFromPcm !== 'function') {
    throw new Error('analyzeKeyAndBpmFromPcm not available')
  }
  return rust.analyzeKeyAndBpmFromPcm(
    decoded.pcmData,
    decoded.sampleRate,
    decoded.channels,
    fastAnalysis
  )
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
    const result = analyzeKeyForFile(job.filePath, Boolean(job.fastAnalysis))
    response.result = result
  } catch (error) {
    response.error = (error as Error)?.message ?? String(error)
  }

  parentPort?.postMessage(response)
})
