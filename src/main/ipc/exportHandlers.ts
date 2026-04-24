import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import {
  collectFilesWithExtensions,
  getCoreFsDirName,
  mapRendererPathToFsPath,
  moveOrCopyItemWithCheckIsExist,
  runWithConcurrency,
  waitForUserDecision,
  getCurrentTimeYYYYMMDDHHMMSSSSS
} from '../utils'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import { exportSnapshot, importFromJsonFile } from '../fingerprintStore'
import { deleteRecycleBinRecord } from '../recycleBinDb'
import { isInRecycleBinAbsPath, toLibraryRelativePath } from '../recycleBinService'
import { findSongListRoot, transferTrackCaches } from '../services/cacheMaintenance'
import { replaceMixtapeFilePath } from '../mixtapeDb'
import { rememberCuratedArtistsForAddedTracks } from '../curatedArtistLibrary'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import { remapKeyAnalysisTrackedPath } from '../services/keyAnalysisQueue'
import {
  appendSongListTrackNumbers,
  compactSongListTrackNumbers,
  isSupportedPlaylistTrackNumberListRoot
} from '../services/playlistTrackNumbers'

type MoveSongsToDirOptions = {
  mode?: 'copy' | 'move'
  curatedArtistNames?: Array<string | null | undefined>
}

type ErrorSample = {
  code?: unknown
  message: string
  index: number
}

const toErrorSample = (result: unknown, index: number): ErrorSample | null => {
  if (!(result instanceof Error)) return null
  const error = result as Error & { code?: unknown }
  return { code: error.code, message: error.message, index }
}

async function findUniqueFolder(inputFolderPath: string) {
  const parts = path.parse(inputFolderPath)
  const dirPath = parts.dir
  const folderName = parts.name
  const baseCheckPath = path.join(dirPath, folderName)
  if (await fs.pathExists(baseCheckPath)) {
    let count = 1
    let newFolderPath
    do {
      newFolderPath = path.join(dirPath, `${folderName}(${count})`)
      count++
    } while (await fs.pathExists(newFolderPath))
    return newFolderPath
  }
  return inputFolderPath
}

