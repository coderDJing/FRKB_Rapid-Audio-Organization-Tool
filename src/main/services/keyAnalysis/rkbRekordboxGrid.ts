import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { resolveBundledFfmpegPath } from '../../ffmpeg'
import { log } from '../../log'

const FRKB_RKB_LIST_NAME = 'rkb'
const SNAPSHOT_FILE_NAME = 'rkbRekordboxAbcGridSnapshot.json'
const FFPROBE_TIMEOUT_MS = 5000

const execFileAsync = promisify(execFile)

type SnapshotTrack = {
  fileName?: unknown
  title?: unknown
  artist?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
}

type SnapshotPayload = {
  tracks?: SnapshotTrack[]
}

type RkbRekordboxGridValue = {
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  timeBasisOffsetMs: number
  sourcePlaylistName: string
  sourceFileName: string
}

let cache: Map<string, RkbRekordboxGridValue> | null = null
let inFlight: Promise<Map<string, RkbRekordboxGridValue>> | null = null
const timeBasisOffsetCache = new Map<string, Promise<number>>()

const normalizeText = (value: unknown) => String(value || '').trim()

const normalizeLookupKey = (value: unknown) => normalizeText(value).toLowerCase()

const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Number(numeric.toFixed(6))
}

const normalizeFirstBeatMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  return Number(numeric.toFixed(3))
}

const normalizeBarBeatOffset = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.round(numeric)
  return ((rounded % 32) + 32) % 32
}

const resolveSnapshotPathCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = (candidate: string) => {
    const normalized = normalizeText(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  if (app.isPackaged) {
    addCandidate(path.join(process.resourcesPath, SNAPSHOT_FILE_NAME))
    addCandidate(path.join(process.resourcesPath, 'resources', SNAPSHOT_FILE_NAME))
  }

  addCandidate(path.resolve(__dirname, '../../../..', 'resources', SNAPSHOT_FILE_NAME))
  addCandidate(path.resolve(process.cwd(), 'resources', SNAPSHOT_FILE_NAME))

  return candidates
}

const resolveSnapshotPath = async () => {
  for (const candidate of resolveSnapshotPathCandidates()) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {}
  }
  return resolveSnapshotPathCandidates()[0] || ''
}

const buildGridValue = (track: SnapshotTrack | null | undefined): RkbRekordboxGridValue | null => {
  const sourceFileName = normalizeText(track?.fileName)
  const bpm = normalizeBpm(track?.bpm)
  const firstBeatMs = normalizeFirstBeatMs(track?.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(track?.barBeatOffset)
  if (
    !sourceFileName ||
    bpm === undefined ||
    firstBeatMs === undefined ||
    barBeatOffset === undefined
  ) {
    return null
  }
  // Rekordbox 的 grid 时间戳保持原样；timeBasisOffsetMs 在命中文件后按 FFmpeg
  // stream start_time + LAME gapless skip_samples 元数据探测，用于把 FFmpeg 解码输出轴
  // 映射回 Rekordbox 时间轴。
  return {
    bpm,
    firstBeatMs,
    barBeatOffset,
    timeBasisOffsetMs: 0,
    sourcePlaylistName: 'abc',
    sourceFileName
  }
}

const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

type FfprobeRkbAudioPacketSideData = {
  side_data_type?: string
  skip_samples?: number | string
}

type FfprobeRkbAudioPacket = {
  side_data_list?: FfprobeRkbAudioPacketSideData[]
}

type FfprobeRkbAudioStream = {
  sample_rate?: string
  start_time?: string
  tags?: {
    encoder?: string
  }
}

type FfprobeRkbAudioPayload = {
  packets?: FfprobeRkbAudioPacket[]
  streams?: FfprobeRkbAudioStream[]
}

const toFixedMs = (value: number) => Number(value.toFixed(3))

const parsePositiveNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const resolveFirstPacketSkipSamples = (packet: FfprobeRkbAudioPacket | undefined) => {
  const sideDataList = Array.isArray(packet?.side_data_list) ? packet.side_data_list : []
  for (const sideData of sideDataList) {
    if (String(sideData?.side_data_type || '') !== 'Skip Samples') continue
    return parsePositiveNumber(sideData?.skip_samples)
  }
  return 0
}

const shouldApplyLameGaplessSkipOffset = (stream: FfprobeRkbAudioStream | undefined) => {
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
    const parsed = JSON.parse(String(stdout || '{}')) as FfprobeRkbAudioPayload
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
    log.error('[rkb-rekordbox-grid] probe ffmpeg time basis failed', {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return 0
  }
}

const resolveTimeBasisOffsetMsForFile = async (filePath: string) => {
  const cacheKey = normalizeLookupKey(path.resolve(filePath))
  if (!cacheKey) return 0
  let promise = timeBasisOffsetCache.get(cacheKey)
  if (!promise) {
    promise = probeFfmpegTimeBasisOffsetMs(filePath)
    timeBasisOffsetCache.set(cacheKey, promise)
  }
  return await promise
}

const loadSnapshotGridMap = async (): Promise<Map<string, RkbRekordboxGridValue>> => {
  const snapshotPath = await resolveSnapshotPath()
  if (!snapshotPath) {
    return new Map()
  }
  const raw = await fs.readFile(snapshotPath, 'utf-8')
  const payload = JSON.parse(raw) as SnapshotPayload
  const map = new Map<string, RkbRekordboxGridValue>()
  for (const track of Array.isArray(payload?.tracks) ? payload.tracks : []) {
    const gridValue = buildGridValue(track)
    if (!gridValue) continue
    const lookupKey = normalizeLookupKey(gridValue.sourceFileName)
    if (!lookupKey || map.has(lookupKey)) continue
    map.set(lookupKey, gridValue)
  }
  return map
}

const getCachedSnapshotGridMap = async () => {
  if (cache) return cache
  if (inFlight) return await inFlight

  inFlight = loadSnapshotGridMap()
    .catch((error) => {
      log.error('[rkb-rekordbox-grid] load snapshot failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return new Map<string, RkbRekordboxGridValue>()
    })
    .finally(() => {
      inFlight = null
    })

  cache = await inFlight
  return cache
}

export const isRkbRekordboxGridBypassSongListRoot = (listRoot: string) =>
  normalizeLookupKey(path.basename(normalizeText(listRoot))) === FRKB_RKB_LIST_NAME

export const resolveRkbRekordboxGridForFile = async (
  listRoot: string,
  filePath: string
): Promise<RkbRekordboxGridValue | null> => {
  if (!isRkbRekordboxGridBypassSongListRoot(listRoot)) {
    return null
  }
  const lookupKey = normalizeLookupKey(path.basename(normalizeText(filePath)))
  if (!lookupKey) return null
  const map = await getCachedSnapshotGridMap()
  const matched = map.get(lookupKey) || null
  if (!matched) return null
  return {
    ...matched,
    timeBasisOffsetMs: await resolveTimeBasisOffsetMsForFile(filePath)
  }
}
