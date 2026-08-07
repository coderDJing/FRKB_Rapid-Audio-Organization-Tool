import path from 'node:path'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { log } from '../log'
import { probeAudioTimeBasisOffsetMs } from './audioTimeBasisOffsetProbe'

export const CURRENT_AUDIO_TIME_BASIS_OFFSET_ALGORITHM_VERSION = 1

const timeBasisOffsetCache = new Map<string, Promise<number>>()
const toFixedMs = (value: number) => Number(value.toFixed(3))

const normalizeLookupKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

export const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

const probeFfmpegTimeBasisOffsetMs = async (filePath: string): Promise<number> => {
  let ffprobePath = ''
  try {
    ffprobePath = resolveBundledFfprobePath()
  } catch {
    return 0
  }
  const result = await probeAudioTimeBasisOffsetMs(ffprobePath, filePath)
  if (result.error) {
    log.error('[audio-time-basis] probe ffmpeg time basis failed', {
      filePath,
      error: result.error
    })
  }
  return result.offsetMs
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

export const hasCachedAudioTimeBasisOffsetMsForFile = (filePath: string) => {
  const cacheKey = normalizeLookupKey(path.resolve(filePath))
  return Boolean(cacheKey && timeBasisOffsetCache.has(cacheKey))
}

export const resolveAudioFirstBeatTimelineMs = (
  firstBeatAudioMs: number,
  timeBasisOffsetMs: number
) =>
  toFixedMs(
    (Number.isFinite(Number(firstBeatAudioMs)) ? Number(firstBeatAudioMs) : 0) +
      Math.max(0, Number(timeBasisOffsetMs) || 0)
  )