export function registerExportHandlers() {
  ipcMain.handle('exportSongFingerprint', async (_e, folderPath) => {
    const toPath = path.join(
      folderPath,
      'songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
    )
    await exportSnapshot(toPath, store.songFingerprintList || [])
  })

  ipcMain.handle('importSongFingerprint', async (_e, filePath: string) => {
    const merged = await importFromJsonFile(filePath)
    store.songFingerprintList = merged
  })

  ipcMain.handle(
    'exportSongListToDir',
    async (_e, folderPathVal, deleteSongsAfterExport, dirPath) => {
      const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(dirPath))
      const songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
      const folderName = dirPath.split('/')[dirPath.split('/').length - 1]
      const targetPath = await findUniqueFolder(path.join(folderPathVal, folderName))
      await fs.ensureDir(targetPath)
      const tasks: Array<() => Promise<string>> = []
      for (const item of songFileUrls) {
        const matches = item.match(/[^\\]+$/)
        if (Array.isArray(matches) && matches.length > 0) {
          const dest = path.join(targetPath, matches[0])
          tasks.push(() => moveOrCopyItemWithCheckIsExist(item, dest, deleteSongsAfterExport))
        }
      }
      const batchId = `exportSongList_${Date.now()}`
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: 0,
          total: tasks.length,
          isInitial: true
        })
      }
      const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
        concurrency: 16,
        onProgress: (done, total) => {
          if (mainWindow.instance) {
            mainWindow.instance.webContents.send('progressSet', {
              id: batchId,
              titleKey: 'tracks.copyingTracks',
              now: done,
              total
            })
          }
        },
        stopOnENOSPC: true,
        onInterrupted: async (payload) =>
          waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongList', payload)
      })
      if (hasENOSPC && mainWindow.instance) {
        mainWindow.instance.webContents.send('file-batch-summary', {
          context: 'exportSongList',
          total: tasks.length,
          success,
          failed,
          hasENOSPC,
          skipped,
          errorSamples: results
            .map((r, i) => toErrorSample(r, i))
            .filter(Boolean)
            .slice(0, 3)
        })
      }
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: tasks.length,
          total: tasks.length
        })
      }
      if (failed > 0) {
        throw new Error('exportSongListToDir failed')
      }
    }
  )

  ipcMain.handle('exportSongsToDir', async (_e, folderPathVal, deleteSongsAfterExport, songs) => {
    const tasks: Array<() => Promise<string>> = []
    for (const item of songs) {
      const matches = item.filePath.match(/[^\\]+$/)
      if (Array.isArray(matches) && matches.length > 0) {
        const targetPath = path.join(folderPathVal, matches[0])
        tasks.push(() =>
          moveOrCopyItemWithCheckIsExist(item.filePath, targetPath, deleteSongsAfterExport)
        )
      }
    }
    const batchId = `exportSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: 'tracks.copyingTracks',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongs', payload)
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'exportSongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) => toErrorSample(r, i))
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.copyingTracks',
        now: tasks.length,
        total: tasks.length
      })
    }
    if (failed > 0) {
      throw new Error('exportSongsToDir failed')
    }
  })

  ipcMain.handle('moveSongsToDir', async (_e, srcs, dest, options: MoveSongsToDirOptions = {}) => {
    const isMove = options?.mode !== 'copy'
    const normalizeRelativePath = (value: string) => value.replace(/\\/g, '/')
    const targetDir = normalizeRelativePath(mapRendererPathToFsPath(dest))
    const curatedRoot = normalizeRelativePath(
      path.join('library', getCoreFsDirName('CuratedLibrary'))
    )
    const isCuratedTarget = targetDir === curatedRoot || targetDir.startsWith(`${curatedRoot}/`)
    const targetListRoot = path.join(store.databaseDir, mapRendererPathToFsPath(dest))
    const tasks: Array<() => Promise<string>> = []
    for (const src of srcs) {
      const matches = src.match(/[^\\]+$/)
      if (Array.isArray(matches) && matches.length > 0) {
        const targetPath = path.join(store.databaseDir, mapRendererPathToFsPath(dest), matches[0])
        tasks.push(async () => {
          const movedPath = await moveOrCopyItemWithCheckIsExist(src, targetPath, isMove)
          if (isMove) {
            remapKeyAnalysisTrackedPath(src, movedPath)
            replaceMixtapeFilePath(src, movedPath)
            try {
              const fromRoot = await findSongListRoot(path.dirname(src))
              const toRoot = await findSongListRoot(path.dirname(movedPath))
              await transferTrackCaches({
                fromRoot,
                toRoot,
                fromPath: src,
                toPath: movedPath
              })
            } catch {}
            if (isInRecycleBinAbsPath(src)) {
              const rel = toLibraryRelativePath(src)
              if (rel) deleteRecycleBinRecord(rel)
            }
          }
          return movedPath
        })
      }
    }
    const batchId = `${isMove ? 'moveSongs' : 'copySongs'}_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(
          mainWindow.instance ?? null,
          batchId,
          isMove ? 'moveSongs' : 'copySongs',
          payload
        )
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: isMove ? 'moveSongs' : 'copySongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) => toErrorSample(r, i))
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: isMove ? 'tracks.movingTracks' : 'tracks.copyingTracks',
        now: tasks.length,
        total: tasks.length
      })
    }
    if (failed > 0) {
      throw new Error(isMove ? 'moveSongsToDir failed' : 'copySongsToDir failed')
    }
    const movedPaths = results.filter((item): item is string => typeof item === 'string')
    if (movedPaths.length > 0 && isSupportedPlaylistTrackNumberListRoot(targetListRoot)) {
      await appendSongListTrackNumbers({
        listRoot: targetListRoot,
        appendedFilePaths: movedPaths
      })
    }
    if (isMove) {
      const sourceRoots = new Set<string>()
      for (const src of srcs) {
        const sourceRoot = await findSongListRoot(path.dirname(String(src || '').trim()))
        if (!sourceRoot || !isSupportedPlaylistTrackNumberListRoot(sourceRoot)) continue
        if (path.resolve(sourceRoot) === path.resolve(targetListRoot)) continue
        sourceRoots.add(sourceRoot)
      }
      for (const sourceRoot of sourceRoots) {
        await compactSongListTrackNumbers(sourceRoot)
      }
    }
    markGlobalSongSearchDirty(isMove ? 'moveSongsToDir' : 'copySongsToDir')
    if (isCuratedTarget) {
      const curatedArtistTracks: Array<{
        artistName?: string
        targetPath?: string
      }> = []
      for (let index = 0; index < movedPaths.length; index += 1) {
        const result = movedPaths[index]
        const movedPath = String(result || '').trim()
        if (!movedPath) continue
        const artistHint = String(options?.curatedArtistNames?.[index] || '').trim()
        curatedArtistTracks.push({
          artistName: artistHint || undefined,
          targetPath: movedPath
        })
      }
      // 记录精选表演者是附加能力，不能卡住主移动流程和前端列表刷新。
      // 这里同时带上目标路径，后续会尝试补算原始指纹；若补算失败，再退回 UI 传来的 artist hint。
      void rememberCuratedArtistsForAddedTracks({
        tracks: curatedArtistTracks
      }).catch((error) => {
        log.error('[curatedArtists] remember after move failed', error)
      })
    }
    return movedPaths
  })
}
