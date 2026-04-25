import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { log } from '../../log'
import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'

const FRKB_RKB_LIST_NAME = 'rkb'
const SNAPSHOT_FILE_NAME = 'rkbRekordboxGridSnapshot.json'

type SnapshotTrack = {
  fileName?: unknown
  title?: unknown
  artist?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
}

type SnapshotPayload = {
  source?: {
    playlistName?: unknown
  }
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

const resolveSnapshotPathCandidates = (snapshotFileName: string) => {
  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = (candidate: string) => {
    const normalized = normalizeText(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  if (app.isPackaged) {
    addCandidate(path.join(process.resourcesPath, snapshotFileName))
    addCandidate(path.join(process.resourcesPath, 'resources', snapshotFileName))
  }

  addCandidate(path.resolve(__dirname, '../../../..', 'resources', snapshotFileName))
  addCandidate(path.resolve(process.cwd(), 'resources', snapshotFileName))

  return candidates
}

const resolveSnapshotPath = async (snapshotFileName: string) => {
  const candidates = resolveSnapshotPathCandidates(snapshotFileName)
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {}
  }
  return ''
}

const buildGridValue = (
  track: SnapshotTrack | null | undefined,
  sourcePlaylistName: string
): RkbRekordboxGridValue | null => {
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
    sourcePlaylistName,
    sourceFileName
  }
}

const loadSnapshotGridMapFromFile = async (
  snapshotFileName: string
): Promise<Map<string, RkbRekordboxGridValue>> => {
  const snapshotPath = await resolveSnapshotPath(snapshotFileName)
  if (!snapshotPath) {
    return new Map()
  }
  const raw = await fs.readFile(snapshotPath, 'utf-8')
  const payload = JSON.parse(raw) as SnapshotPayload
  const sourcePlaylistName = normalizeText(payload?.source?.playlistName) || snapshotFileName
  const map = new Map<string, RkbRekordboxGridValue>()
  for (const track of Array.isArray(payload?.tracks) ? payload.tracks : []) {
    const gridValue = buildGridValue(track, sourcePlaylistName)
    if (!gridValue) continue
    const lookupKey = normalizeLookupKey(gridValue.sourceFileName)
    if (!lookupKey || map.has(lookupKey)) continue
    map.set(lookupKey, gridValue)
  }
  return map
}

const loadSnapshotGridMap = async (): Promise<Map<string, RkbRekordboxGridValue>> => {
  return await loadSnapshotGridMapFromFile(SNAPSHOT_FILE_NAME)
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
    timeBasisOffsetMs: await resolveAudioTimeBasisOffsetMsForFile(filePath)
  }
}
