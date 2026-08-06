import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { EXTERNAL_PLAYLIST_UUID } from '../../shared/externalPlayback'
import { scheduleSongListPostScanTasks } from '../services/scanSongs'
import { scanSongListOffMainThread } from '../services/songListScanWorker'
import {
  hasCachedAudioTimeBasisOffsetMsForFile,
  resolveAudioTimeBasisOffsetMsForFile
} from '../services/audioTimeBasisOffset'
import { resolveCanonicalSongBeatGridV2 } from '../../shared/songAnalysisCompleteness'
import * as LibraryCacheDb from '../libraryCacheDb'
import { findSongListRoot } from '../services/cacheMaintenance'
import { beginPlaylistScanDiagnostic } from '../services/playlistScanDiagnostics'
import {
  countSongListTracksBatchOffMainThread,
  countSongListTracksOffMainThread
} from '../services/songListTrackCount'
import {
  collectFilesWithExtensions,
  getSongsAnalyseResult,
  resolveLibraryPath,
  runWithConcurrency
} from '../utils'
import { isSupportedAudioPath } from '../services/externalOpenQueue'
import { moveFileToRecycleBin, normalizeRendererPlaylistPath } from '../recycleBinService'
import { protectSetReferencedFilesForDeletion } from './setListHandlers'
import { findLibraryNodeByPath, findSongListRootByPath } from '../libraryTreeDb'
import {
  cancelPlaylistBatchRename,
  executePlaylistBatchRename,
  previewPlaylistBatchRename
} from '../services/playlistBatchRename'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import {
  compactSongListTrackNumbers,
  compactSongListTrackNumbersByFilePaths,
  setSongListTrackNumbersByOrder
} from '../services/playlistTrackNumbers'
import { prepareExternalPlaybackPlaylistAnalysis } from '../services/pioneerDeviceLibrary/playlistAnalysis'
import type {
  IBatchRenameExecutionRequestItem,
  IBatchRenameTemplateSegment,
  IBatchRenameTrackInput,
  ISongInfo
} from '../../types/globals'
import { assertLibraryMergeMutationAllowed } from '../services/libraryMerge/runtime'

type DeduplicateSongListPayload =
  | string
  | {
      songListPath?: string
      progressId?: string
    }

type AudioConvertCollectFilesPayload = {
  songLists?: Array<{
    songListPath?: string | string[]
    songListUUID?: string
  }>
  progressId?: string
  titleKey?: string
}

type ReorderSongListTrackNumbersPayload = {
  songListPath?: string
  orderedFilePaths?: string[]
}

type CompactSongListTrackNumbersPayload = {
  songListPath?: string
  filePaths?: string[]
}

type PlaylistScanDiagnosticContext = {
  traceId?: string
  source?: string
}

type TimeBasisRepairDiagnostics = {
  candidateCount: number
  cacheHitCount: number
  cacheMissCount: number
  extensionCounts: Record<string, number>
  taskLaunchDurationMs: number
  totalDurationMs: number
  resolveDurationTotalMs: number
  resolveDurationMaxMs: number
  resolvedNonZeroCount: number
  cachePersistenceDurationTotalMs: number
  cachePersistenceDurationMaxMs: number
  cacheUpsertAttemptedCount: number
  cacheUpsertSucceededCount: number
  cacheRootMissingCount: number
  fileStatMissingCount: number
}

let playlistScanDiagnosticSequence = 0

const normalizeDiagnosticText = (value: unknown, maxLength: number) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '-')
    .slice(0, maxLength)

const createPlaylistScanTraceId = (requestedTraceId: unknown) => {
  const normalized = normalizeDiagnosticText(requestedTraceId, 80)
  if (normalized) return normalized
  playlistScanDiagnosticSequence += 1
  return `main-${Date.now().toString(36)}-${playlistScanDiagnosticSequence.toString(36)}`
}

const summarizeScanPaths = (scanPath: string | string[]) => {
  const paths = Array.isArray(scanPath) ? scanPath : [scanPath]
  return {
    scanPathCount: paths.length,
    scanPaths: paths.slice(0, 3)
  }
}

