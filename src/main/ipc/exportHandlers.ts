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
import { saveList, exportSnapshot, importFromJsonFile } from '../fingerprintStore'
import { migrateSelectionSongIdCacheByMoves } from '../services/selectionSongIdResolver'

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
      const tasks: Array<() => Promise<any>> = []
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
            .map((r, i) =>
              r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
            )
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
    const tasks: Array<() => Promise<any>> = []
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
          .map((r, i) =>
            r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
          )
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

  ipcMain.handle('moveSongsToDir', async (_e, srcs, dest) => {
    const dbDir = store.databaseDir
    if (!dbDir) throw new Error('NO_DB')
    const tasks: Array<() => Promise<any>> = []
    for (const src of srcs) {
      const fileName = path.basename(src || '')
      if (!fileName) continue
      const targetPath = path.join(dbDir, mapRendererPathToFsPath(dest), fileName)
      tasks.push(async () => {
        const actual = await moveOrCopyItemWithCheckIsExist(src, targetPath, true)
        return { fromPath: src, toPath: actual }
      })
    }
    const batchId = `moveSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.movingTracks',
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
            titleKey: 'tracks.movingTracks',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(mainWindow.instance ?? null, batchId, 'moveSongs', payload)
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'moveSongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) =>
            r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
          )
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'tracks.movingTracks',
        now: tasks.length,
        total: tasks.length
      })
    }
    if (failed > 0) {
      throw new Error('moveSongsToDir failed')
    }

    // 迁移本地精选：filePath -> songId 的持久化索引，避免移动后再次解码算 PCM SHA256
    try {
      const moves = results
        .filter((r) => !(r instanceof Error))
        .map((r) => r as any)
        .filter((r) => typeof r?.fromPath === 'string' && typeof r?.toPath === 'string')
        .map((r) => ({ fromPath: r.fromPath, toPath: r.toPath }))
      if (moves.length > 0) {
        const migrated = await migrateSelectionSongIdCacheByMoves(moves, { dbDir })
        log.debug(
          `[selection] 路径索引迁移完成：移动=${moves.length} 写入=${migrated.migrated} 删除旧=${migrated.deletedOld}`
        )
      }
    } catch (e) {
      log.warn('[selection] 路径索引迁移失败', e)
    }
  })
}
