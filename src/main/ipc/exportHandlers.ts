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
    const tasks: Array<() => Promise<any>> = []
    for (const src of srcs) {
      const matches = src.match(/[^\\]+$/)
      if (Array.isArray(matches) && matches.length > 0) {
        const targetPath = path.join(store.databaseDir, mapRendererPathToFsPath(dest), matches[0])
        tasks.push(() => moveOrCopyItemWithCheckIsExist(src, targetPath, true))
      }
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
  })
}
