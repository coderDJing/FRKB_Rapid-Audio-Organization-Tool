import { parentPort } from 'node:worker_threads'
import path from 'node:path'
import type { MixxxWaveformData } from '../waveformCache'
import { COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE } from '../../shared/compactVisualWaveform'
import {
  buildUnifiedDisplayWaveformDetailFromMixxx,
  UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE,
  type UnifiedDisplayWaveformDetailData
} from '../../shared/unifiedDisplayWaveform'
import { analyzeBeatGridWithBeatThisSlidingWindowsFromPcm } from './beatThisAnalyzer'
import { getBeatThisRuntimeAvailabilitySnapshot } from './beatThisRuntime'
import { computeRawWaveform } from './rawWaveformBuilder'

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
  unifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData | null
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
  partialResult?: Omit<KeyResultPayload, 'mixxxWaveformData' | 'unifiedDisplayWaveformData'>
}

type KeyResponse = {
  jobId: number
  filePath: string
  progress?: KeyProgressPayload
  result?: KeyResultPayload
  error?: string
}

const K_FAST_ANALYSIS_SECONDS = 60
const BEAT_GRID_ANALYSIS_SAMPLE_RATE = 44100
const BEAT_GRID_ANALYSIS_CHANNELS = 2
const BEAT_GRID_ANALYSIS_MAX_SCAN_SEC = 120

type RustBinding = ReturnType<typeof loadRust>

type DecodedAudioPcm = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  decoderBackend?: string
  error?: string
}

type DecodedBeatGridPcm = DecodedAudioPcm & {
  decoderBackend: string
}

type DecodedWaveformPcm = DecodedBeatGridPcm

let cachedRustBinding: RustBinding | null = null

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
    decodeAudioFileNativePcm?: (
      filePath: string,
      startSec: number | null | undefined,
      maxDurationSec: number | null | undefined,
      sampleRate: number,
      channels: number
    ) => {
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
    computeMixxxWaveformWithRate?: (
      pcmData: Buffer,
      sampleRate: number,
      channels: number,
      targetRate: number
    ) => MixxxWaveformData
  }
  return binding
}

const getRustBinding = () => {
  if (cachedRustBinding) return cachedRustBinding
  cachedRustBinding = loadRust()
  return cachedRustBinding
}

const shouldUseFfmpegWaveformDecode = (filePath: string) => {
  const ext = path.extname(filePath || '').toLowerCase()
  return ext === '.mp3'
}

const decodePcmWithNative = (
  filePath: string,
  params: {
    startSec?: number
    maxDurationSec?: number
    sampleRate: number
    channels: number
    decoderBackend: string
  }
): DecodedBeatGridPcm => {
  const rust = getRustBinding()
  const decodeNative = rust.decodeAudioFileNativePcm
  if (typeof decodeNative !== 'function') {
    throw new Error('decodeAudioFileNativePcm unavailable')
  }
  const decoded = decodeNative(
    filePath,
    params.startSec ?? null,
    params.maxDurationSec ?? null,
    params.sampleRate,
    params.channels
  )
  if (decoded.error) throw new Error(decoded.error)
  if (!decoded.pcmData || decoded.pcmData.byteLength <= 0) {
    throw new Error('native decoded empty PCM')
  }
  return {
    pcmData: decoded.pcmData,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    totalFrames: decoded.totalFrames,
    decoderBackend: params.decoderBackend
  }
}

const decodeWaveformPcmWithFfmpeg = async (filePath: string): Promise<DecodedWaveformPcm> => {
  return decodePcmWithNative(filePath, {
    sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
    channels: BEAT_GRID_ANALYSIS_CHANNELS,
    decoderBackend: 'native-libav-waveform'
  })
}

