import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { EXTERNAL_PLAYLIST_UUID } from '../../shared/externalPlayback'
import { scanSongList as svcScanSongList } from '../services/scanSongs'
import {
  collectFilesWithExtensions,
  getSongsAnalyseResult,
  mapRendererPathToFsPath,
  runWithConcurrency
} from '../utils'
import { isSupportedAudioPath } from '../services/externalOpenQueue'
import { moveFileToRecycleBin, normalizeRendererPlaylistPath } from '../recycleBinService'

export function registerPlaylistHandlers() {
  ipcMain.handle(
    'scanSongList',
    async (_e, songListPath: string | string[], songListUUID: string) => {
      if (typeof songListPath === 'string') {
        const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
        return await svcScanSongList(scanPath, store.settingConfig.audioExt, songListUUID)
      } else {
        const scanPaths = songListPath.map((p) =>
          path.join(store.databaseDir, mapRendererPathToFsPath(p))
        )
        return await svcScanSongList(scanPaths, store.settingConfig.audioExt, songListUUID)
      }
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
      return await svcScanSongList(filtered, store.settingConfig.audioExt, EXTERNAL_PLAYLIST_UUID)
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

  ipcMain.handle('deduplicateSongListByFingerprint', async (_e, payload: any) => {
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
      const mode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
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
  })
}
