import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const FFPROBE_TIMEOUT_MS = 5000
const execFileAsync = promisify(execFile)

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

export type AudioTimeBasisOffsetProbeResult = {
  offsetMs: number
  error?: string
}

const parsePositiveNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const toFixedMs = (value: number) => Number(value.toFixed(3))

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

const ZERO_TIME_BASIS_EXTENSIONS = new Set(['.wav', '.wave', '.aif', '.aiff', '.flac'])

const buildFfprobeArgs = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase()
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'stream=start_time,sample_rate:stream_tags=encoder:packet_side_data=side_data_type,skip_samples',
    '-select_streams',
    'a:0'
  ]
  if (extension === '.mp3') {
    args.push('-show_packets', '-read_intervals', '%+#1')
  }
  args.push(filePath)
  return args
}

export const probeAudioTimeBasisOffsetMs = async (
  ffprobePath: string,
  filePath: string
): Promise<AudioTimeBasisOffsetProbeResult> => {
  if (!ffprobePath || !existsSync(ffprobePath)) return { offsetMs: 0 }
  const extension = path.extname(filePath).toLowerCase()
  if (ZERO_TIME_BASIS_EXTENSIONS.has(extension)) return { offsetMs: 0 }

  try {
    const { stdout } = await execFileAsync(ffprobePath, buildFfprobeArgs(filePath), {
      windowsHide: true,
      timeout: FFPROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024
    })
    const parsed = JSON.parse(String(stdout || '{}')) as FfprobeAudioPayload
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
    const startTimeSec = parsePositiveNumber(stream?.start_time)
    if (!startTimeSec) return { offsetMs: 0 }

    const sampleRate = parsePositiveNumber(stream?.sample_rate)
    const skipSamples = resolveFirstPacketSkipSamples(
      Array.isArray(parsed.packets) ? parsed.packets[0] : undefined
    )
    const skipSamplesMs = sampleRate > 0 ? (skipSamples / sampleRate) * 1000 : 0
    const startTimeMs = startTimeSec * 1000
    const gaplessSkipOffsetMs =
      skipSamplesMs > 0 && shouldApplyLameGaplessSkipOffset(stream) ? skipSamplesMs : 0
    return { offsetMs: toFixedMs(startTimeMs + gaplessSkipOffsetMs) }
  } catch (error) {
    return {
      offsetMs: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