const decodeBeatGridPcmForFile = async (filePath: string): Promise<DecodedBeatGridPcm> => {
  return decodePcmWithNative(filePath, {
    startSec: 0,
    maxDurationSec: BEAT_GRID_ANALYSIS_MAX_SCAN_SEC,
    sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
    channels: BEAT_GRID_ANALYSIS_CHANNELS,
    decoderBackend: 'native-libav-beat-grid'
  })
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
  const result: KeyResultPayload = {}
  const needsKey = Boolean(options.needsKey)
  const needsBpm = Boolean(options.needsBpm) && getBeatThisRuntimeAvailabilitySnapshot() !== false
  const needsWaveform = Boolean(options.needsWaveform)
  const useFfmpegWaveformDecode = needsWaveform && shouldUseFfmpegWaveformDecode(filePath)
  const useFfmpegPrimaryDecode = needsKey && useFfmpegWaveformDecode
  const needsRustDecode =
    (needsKey && !useFfmpegPrimaryDecode) || (needsWaveform && !useFfmpegWaveformDecode)
  let rust: RustBinding | null = null
  let decoded: DecodedAudioPcm | null = null
  let beatGridDecoded: DecodedBeatGridPcm | null = null
  let reusableFfmpegWaveformDecoded: DecodedWaveformPcm | null = null
  const resolveRustBinding = () => {
    if (!rust) {
      rust = getRustBinding()
    }
    return rust
  }

  if (needsRustDecode || useFfmpegPrimaryDecode || needsBpm) {
    reportProgress({
      stage: 'decode-start',
      needsKey,
      needsBpm,
      needsWaveform
    })
    const decodeStartAt = Date.now()
    if (useFfmpegPrimaryDecode) {
      reusableFfmpegWaveformDecoded = await decodeWaveformPcmWithFfmpeg(filePath)
      decoded = reusableFfmpegWaveformDecoded
    } else if (needsRustDecode) {
      const rustDecoded = resolveRustBinding().decodeAudioFile(filePath)
      if (rustDecoded.error) {
        throw new Error(rustDecoded.error)
      }
      decoded = rustDecoded
    } else {
      beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
    }
    const decodeMs = Date.now() - decodeStartAt
    const decodedMeta = decoded || beatGridDecoded
    const framesToProcess = decodedMeta
      ? estimateFramesToProcess(
          decodedMeta.totalFrames,
          decodedMeta.sampleRate,
          options.fastAnalysis
        )
      : undefined
    reportProgress({
      stage: 'decode-done',
      decodeMs,
      decodeBackend: decodedMeta?.decoderBackend,
      sampleRate: decodedMeta?.sampleRate,
      channels: decodedMeta?.channels,
      totalFrames: decodedMeta?.totalFrames,
      framesToProcess
    })
  }

  if (needsKey || needsBpm) {
    const analysisFramesToProcess = estimateFramesToProcess(
      (beatGridDecoded || decoded)?.totalFrames || 0,
      (beatGridDecoded || decoded)?.sampleRate || 0,
      options.fastAnalysis
    )
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
      framesToProcess: analysisFramesToProcess,
      detail: analyzePlanDetail
    })
    const analyzeStartAt = Date.now()
    let hasAnalysisError = false

    if (needsKey) {
      if (!decoded) {
        throw new Error('Rust PCM decode missing for key analysis')
      }
      const analyzeKey = resolveRustBinding().analyzeKeyFromPcm
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
        if (!beatGridDecoded) {
          beatGridDecoded = await decodeBeatGridPcmForFile(filePath)
        }
        const beatThisResult = await analyzeBeatGridWithBeatThisSlidingWindowsFromPcm({
          pcmData: beatGridDecoded.pcmData,
          sampleRate: beatGridDecoded.sampleRate,
          channels: beatGridDecoded.channels,
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

  if (
    needsWaveform &&
    (typeof resolveRustBinding().computeMixxxWaveformWithRate === 'function' ||
      typeof resolveRustBinding().computeMixxxWaveform === 'function')
  ) {
    if (!decoded) {
      if (!useFfmpegWaveformDecode) {
        throw new Error('Rust PCM decode missing for waveform analysis')
      }
    }
    reportProgress({ stage: 'waveform-start' })
    const waveformStartAt = Date.now()
    try {
      const targetRate = UNIFIED_DISPLAY_WAVEFORM_DETAIL_RATE
      let waveformDecoded: DecodedWaveformPcm | DecodedAudioPcm
      if (useFfmpegWaveformDecode) {
        if (reusableFfmpegWaveformDecoded) {
          waveformDecoded = reusableFfmpegWaveformDecoded
        } else {
          const ffmpegWaveformDecoded = await decodeWaveformPcmWithFfmpeg(filePath)
          reusableFfmpegWaveformDecoded = ffmpegWaveformDecoded
          waveformDecoded = ffmpegWaveformDecoded
        }
      } else {
        waveformDecoded = decoded as DecodedAudioPcm
      }
      result.mixxxWaveformData =
        typeof resolveRustBinding().computeMixxxWaveformWithRate === 'function'
          ? resolveRustBinding().computeMixxxWaveformWithRate!(
              waveformDecoded.pcmData,
              waveformDecoded.sampleRate,
              waveformDecoded.channels,
              targetRate
            )
          : resolveRustBinding().computeMixxxWaveform!(
              waveformDecoded.pcmData,
              waveformDecoded.sampleRate,
              waveformDecoded.channels
            )
      const rawWaveformData = computeRawWaveform(
        waveformDecoded.pcmData,
        waveformDecoded.sampleRate,
        waveformDecoded.channels,
        COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE
      )
      result.unifiedDisplayWaveformData = result.mixxxWaveformData
        ? buildUnifiedDisplayWaveformDetailFromMixxx(result.mixxxWaveformData, rawWaveformData)
        : null
      reportProgress({
        stage: 'waveform-done',
        waveformMs: Date.now() - waveformStartAt,
        detail: String(waveformDecoded.decoderBackend || '').startsWith('ffmpeg-')
          ? 'waveform-ok:ffmpeg'
          : 'waveform-ok'
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
