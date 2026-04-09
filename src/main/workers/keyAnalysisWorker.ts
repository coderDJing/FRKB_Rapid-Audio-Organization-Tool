import { parentPort } from 'node:worker_threads'
import type { MixxxWaveformData } from '../waveformCache'
import {
  analyzeBeatGridWithBeatThisSlidingWindowsFromPcm,
  preloadBeatThisAnalyzer
} from './beatThisAnalyzer'

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
  barBeatOffset?: number
  bpmError?: string
  mixxxWaveformData?: MixxxWaveformData | null
}

type KeyProgressPayload = {
  stage:
    | 'job-received'
    | 'decode-start'
    | 'decode-done'
    | 'analyze-start'
    | 'analyze-done'
    | 'waveform-start'
    | 'waveform-done'
    | 'job-done'
    | 'job-error'
  elapsedMs: number
  decodeMs?: number
  analyzeMs?: number
  waveformMs?: number
  decodeBackend?: string
  sampleRate?: number
  channels?: number
  totalFrames?: number
  framesToProcess?: number
  needsKey?: boolean
  needsBpm?: boolean
  needsWaveform?: boolean
  detail?: string
  partialResult?: Omit<KeyResultPayload, 'mixxxWaveformData'>
}

type KeyResponse = {
  jobId: number
  filePath: string
  progress?: KeyProgressPayload
  result?: KeyResultPayload
  error?: string
}

const K_FAST_ANALYSIS_SECONDS = 60

void preloadBeatThisAnalyzer().catch(() => {})

const estimateFramesToProcess = (
  totalFrames: number,
  sampleRate: number,
  fastAnalysis: boolean
): number | undefined => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return undefined
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return undefined
  const total = Math.floor(totalFrames)
  if (!fastAnalysis) return total
  return Math.min(total, Math.floor(sampleRate * K_FAST_ANALYSIS_SECONDS))
}

const loadRust = () => {
  const binding = require('rust_package') as {
    decodeAudioFile: (filePath: string) => {
      pcmData: Buffer
      sampleRate: number
      channels: number
      totalFrames: number
      decoderBackend?: string
      error?: string
    }
    analyzeKeyFromPcm?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      fastAnalysis: boolean
    ) => { keyText: string; error?: string }
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
  options: { fastAnalysis: boolean; needsKey: boolean; needsBpm: boolean; needsWaveform: boolean },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void
): Promise<KeyResultPayload> => {
  return analyzeKeyForFileInternal(filePath, options, reportProgress)
}

