import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { log } from '../log'

const FFPROBE_TIMEOUT_MS = 5000

const execFileAsync = promisify(execFile)
const timeBasisOffsetCache = new Map<string, Promise<number>>()

type FfprobeAudioPacketSideData = {
  side_data_type?: string
  skip_samples?: number | string
}

type FfprobeAudioPacket = {
  side_data_list?: FfprobeAudioPacketSideData[]
}

type FfprobeAudioStream = {
  sample_rate?: string
  start_time?: string
  tags?: {
    encoder?: string
  }
}

type FfprobeAudioPayload = {
  packets?: FfprobeAudioPacket[]
  streams?: FfprobeAudioStream[]
}

const normalizeLookupKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const toFixedMs = (value: number) => Number(value.toFixed(3))

const parsePositiveNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

const resolveFirstPacketSkipSamples = (packet: FfprobeAudioPacket | undefined) => {
  const sideDataList = Array.isArray(packet?.side_data_list) ? packet.side_data_list : []
  for (const sideData of sideDataList) {
    if (String(sideData?.side_data_type || '') !== 'Skip Samples') continue
    return parsePositiveNumber(sideData?.skip_samples)
  }
  return 0
}

const shouldApplyLameGaplessSkipOffset = (stream: FfprobeAudioStream | undefined) => {
  const encoder = String(stream?.tags?.encoder || '').trim()
  return encoder.startsWith('LAME')
}

const probeFfmpegTimeBasisOffsetMs = async (filePath: string): Promise<number> => {
  let ffprobePath = ''
  try {
    ffprobePath = resolveBundledFfprobePath()
  } catch {
    return 0
  }
  if (!ffprobePath || !existsSync(ffprobePath)) return 0

  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'stream=start_time,sample_rate:stream_tags=encoder:packet_side_data=side_data_type,skip_samples',
        '-show_packets',
        '-read_intervals',
        '%+#1',
        '-select_streams',
        'a:0',
        filePath
      ],
      {
        windowsHide: true,
        timeout: FFPROBE_TIMEOUT_MS,
        maxBuffer: 256 * 1024
      }
    )
    const parsed = JSON.parse(String(stdout || '{}')) as FfprobeAudioPayload
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
    const startTimeSec = parsePositiveNumber(stream?.start_time)
    if (!startTimeSec) return 0

    const sampleRate = parsePositiveNumber(stream?.sample_rate)
    const skipSamples = resolveFirstPacketSkipSamples(
      Array.isArray(parsed.packets) ? parsed.packets[0] : undefined
    )
    const skipSamplesMs = sampleRate > 0 ? (skipSamples / sampleRate) * 1000 : 0
    const startTimeMs = startTimeSec * 1000
    const gaplessSkipOffsetMs =
      skipSamplesMs > 0 && shouldApplyLameGaplessSkipOffset(stream) ? skipSamplesMs : 0
    return toFixedMs(startTimeMs + gaplessSkipOffsetMs)
  } catch (error) {
    log.error('[audio-time-basis] probe ffmpeg time basis failed', {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return 0
  }
}

export const resolveAudioTimeBasisOffsetMsForFile = async (filePath: string) => {
  const cacheKey = normalizeLookupKey(path.resolve(filePath))
  if (!cacheKey) return 0
  let promise = timeBasisOffsetCache.get(cacheKey)
  if (!promise) {
    promise = probeFfmpegTimeBasisOffsetMs(filePath)
    timeBasisOffsetCache.set(cacheKey, promise)
  }
  return await promise
}

export const resolveAudioFirstBeatTimelineMs = (
  firstBeatAudioMs: number,
  timeBasisOffsetMs: number
) =>
  toFixedMs(
    (Number.isFinite(Number(firstBeatAudioMs)) ? Number(firstBeatAudioMs) : 0) +
      Math.max(0, Number(timeBasisOffsetMs) || 0)
  )
