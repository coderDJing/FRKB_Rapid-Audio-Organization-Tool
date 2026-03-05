import fs from 'node:fs'
import { is } from '@electron-toolkit/utils'
import type { MixtapeStemMode } from '../mixtapeDb'
import { getLibraryDb } from '../libraryDb'
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

const debugDev = (message: string, payload?: unknown) => {
  if (!is.dev) return
  if (payload === undefined) {
    log.debug(`[mixtape-stem][dev] ${message}`)
    return
  }
  log.debug(`[mixtape-stem][dev] ${message}`, payload)
}

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

const normalizeStemMode = (_value: unknown): MixtapeStemMode => '4stems'

const parseTrackInfoJson = (raw: unknown): Record<string, any> => {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
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
      .prepare(
        `SELECT i.playlist_uuid, p.stem_mode, i.file_path, i.info_json
         FROM mixtape_items i
         INNER JOIN mixtape_projects p ON p.playlist_uuid = i.playlist_uuid
         WHERE p.mix_mode = 'stem' AND p.stem_strategy_confirmed = 1
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
  debugDev('调度下一轮后台续跑扫描', { delayMs: safeDelay })
  backgroundResumeTimer = setTimeout(() => {
    backgroundResumeTimer = null
    debugDev('触发后台续跑扫描定时器')
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
    debugDev('开始后台续跑扫描')
    const groups = collectBackgroundResumeGroups()
    if (!groups.length) {
      debugDev('扫描未命中可续跑任务')
      return
    }
    debugDev('扫描命中可续跑任务', {
      groupCount: groups.length,
      trackCount: groups.reduce((sum, group) => sum + group.filePaths.length, 0)
    })
    let touchedGroups = 0
    let touchedTracks = 0
    let queued = 0
    let merged = 0
    let readyFromCache = 0
    for (const group of groups) {
      if (!backgroundResumeEnabled) break
      if (!group.filePaths.length) continue
      touchedGroups += 1
      touchedTracks += group.filePaths.length
      const result = await enqueueMixtapeStemJobs({
        playlistId: group.playlistId,
        filePaths: group.filePaths,
        stemMode: group.stemMode,
        force: false,
        model: group.model,
        stemVersion: group.stemVersion
      })
      queued += result.queued
      merged += result.merged
      readyFromCache += result.readyFromCache
      debugDev('后台续跑分组入队结果', {
        playlistId: group.playlistId,
        trackCount: group.filePaths.length,
        queued: result.queued,
        merged: result.merged,
        readyFromCache: result.readyFromCache,
        skipped: result.skipped
      })
    }
    if (queued > 0 || merged > 0) {
      log.info('[mixtape-stem] background resume scan enqueued', {
        touchedGroups,
        touchedTracks,
        queued,
        merged,
        readyFromCache
      })
    }
    if (queued === 0 && merged === 0) {
      debugDev('本轮扫描未产生新入队任务', {
        touchedGroups,
        touchedTracks,
        readyFromCache
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
  debugDev('启动后台续跑服务', {
    initialDelayMs: STEM_BACKGROUND_INITIAL_DELAY_MS,
    scanIntervalMs: STEM_BACKGROUND_SCAN_INTERVAL_MS,
    trackLimit: STEM_BACKGROUND_SCAN_TRACK_LIMIT,
    playlistLimit: STEM_BACKGROUND_SCAN_PLAYLIST_LIMIT
  })
  scheduleNextBackgroundResumeScan(STEM_BACKGROUND_INITIAL_DELAY_MS)
}

export function stopMixtapeStemBackgroundResume(): void {
  backgroundResumeEnabled = false
  clearBackgroundResumeTimer()
  debugDev('停止后台续跑服务')
}