const shouldRepairSongTimeBasis = (song: ISongInfo) => {
  const grid = resolveCanonicalSongBeatGridV2(song)
  if (grid.kind !== 'grid') return false
  const currentOffset = Number(song.timeBasisOffsetMs)
  const missingOffset = !Number.isFinite(currentOffset) || currentOffset < 0
  const legacyMp3Zero =
    currentOffset === 0 &&
    song.beatGridAlgorithmVersion === undefined &&
    path.extname(song.filePath).toLowerCase() === '.mp3'
  return missingOffset || legacyMp3Zero
}

export function registerPlaylistHandlers() {
  const repairScannedSongGridTimeBases = async (
    songs: ISongInfo[],
    traceId: string,
    updatePhase: (phase: string, details?: Record<string, unknown>) => void
  ): Promise<{ scanData: ISongInfo[]; diagnostics: TimeBasisRepairDiagnostics }> => {
    const startedAt = Date.now()
    const candidates = songs.filter(shouldRepairSongTimeBasis)
    const candidateSet = new Set(candidates)
    const extensionCounts: Record<string, number> = {}
    let cacheHitCount = 0
    for (const song of candidates) {
      const extension = path.extname(song.filePath).toLowerCase() || '(none)'
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1
      if (hasCachedAudioTimeBasisOffsetMsForFile(song.filePath)) {
        cacheHitCount += 1
      }
    }
    const cacheMissCount = candidates.length - cacheHitCount
    updatePhase('time-basis-plan', {
      trackCount: songs.length,
      candidateCount: candidates.length,
      cacheHitCount,
      cacheMissCount,
      extensionCounts
    })
    log.info('[playlist-scan-diagnostic] time-basis repair planned', {
      traceId,
      trackCount: songs.length,
      candidateCount: candidates.length,
      cacheHitCount,
      cacheMissCount,
      extensionCounts
    })

    let resolveDurationTotalMs = 0
    let resolveDurationMaxMs = 0
    let resolvedNonZeroCount = 0
    let cachePersistenceDurationTotalMs = 0
    let cachePersistenceDurationMaxMs = 0
    let cacheUpsertAttemptedCount = 0
    let cacheUpsertSucceededCount = 0
    let cacheRootMissingCount = 0
    let fileStatMissingCount = 0

    updatePhase('time-basis-task-launch')
    const taskLaunchStartedAt = Date.now()
    const repairTasks = songs.map(async (song) => {
      if (!candidateSet.has(song)) return song

      const resolveStartedAt = Date.now()
      const timeBasisOffsetMs = await resolveAudioTimeBasisOffsetMsForFile(song.filePath)
      const resolveDurationMs = Date.now() - resolveStartedAt
      resolveDurationTotalMs += resolveDurationMs
      resolveDurationMaxMs = Math.max(resolveDurationMaxMs, resolveDurationMs)
      if (timeBasisOffsetMs > 0) resolvedNonZeroCount += 1

      const nextSong = { ...song, timeBasisOffsetMs: Number(timeBasisOffsetMs.toFixed(3)) }
      const persistenceStartedAt = Date.now()
      const listRoot = await findSongListRoot(path.dirname(song.filePath))
      if (!listRoot) cacheRootMissingCount += 1
      const stat = await fs.stat(song.filePath).catch(() => null)
      if (!stat?.isFile()) fileStatMissingCount += 1
      if (listRoot && stat?.isFile()) {
        cacheUpsertAttemptedCount += 1
        const upserted = await LibraryCacheDb.upsertSongCacheEntry(listRoot, song.filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          info: nextSong
        })
        if (upserted) cacheUpsertSucceededCount += 1
      }
      const persistenceDurationMs = Date.now() - persistenceStartedAt
      cachePersistenceDurationTotalMs += persistenceDurationMs
      cachePersistenceDurationMaxMs = Math.max(cachePersistenceDurationMaxMs, persistenceDurationMs)
      return nextSong
    })
    const taskLaunchDurationMs = Date.now() - taskLaunchStartedAt
    updatePhase('time-basis-await', { taskLaunchDurationMs })
    log.info('[playlist-scan-diagnostic] time-basis tasks launched', {
      traceId,
      candidateCount: candidates.length,
      taskLaunchDurationMs
    })

    const scanData = await Promise.all(repairTasks)
    const diagnostics: TimeBasisRepairDiagnostics = {
      candidateCount: candidates.length,
      cacheHitCount,
      cacheMissCount,
      extensionCounts,
      taskLaunchDurationMs,
      totalDurationMs: Date.now() - startedAt,
      resolveDurationTotalMs,
      resolveDurationMaxMs,
      resolvedNonZeroCount,
      cachePersistenceDurationTotalMs,
      cachePersistenceDurationMaxMs,
      cacheUpsertAttemptedCount,
      cacheUpsertSucceededCount,
      cacheRootMissingCount,
      fileStatMissingCount
    }
    log.info('[playlist-scan-diagnostic] time-basis repair completed', {
      traceId,
      ...diagnostics
    })
    return { scanData, diagnostics }
  }

  const runSongListScan = async (
    scanPath: string | string[],
    songListUUID: string,
    diagnosticContext?: PlaylistScanDiagnosticContext
  ) => {
    const traceId = createPlaylistScanTraceId(diagnosticContext?.traceId)
    const source = normalizeDiagnosticText(diagnosticContext?.source, 40) || 'unknown'
    const startedAtMs = Date.now()
    const pathSummary = summarizeScanPaths(scanPath)
    const activity = beginPlaylistScanDiagnostic(traceId, {
      source,
      songListUUID,
      ...pathSummary
    })
    let stage = 'worker-scan'
    log.info('[playlist-scan-diagnostic] main scan started', {
      traceId,
      source,
      songListUUID,
      startedAtMs,
      ...pathSummary
    })

    try {
      const workerStartedAt = Date.now()
      const result = await scanSongListOffMainThread({
        scanPath,
        audioExt: store.settingConfig.audioExt,
        songListUUID,
        databaseDir: store.databaseDir
      })
      const workerDurationMs = Date.now() - workerStartedAt
      activity.update('worker-result-received', {
        trackCount: result.scanData.length,
        workerDurationMs
      })
      log.info('[playlist-scan-diagnostic] worker scan completed', {
        traceId,
        trackCount: result.scanData.length,
        workerDurationMs,
        workerPerf: result.perf
      })

      stage = 'time-basis-repair'
      const repairResult = await repairScannedSongGridTimeBases(
        result.scanData,
        traceId,
        activity.update
      )
      stage = 'post-scan-schedule'
      activity.update('post-scan-schedule')
      void scheduleSongListPostScanTasks(scanPath, repairResult.scanData)

      const responseReadyAtMs = Date.now()
      const mainDurationMs = responseReadyAtMs - startedAtMs
      const scanDiagnostics = {
        traceId,
        source,
        mainStartedAtMs: startedAtMs,
        responseReadyAtMs,
        mainDurationMs,
        workerDurationMs,
        timeBasisRepair: repairResult.diagnostics
      }
      activity.complete({
        trackCount: repairResult.scanData.length,
        mainDurationMs,
        workerDurationMs,
        timeBasisRepairDurationMs: repairResult.diagnostics.totalDurationMs
      })
      log.info('[playlist-scan-diagnostic] main response ready', {
        traceId,
        source,
        trackCount: repairResult.scanData.length,
        responseReadyAtMs,
        mainDurationMs,
        workerDurationMs,
        timeBasisRepairDurationMs: repairResult.diagnostics.totalDurationMs
      })
      return { ...result, scanData: repairResult.scanData, scanDiagnostics }
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      activity.fail({ stage, message })
      log.error('[playlist-scan-diagnostic] main scan failed', {
        traceId,
        source,
        songListUUID,
        stage,
        durationMs: Date.now() - startedAtMs,
        error: message
      })
      throw error
    }
  }

  ipcMain.handle(
    'scanSongList',
    async (
      _e,
      songListPath: string | string[],
      songListUUID: string,
      diagnosticContext?: PlaylistScanDiagnosticContext
    ) => {
      assertLibraryMergeMutationAllowed()
      if (typeof songListPath === 'string') {
        const scanPath = resolveLibraryPath(songListPath).absPath
        return await runSongListScan(scanPath, songListUUID, diagnosticContext)
      } else {
        const scanPaths = songListPath.map((p) => resolveLibraryPath(p).absPath)
        return await runSongListScan(scanPaths, songListUUID, diagnosticContext)
      }
    }
  )

  ipcMain.handle(
    'songList:reorder-track-numbers',
    async (_e, payload: ReorderSongListTrackNumbersPayload) => {
      assertLibraryMergeMutationAllowed()
      const songListPath = String(payload?.songListPath || '').trim()
      const orderedFilePaths = Array.isArray(payload?.orderedFilePaths)
        ? payload.orderedFilePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      if (!songListPath) {
        throw new Error('缺少歌单路径')
      }
      if (orderedFilePaths.length === 0) {
        throw new Error('缺少排序后的曲目列表')
      }
      const absolutePlaylistPath = resolveLibraryPath(songListPath).absPath
      const result = await setSongListTrackNumbersByOrder({
        listRoot: absolutePlaylistPath,
        orderedFilePaths
      })
      if (!result.updated || result.total <= 0) {
        throw new Error('重排序号未写入，目标歌单可能不支持真实序号或没有可写入曲目')
      }
      markGlobalSongSearchDirty('songList:reorder-track-numbers')
      return result
    }
  )

  ipcMain.handle(
    'songList:compact-track-numbers',
    async (_e, payload: CompactSongListTrackNumbersPayload) => {
      assertLibraryMergeMutationAllowed()
      const songListPath = String(payload?.songListPath || '').trim()
      if (songListPath) {
        const absolutePlaylistPath = resolveLibraryPath(songListPath).absPath
        const result = await compactSongListTrackNumbers(absolutePlaylistPath)
        markGlobalSongSearchDirty('songList:compact-track-numbers')
        return {
          ...result,
          roots: 1
        }
      }

      const filePaths = Array.isArray(payload?.filePaths)
        ? payload.filePaths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      const result = await compactSongListTrackNumbersByFilePaths(filePaths)
      if (result.roots > 0) {
        markGlobalSongSearchDirty('songList:compact-track-numbers')
      }
      return result
    }
  )

  ipcMain.handle(
    'audio:convert:collect-files',
    async (_e, payload: AudioConvertCollectFilesPayload) => {
      assertLibraryMergeMutationAllowed()
      const requests = Array.isArray(payload?.songLists) ? payload.songLists : []
      const progressId =
        typeof payload?.progressId === 'string' && payload.progressId.trim()
          ? payload.progressId.trim()
          : `audio_convert_collect_${Date.now()}`
      const titleKey =
        typeof payload?.titleKey === 'string' && payload.titleKey.trim()
          ? payload.titleKey.trim()
          : 'convert.scanningSourceFiles'
      const total = requests.length

      if (total <= 0) {
        return { files: [] as string[] }
      }

      mainWindow.instance?.webContents.send('progressSet', {
        id: progressId,
        titleKey,
        now: 0,
        total,
        isInitial: true,
        noProgress: true
      })

      const files: string[] = []
      for (let index = 0; index < requests.length; index++) {
        const request = requests[index]
        try {
          const rawSongListPath = request?.songListPath
          const songListUUID = String(request?.songListUUID || '')
          const hasValidPath =
            (typeof rawSongListPath === 'string' && rawSongListPath.trim().length > 0) ||
            (Array.isArray(rawSongListPath) &&
              rawSongListPath.some((item) => String(item || '').trim()))
          if (!hasValidPath) {
            continue
          }
          const scanPath = Array.isArray(rawSongListPath)
            ? rawSongListPath.map((item) => resolveLibraryPath(item).absPath)
            : resolveLibraryPath(String(rawSongListPath || '')).absPath
          const result = await runSongListScan(scanPath, songListUUID)
          const songFiles = Array.isArray(result?.scanData)
            ? result.scanData.map((item) => item.filePath).filter((item): item is string => !!item)
            : []
          files.push(...songFiles)
        } catch (error) {
          log.error('audio:convert:collect-files scan failed', error)
        } finally {
          mainWindow.instance?.webContents.send('progressSet', {
            id: progressId,
            titleKey,
            now: index + 1,
            total,
            isInitial: true,
            noProgress: true
          })
        }
      }

      return { files: Array.from(new Set(files)) }
    }
  )

  ipcMain.handle('externalPlaylist:scan', async (_e, rawPaths: string[]) => {
    assertLibraryMergeMutationAllowed()
    try {
      const arr = Array.isArray(rawPaths) ? rawPaths : []
      const normalized = Array.from(
        new Set(
          arr
            .map((p) => (typeof p === 'string' ? p.trim() : ''))
            .filter((p) => p.length > 0)
            .map((p) => path.resolve(p))
        )
      )
      const filtered = normalized.filter((p) => isSupportedAudioPath(p))
      if (!filtered.length) {
        return { scanData: [], songListUUID: EXTERNAL_PLAYLIST_UUID }
      }
      const result = await runSongListScan(filtered, EXTERNAL_PLAYLIST_UUID)
      try {
        await prepareExternalPlaybackPlaylistAnalysis({
          tracks: Array.isArray(result?.scanData) ? result.scanData : []
        })
      } catch (prepareError) {
        log.error('externalPlaylist:prepare-analysis failed', prepareError)
      }
      return result
    } catch (error) {
      log.error('externalPlaylist:scan failed', error)
      return { scanData: [], songListUUID: EXTERNAL_PLAYLIST_UUID }
    }
  })

  ipcMain.handle('getSongListTrackCount', async (_e, songListPath: string) => {
    try {
      const scanPath = resolveLibraryPath(songListPath).absPath
      return await countSongListTracksOffMainThread({
        scanPath,
        audioExt: store.settingConfig.audioExt
      })
    } catch {
      return 0
    }
  })

  // 库树按曲目数排序时需要一次拿到整棵树的数量，逐歌单往返会导致列表反复重排
  ipcMain.handle(
    'playlist:batchTrackCount',
    async (_e, payload?: { songLists?: Array<{ uuid?: string; songListPath?: string }> }) => {
      const result: Record<string, number> = {}
      try {
        const requests = Array.isArray(payload?.songLists) ? payload.songLists : []
        const resolved: Array<{ uuid: string; scanPath: string }> = []
        for (const item of requests) {
          const uuid = String(item?.uuid || '').trim()
          const songListPath = String(item?.songListPath || '').trim()
          if (!uuid || !songListPath) continue
          if (result[uuid] !== undefined) continue
          result[uuid] = 0
          try {
            resolved.push({ uuid, scanPath: resolveLibraryPath(songListPath).absPath })
          } catch {
            // 路径已失效的节点保持 0，不影响其余歌单
          }
        }
        if (!resolved.length) return result
        const counts = await countSongListTracksBatchOffMainThread({
          scanPaths: resolved.map((item) => item.scanPath),
          audioExt: store.settingConfig.audioExt
        })
        resolved.forEach((item, index) => {
          result[item.uuid] = counts[index] ?? 0
        })
        return result
      } catch (error) {
        log.error('playlist:batchTrackCount failed', error)
        return result
      }
    }
  )

  ipcMain.handle('songList:resolve-by-file-path', async (_e, rawFilePath?: string) => {
    try {
      const filePath = String(rawFilePath || '').trim()
      if (!filePath) {
        return { songListUuid: '', songListPath: '' }
      }
      const songListRoot = await findSongListRootByPath(path.dirname(filePath))
      if (!songListRoot) {
        return { songListUuid: '', songListPath: '' }
      }
      const relativeSongListPath = path.relative(store.databaseDir, songListRoot)
      const node = findLibraryNodeByPath(relativeSongListPath)
      return {
        songListUuid: String(node?.uuid || ''),
        songListPath: relativeSongListPath
      }
    } catch (error) {
      log.error('songList:resolve-by-file-path failed', error)
      return { songListUuid: '', songListPath: '' }
    }
  })

  ipcMain.handle(
    'playlist:batchRename:preview',
    async (
      _e,
      payload: {
        tracks?: IBatchRenameTrackInput[]
        templateSegments?: IBatchRenameTemplateSegment[]
      }
    ) => {
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : []
      const templateSegments = Array.isArray(payload?.templateSegments)
        ? payload.templateSegments
        : []
      return await previewPlaylistBatchRename(tracks, templateSegments)
    }
  )

  ipcMain.handle(
    'playlist:batchRename:execute',
    async (
      _e,
      payload: {
        taskId?: string
        items?: IBatchRenameExecutionRequestItem[]
      }
    ) => {
      assertLibraryMergeMutationAllowed()
      return await executePlaylistBatchRename({
        taskId: String(payload?.taskId || ''),
        items: Array.isArray(payload?.items) ? payload.items : []
      })
    }
  )

  ipcMain.handle(
    'playlist:batchRename:cancel',
    async (_e, payload: { taskId?: string } | string) => {
      const taskId =
        typeof payload === 'string'
          ? payload
          : payload && typeof payload === 'object'
            ? String(payload.taskId || '')
            : ''
      return cancelPlaylistBatchRename(taskId)
    }
  )

  ipcMain.handle(
    'deduplicateSongListByFingerprint',
    async (_e, payload: DeduplicateSongListPayload) => {
      assertLibraryMergeMutationAllowed()
      let rendererPath = ''
      let incomingProgressId = ''
      if (typeof payload === 'string') {
        rendererPath = payload
      } else if (payload && typeof payload === 'object') {
        rendererPath = String(payload.songListPath || '')
        incomingProgressId = payload.progressId ? String(payload.progressId) : ''
      }
      if (!rendererPath) {
        throw new Error('缺少有效的歌单路径')
      }

      const progressId = incomingProgressId || `playlist_dedup_${Date.now()}`
      const pushProgress = (
        titleKey: string,
        now: number,
        total: number,
        options?: { isInitial?: boolean }
      ) => {
        if (!mainWindow.instance) return
        mainWindow.instance.webContents.send('progressSet', {
          id: progressId,
          titleKey,
          now,
          total,
          isInitial: !!options?.isInitial
        })
      }

      try {
        const startedAt = Date.now()
        const mode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
        const scanPath = resolveLibraryPath(rendererPath).absPath

        const summaryBase = {
          scannedCount: 0,
          analyzeFailedCount: 0,
          duplicatesRemovedCount: 0,
          removedFilePaths: [] as string[],
          fingerprintMode: mode,
          durationMs: 0,
          recycleBinInfo: null as null | {
            dirName: string
            uuid: string
            type: string
            order: number
          },
          progressId
        }

        pushProgress('playlist.deduplicateProgressScanning', 0, 1, { isInitial: true })

        const songFileUrlsRaw = await collectFilesWithExtensions(
          scanPath,
          store.settingConfig.audioExt
        )
        const songFileUrls = Array.isArray(songFileUrlsRaw)
          ? Array.from(
              new Set(
                songFileUrlsRaw.filter(
                  (item): item is string => typeof item === 'string' && item.trim().length > 0
                )
              )
            )
          : []

        pushProgress('playlist.deduplicateProgressScanning', 1, 1)

        if (songFileUrls.length === 0) {
          pushProgress('playlist.deduplicateProgressFinished', 1, 1)
          return { ...summaryBase, durationMs: Date.now() - startedAt }
        }

        const analysisTotal = songFileUrls.length
        pushProgress('playlist.deduplicateProgressAnalyzing', 0, analysisTotal)

        const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
          songFileUrls,
          (processed: number) => {
            const current = Math.min(processed, analysisTotal)
            pushProgress('playlist.deduplicateProgressAnalyzing', current, analysisTotal)
          }
        )

        pushProgress('playlist.deduplicateProgressAnalyzing', analysisTotal, analysisTotal)

        const groups = new Map<string, string[]>()
        for (const item of songsAnalyseResult) {
          const hash = item?.sha256_Hash
          const filePath = item?.file_path
          if (!hash || hash === 'error' || !filePath) continue
          const list = groups.get(hash) || []
          list.push(filePath)
          groups.set(hash, list)
        }

        const duplicates: string[] = []
        groups.forEach((paths) => {
          if (paths.length <= 1) return
          paths.sort((a: string, b: string) =>
            a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
          )
          duplicates.push(...paths.slice(1))
        })

        const existingToRemove: string[] = []
        for (const filePath of duplicates) {
          try {
            if (await fs.pathExists(filePath)) {
              existingToRemove.push(filePath)
            }
          } catch (err) {
            log.error('检查重复文件是否存在失败', { filePath, err })
          }
        }

        if (existingToRemove.length === 0) {
          pushProgress('playlist.deduplicateProgressFinished', 1, 1)
          return {
            scannedCount: songFileUrls.length,
            analyzeFailedCount: errorSongsAnalyseResult.length,
            duplicatesRemovedCount: 0,
            removedFilePaths: [],
            fingerprintMode: mode,
            durationMs: Date.now() - startedAt,
            recycleBinInfo: null,
            progressId
          }
        }

        pushProgress('playlist.deduplicateProgressRemoving', 0, existingToRemove.length)

        const originalPlaylistPath = normalizeRendererPlaylistPath(rendererPath)
        const setProtection = await protectSetReferencedFilesForDeletion(existingToRemove)
        const protectedMovedPaths = setProtection.protectedFiles
          .filter((protectedFile) => protectedFile.success)
          .map((protectedFile) => protectedFile.filePath)
        const protectedFailed = setProtection.protectedFiles.filter(
          (protectedFile) => !protectedFile.success
        )
        const protectedHandledCount = setProtection.protectedFiles.length
        const moveTasks = setProtection.unprotectedFiles.map((srcPath) => async () => {
          const result = await moveFileToRecycleBin(srcPath, { originalPlaylistPath })
          if (result.status === 'failed') {
            throw new Error(result.error || 'move to recycle bin failed')
          }
          return srcPath
        })

        const { results: moveResults } = await runWithConcurrency(moveTasks, {
          concurrency: 16,
          onProgress: (done: number, total: number) => {
            pushProgress(
              'playlist.deduplicateProgressRemoving',
              protectedHandledCount + done,
              protectedHandledCount + total
            )
          }
        })
        const movedPaths = moveResults
          .filter((item): item is string => typeof item === 'string')
          .concat(protectedMovedPaths)
        const failedMoves = moveResults.filter((item) => item instanceof Error) as Error[]

        if (failedMoves.length > 0) {
          failedMoves.forEach((err, index) => {
            log.error('指纹去重移动重复文件失败', { error: err?.message, index })
          })
        }
        if (protectedFailed.length > 0) {
          protectedFailed.forEach((item) => {
            log.error('指纹去重保护 SET 引用文件失败', {
              filePath: item.filePath,
              error: item.error
            })
          })
        }
        if (movedPaths.length > 0) {
          await compactSongListTrackNumbers(scanPath)
          markGlobalSongSearchDirty('deduplicateSongListByFingerprint')
        }

        const recycleBinInfo = null

        pushProgress('playlist.deduplicateProgressFinished', 1, 1)

        return {
          scannedCount: songFileUrls.length,
          analyzeFailedCount: errorSongsAnalyseResult.length,
          duplicatesRemovedCount: movedPaths.length,
          removedFilePaths: movedPaths,
          fingerprintMode: mode,
          durationMs: Date.now() - startedAt,
          recycleBinInfo,
          progressId
        }
      } catch (error) {
        pushProgress('playlist.deduplicateProgressFailed', 1, 1)
        throw error
      }
    }
  )
}
