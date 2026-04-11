import fs from 'node:fs'
import type { MixtapeStemMode } from '../mixtapeDb'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import { getLibraryDb, isSqliteRow } from '../libraryDb'
import { log } from '../log'
import { resolveMixtapeStemStatusFromInfo } from '../mixtapeStemDb'
import { requestBackgroundTaskExecution } from './backgroundOrchestrator'
import { enqueueMixtapeStemJobs } from './mixtapeStemQueue'

const STEM_BACKGROUND_INITIAL_DELAY_MS = 30_000
const STEM_BACKGROUND_SCAN_INTERVAL_MS = 3 * 60 * 1000
const STEM_BACKGROUND_SCAN_TRACK_LIMIT = 120
const STEM_BACKGROUND_SCAN_PLAYLIST_LIMIT = 12

type MixtapeStemBackgroundResumeGroup = {
  playlistId: string
  stemMode: MixtapeStemMode
  model?: string
  stemVersion?: string
  filePaths: string[]
}

let backgroundResumeEnabled = false
let backgroundResumeTimer: ReturnType<typeof setTimeout> | null = null
let backgroundResumeRunning = false

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

const normalizeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE

const parseTrackInfoJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return isSqliteRow(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const collectBackgroundResumeGroups = (
  trackLimit = STEM_BACKGROUND_SCAN_TRACK_LIMIT,
  playlistLimit = STEM_BACKGROUND_SCAN_PLAYLIST_LIMIT
): MixtapeStemBackgroundResumeGroup[] => {
  const db = getLibraryDb()
  if (!db) return []
  const safeTrackLimit = Math.max(1, Number(trackLimit) || STEM_BACKGROUND_SCAN_TRACK_LIMIT)
  const safePlaylistLimit = Math.max(
    1,
    Number(playlistLimit) || STEM_BACKGROUND_SCAN_PLAYLIST_LIMIT
  )
  let rows: Array<{
    playlist_uuid: string
    stem_mode: string
    file_path: string
    info_json?: string | null
  }> = []
  try {
    rows = db
      .prepare<{
        playlist_uuid: string
        stem_mode: string
        file_path: string
        info_json?: string | null
      }>(
        `SELECT i.playlist_uuid, p.stem_mode, i.file_path, i.info_json
         FROM mixtape_items i
         INNER JOIN mixtape_projects p ON p.playlist_uuid = i.playlist_uuid
         WHERE p.mix_mode = 'stem'
         ORDER BY i.playlist_uuid ASC, i.mix_order ASC, i.created_at_ms ASC`
      )
      .all()
  } catch (error) {
    log.error('[mixtape-stem] collect background resume groups failed', { error })
    return []
  }
  if (!rows.length) return []

  const groups = new Map<
    string,
    {
      playlistId: string
      stemMode: MixtapeStemMode
      model?: string
      stemVersion?: string
      filePathSet: Set<string>
    }
  >()
  const playlistSet = new Set<string>()
  let selectedTracks = 0

  for (const row of rows) {
    const playlistId = normalizePlaylistId(row?.playlist_uuid)
    if (!playlistId) continue
    const isNewPlaylist = !playlistSet.has(playlistId)
    if (isNewPlaylist && playlistSet.size >= safePlaylistLimit) break

    const filePath = normalizeFilePath(row?.file_path)
    if (!filePath || !fs.existsSync(filePath)) continue

    const stemStatus = resolveMixtapeStemStatusFromInfo(row?.info_json)
    if (stemStatus === 'ready') continue

    if (isNewPlaylist) {
      playlistSet.add(playlistId)
    }

    const info = parseTrackInfoJson(row?.info_json)
    const stemMode = normalizeStemMode(row?.stem_mode)
    const model = normalizeText(info?.stemModel, 128) || undefined
    const stemVersion = normalizeText(info?.stemVersion, 128) || undefined
    const groupKey = `${playlistId}::${stemMode}::${model || ''}::${stemVersion || ''}`
    const group = groups.get(groupKey)
    if (group) {
      group.filePathSet.add(filePath)
    } else {
      groups.set(groupKey, {
        playlistId,
        stemMode,
        model,
        stemVersion,
        filePathSet: new Set<string>([filePath])
      })
    }
    selectedTracks += 1
    if (selectedTracks >= safeTrackLimit) break
  }

  return Array.from(groups.values())
    .map((group) => ({
      playlistId: group.playlistId,
      stemMode: group.stemMode,
      model: group.model,
      stemVersion: group.stemVersion,
      filePaths: Array.from(group.filePathSet)
    }))
    .filter((group) => group.filePaths.length > 0)
}

const clearBackgroundResumeTimer = () => {
  if (!backgroundResumeTimer) return
  clearTimeout(backgroundResumeTimer)
  backgroundResumeTimer = null
}

const scheduleNextBackgroundResumeScan = (delayMs = STEM_BACKGROUND_SCAN_INTERVAL_MS) => {
  if (!backgroundResumeEnabled) return
  if (backgroundResumeTimer) return
  const safeDelay = Math.max(1000, Number(delayMs) || STEM_BACKGROUND_SCAN_INTERVAL_MS)
  backgroundResumeTimer = setTimeout(() => {
    backgroundResumeTimer = null
    requestBackgroundTaskExecution({
      category: 'mixtape-stem-resume',
      trigger: 'mixtape-stem-resume-timer',
      run: runBackgroundResumeScan
    })
  }, safeDelay)
}

const runBackgroundResumeScan = async () => {
  if (!backgroundResumeEnabled) return
  if (backgroundResumeRunning) return
  backgroundResumeRunning = true
  try {
    const groups = collectBackgroundResumeGroups()
    if (!groups.length) return
    for (const group of groups) {
      if (!backgroundResumeEnabled) break
      if (!group.filePaths.length) continue
      await enqueueMixtapeStemJobs({
        playlistId: group.playlistId,
        filePaths: group.filePaths,
        stemMode: group.stemMode,
        force: false,
        model: group.model,
        stemVersion: group.stemVersion,
        source: 'background'
      })
    }
  } catch (error) {
    log.error('[mixtape-stem] background resume scan failed', { error })
  } finally {
    backgroundResumeRunning = false
    scheduleNextBackgroundResumeScan()
  }
}

export function startMixtapeStemBackgroundResume(): void {
  if (backgroundResumeEnabled) return
  backgroundResumeEnabled = true
  scheduleNextBackgroundResumeScan(STEM_BACKGROUND_INITIAL_DELAY_MS)
}

export function stopMixtapeStemBackgroundResume(): void {
  backgroundResumeEnabled = false
  clearBackgroundResumeTimer()
}
