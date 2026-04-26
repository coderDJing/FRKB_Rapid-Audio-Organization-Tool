import { parentPort } from 'node:worker_threads'
import childProcess from 'node:child_process'
import type { MixxxWaveformData } from '../waveformCache'
import { analyzeBeatGridWithBeatThisSlidingWindowsFromPcm } from './beatThisAnalyzer'

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
  beatThisEstimatedDrift128Ms?: number
  beatThisWindowCount?: number
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
const BEAT_GRID_ANALYSIS_SAMPLE_RATE = 44100
const BEAT_GRID_ANALYSIS_CHANNELS = 2
const BEAT_GRID_ANALYSIS_MAX_SCAN_SEC = 120

type RustBinding = ReturnType<typeof loadRust>

type DecodedBeatGridPcm = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  decoderBackend: string
}

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

const getRustBinding = () => {
  if (cachedRustBinding) return cachedRustBinding
  cachedRustBinding = loadRust()
  return cachedRustBinding
}

const resolveBeatGridFfmpegPath = () => {
  const ffmpegPath = String(process.env.FRKB_FFMPEG_PATH || '').trim()
  if (!ffmpegPath) {
    throw new Error('FRKB_FFMPEG_PATH not configured for beat grid decode')
  }
  return ffmpegPath
}

const decodeBeatGridPcmForFile = async (filePath: string): Promise<DecodedBeatGridPcm> => {
  const ffmpegPath = resolveBeatGridFfmpegPath()
  const chunks: Buffer[] = []
  let stderrText = ''

  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(
      ffmpegPath,
      [
        '-v',
        'error',
        '-threads',
        '1',
        '-ss',
        '0',
        '-t',
        String(BEAT_GRID_ANALYSIS_MAX_SCAN_SEC),
        '-i',
        filePath,
        '-f',
        'f32le',
        '-acodec',
        'pcm_f32le',
        '-ac',
        String(BEAT_GRID_ANALYSIS_CHANNELS),
        '-ar',
        String(BEAT_GRID_ANALYSIS_SAMPLE_RATE),
        'pipe:1'
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    child.stdout.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrText += chunk.toString()
      if (stderrText.length > 4000) {
        stderrText = stderrText.slice(-4000)
      }
    })
    child.once('error', (error) => reject(error))
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderrText.trim() || `FFmpeg exited with code ${code}`))
    })
  })

  const pcmData = Buffer.concat(chunks)
  const frameByteSize = BEAT_GRID_ANALYSIS_CHANNELS * 4
  const usableByteLength = pcmData.byteLength - (pcmData.byteLength % frameByteSize)
  if (usableByteLength <= 0) {
    throw new Error('FFmpeg decoded empty PCM for beat grid')
  }
  const normalizedPcmData =
    usableByteLength === pcmData.byteLength ? pcmData : pcmData.subarray(0, usableByteLength)
  return {
    pcmData: normalizedPcmData,
    sampleRate: BEAT_GRID_ANALYSIS_SAMPLE_RATE,
    channels: BEAT_GRID_ANALYSIS_CHANNELS,
    totalFrames: usableByteLength / frameByteSize,
    decoderBackend: 'ffmpeg-beat-grid'
  }
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
  const needsBpm = Boolean(options.needsBpm)
  const needsWaveform = Boolean(options.needsWaveform)
  const needsRustDecode = needsKey || needsWaveform
  let rust: RustBinding | null = null
  let decoded: ReturnType<RustBinding['decodeAudioFile']> | null = null
  let beatGridDecoded: DecodedBeatGridPcm | null = null
  const resolveRustBinding = () => {
    if (!rust) {
      rust = getRustBinding()
    }
    return rust
  }

  if (needsRustDecode || needsBpm) {
    reportProgress({
      stage: 'decode-start',
      needsKey: options.needsKey,
      needsBpm: options.needsBpm,
      needsWaveform: options.needsWaveform
    })
    const decodeStartAt = Date.now()
    if (needsRustDecode) {
      decoded = resolveRustBinding().decodeAudioFile(filePath)
      if (decoded.error) {
        throw new Error(decoded.error)
      }
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
        result.beatThisEstimatedDrift128Ms = beatThisResult.beatThisEstimatedDrift128Ms
        result.beatThisWindowCount = beatThisResult.beatThisWindowCount
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

  if (needsWaveform && typeof resolveRustBinding().computeMixxxWaveform === 'function') {
    if (!decoded) {
      throw new Error('Rust PCM decode missing for waveform analysis')
    }
    reportProgress({ stage: 'waveform-start' })
    const waveformStartAt = Date.now()
    try {
      result.mixxxWaveformData = resolveRustBinding().computeMixxxWaveform!(
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
