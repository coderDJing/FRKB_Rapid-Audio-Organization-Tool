import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { log } from '../../log'
import { resolveBundledFfmpegPath } from '../../ffmpeg'

const FRKB_RKB_LIST_NAME = 'rkb'
const SNAPSHOT_FILE_NAME = 'rkbRekordboxAbcGridSnapshot.json'

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
const startTimeCache = new Map<string, number>()

const execFileAsync = promisify(execFile)

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

const normalizeTimeBasisOffsetMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Number((numeric * 1000).toFixed(3))
}

const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

const resolveFileStartTimeMs = async (filePath: string) => {
  const normalizedPath = normalizeText(filePath)
  if (!normalizedPath) return 0
  const cached = startTimeCache.get(normalizedPath)
  if (cached !== undefined) return cached
  const ffprobePath = resolveBundledFfprobePath()
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'stream=index,codec_type,start_time',
        '-select_streams',
        'a:0',
        normalizedPath
      ],
      {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024
      }
    )
    const payload = JSON.parse(String(stdout || '{}')) as {
      streams?: Array<{ start_time?: string | number }>
    }
    const startTimeMs = normalizeTimeBasisOffsetMs(payload?.streams?.[0]?.start_time)
    startTimeCache.set(normalizedPath, startTimeMs)
    return startTimeMs
  } catch (error) {
    log.error('[rkb-snapshot] probe file start_time failed', {
      filePath: normalizedPath,
      error: error instanceof Error ? error.message : String(error)
    })
    startTimeCache.set(normalizedPath, 0)
    return 0
  }
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
  return {
    bpm,
    firstBeatMs,
    barBeatOffset,
    timeBasisOffsetMs: 0,
    sourcePlaylistName: 'abc',
    sourceFileName
  }
}

const loadSnapshotGridMap = async (): Promise<Map<string, RkbRekordboxGridValue>> => {
  const snapshotPath = await resolveSnapshotPath()
  if (!snapshotPath) {
    log.info('[rkb-snapshot] no snapshot path candidate resolved')
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
  log.info('[rkb-snapshot] snapshot loaded', {
    snapshotPath,
    trackCount: map.size
  })
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
  if (matched) {
    const timeBasisOffsetMs = await resolveFileStartTimeMs(filePath)
    const effective = {
      ...matched,
      timeBasisOffsetMs
    }
    log.info('[rkb-snapshot] hit', {
      filePath,
      lookupKey,
      sourceFileName: matched.sourceFileName,
      bpm: effective.bpm,
      firstBeatMs: effective.firstBeatMs,
      timeBasisOffsetMs: effective.timeBasisOffsetMs,
      barBeatOffset: effective.barBeatOffset
    })
    return effective
  }
  log.info('[rkb-snapshot] miss', {
    filePath,
    lookupKey,
    snapshotTrackCount: map.size
  })
  return null
}
