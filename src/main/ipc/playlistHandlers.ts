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
  collectFilesWithExtensions,
  getSongsAnalyseResult,
  mapRendererPathToFsPath,
  runWithConcurrency
} from '../utils'
import { isSupportedAudioPath } from '../services/externalOpenQueue'
import { moveFileToRecycleBin, normalizeRendererPlaylistPath } from '../recycleBinService'
import { findLibraryNodeByPath, findSongListRootByPath } from '../libraryTreeDb'
import {
  cancelPlaylistBatchRename,
  executePlaylistBatchRename,
  previewPlaylistBatchRename
} from '../services/playlistBatchRename'
import type {
  IBatchRenameExecutionRequestItem,
  IBatchRenameTemplateSegment,
  IBatchRenameTrackInput
} from '../../types/globals'

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

export function registerPlaylistHandlers() {
  const runSongListScan = async (scanPath: string | string[], songListUUID: string) => {
    const result = await scanSongListOffMainThread({
      scanPath,
      audioExt: store.settingConfig.audioExt,
      songListUUID,
      databaseDir: store.databaseDir
    })
    void scheduleSongListPostScanTasks(scanPath, result.scanData)
    return result
  }

  ipcMain.handle(
    'scanSongList',
    async (_e, songListPath: string | string[], songListUUID: string) => {
      if (typeof songListPath === 'string') {
        const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
        return await runSongListScan(scanPath, songListUUID)
      } else {
        const scanPaths = songListPath.map((p) =>
          path.join(store.databaseDir, mapRendererPathToFsPath(p))
        )
        return await runSongListScan(scanPaths, songListUUID)
      }
    }
  )

  ipcMain.handle(
    'audio:convert:collect-files',
    async (_e, payload: AudioConvertCollectFilesPayload) => {
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
            ? rawSongListPath.map((item) =>
                path.join(store.databaseDir, mapRendererPathToFsPath(item))
              )
            : path.join(store.databaseDir, mapRendererPathToFsPath(String(rawSongListPath || '')))
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
      return await runSongListScan(filtered, EXTERNAL_PLAYLIST_UUID)
    } catch (error) {
      log.error('externalPlaylist:scan failed', error)
      return { scanData: [], songListUUID: EXTERNAL_PLAYLIST_UUID }
    }
  })

  ipcMain.handle('getSongListTrackCount', async (_e, songListPath: string) => {
    try {
      const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
      const files = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
      return Array.isArray(files) ? files.length : 0
    } catch {
      return 0
    }
  })

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
      log.warn('songList:resolve-by-file-path failed', error)
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
        const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(rendererPath))

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
            log.warn('检查重复文件是否存在失败', { filePath, err })
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
        const moveTasks = existingToRemove.map((srcPath) => async () => {
          const result = await moveFileToRecycleBin(srcPath, { originalPlaylistPath })
          if (result.status === 'failed') {
            throw new Error(result.error || 'move to recycle bin failed')
          }
          return srcPath
        })

        const { results: moveResults } = await runWithConcurrency(moveTasks, {
          concurrency: 16,
          onProgress: (done: number, total: number) => {
            pushProgress('playlist.deduplicateProgressRemoving', done, total)
          }
        })
        const movedPaths = moveResults.filter((item): item is string => typeof item === 'string')
        const failedMoves = moveResults.filter((item) => item instanceof Error) as Error[]

        if (failedMoves.length > 0) {
          failedMoves.forEach((err, index) => {
            log.error('指纹去重移动重复文件失败', { error: err?.message, index })
          })
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