const analyzeKeyForFileInternal = async (
  filePath: string,
  options: { fastAnalysis: boolean; needsKey: boolean; needsBpm: boolean; needsWaveform: boolean },
  reportProgress: (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => void
): Promise<KeyResultPayload> => {
  const rust = loadRust()
  reportProgress({
    stage: 'decode-start',
    needsKey: options.needsKey,
    needsBpm: options.needsBpm,
    needsWaveform: options.needsWaveform
  })
  const decodeStartAt = Date.now()
  const decoded = rust.decodeAudioFile(filePath)
  if (decoded.error) {
    throw new Error(decoded.error)
  }
  const decodeMs = Date.now() - decodeStartAt
  const framesToProcess = estimateFramesToProcess(
    decoded.totalFrames,
    decoded.sampleRate,
    options.fastAnalysis
  )
  reportProgress({
    stage: 'decode-done',
    decodeMs,
    decodeBackend: decoded.decoderBackend,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    totalFrames: decoded.totalFrames,
    framesToProcess
  })
  const result: KeyResultPayload = {}
  const needsKey = Boolean(options.needsKey)
  const needsBpm = Boolean(options.needsBpm)
  const needsWaveform = Boolean(options.needsWaveform)

  if (needsKey || needsBpm) {
    const analyzePlanDetail = needsBpm
      ? options.fastAnalysis
        ? 'key+beat-this-windowed-fast'
        : 'key+beat-this-windowed'
      : options.fastAnalysis
        ? 'key-fast'
        : 'key-full'
    reportProgress({
      stage: 'analyze-start',
      needsKey,
      needsBpm,
      framesToProcess,
      detail: analyzePlanDetail
    })
    const analyzeStartAt = Date.now()
    let hasAnalysisError = false

    if (needsKey) {
      const analyzeKey = rust.analyzeKeyFromPcm
      if (typeof analyzeKey !== 'function') {
        throw new Error('analyzeKeyFromPcm not available')
      }
      const keyOnly = analyzeKey(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels,
        options.fastAnalysis
      )
      result.keyText = keyOnly.keyText
      result.keyError = keyOnly.error
      if (keyOnly.error) {
        hasAnalysisError = true
      }
    }

    if (needsBpm) {
      try {
        const beatThisResult = await analyzeBeatGridWithBeatThisSlidingWindowsFromPcm({
          pcmData: decoded.pcmData,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          sourceFilePath: filePath
        })
        result.bpm = beatThisResult.bpm
        result.firstBeatMs = beatThisResult.firstBeatMs
        result.barBeatOffset = beatThisResult.barBeatOffset
        result.bpmError = undefined
      } catch (error) {
        result.bpmError =
          error instanceof Error ? error.message : String(error || 'Beat This! analyze failed')
      }

      if (!result.bpmError) {
        const normalizedBpm = Number(result.bpm)
        if (!Number.isFinite(normalizedBpm) || normalizedBpm <= 0) {
          result.bpmError = 'invalid bpm value from Beat This! analyzer'
        }
      }

      if (result.bpmError) {
        hasAnalysisError = true
      }
    }

    reportProgress({
      stage: 'analyze-done',
      analyzeMs: Date.now() - analyzeStartAt,
      detail: hasAnalysisError ? 'analysis-has-errors' : undefined,
      partialResult: {
        keyText: result.keyText,
        keyError: result.keyError,
        bpm: result.bpm,
        firstBeatMs: result.firstBeatMs,
        barBeatOffset: result.barBeatOffset,
        bpmError: result.bpmError
      }
    })
  }

  if (needsWaveform && typeof rust.computeMixxxWaveform === 'function') {
    reportProgress({ stage: 'waveform-start' })
    const waveformStartAt = Date.now()
    try {
      result.mixxxWaveformData = rust.computeMixxxWaveform(
        decoded.pcmData,
        decoded.sampleRate,
        decoded.channels
      )
      reportProgress({
        stage: 'waveform-done',
        waveformMs: Date.now() - waveformStartAt,
        detail: 'waveform-ok'
      })
    } catch {
      result.mixxxWaveformData = null
      reportProgress({
        stage: 'waveform-done',
        waveformMs: Date.now() - waveformStartAt,
        detail: 'waveform-failed'
      })
    }
  }

  return result
}

parentPort?.on('message', async (job: KeyJob) => {
  const response: KeyResponse = {
    jobId: job?.jobId ?? 0,
    filePath: job?.filePath ?? ''
  }
  const startedAt = Date.now()
  const reportProgress = (progress: Omit<KeyProgressPayload, 'elapsedMs'>) => {
    parentPort?.postMessage({
      jobId: response.jobId,
      filePath: response.filePath,
      progress: {
        ...progress,
        elapsedMs: Date.now() - startedAt
      }
    } satisfies KeyResponse)
  }

  try {
    if (!job?.filePath) {
      throw new Error('Missing file path')
    }
    reportProgress({
      stage: 'job-received',
      needsKey: Boolean(job.needsKey),
      needsBpm: Boolean(job.needsBpm),
      needsWaveform: Boolean(job.needsWaveform)
    })
    const result = await analyzeKeyForFile(
      job.filePath,
      {
        fastAnalysis: Boolean(job.fastAnalysis),
        needsKey: Boolean(job.needsKey),
        needsBpm: Boolean(job.needsBpm),
        needsWaveform: Boolean(job.needsWaveform)
      },
      reportProgress
    )
    response.result = result
    reportProgress({ stage: 'job-done' })
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    response.error = message
    reportProgress({
      stage: 'job-error',
      detail: message.slice(0, 300)
    })
  }

  parentPort?.postMessage(response)
})
