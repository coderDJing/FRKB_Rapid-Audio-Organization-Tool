import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import {
  getCoreFsDirName,
  mapRendererPathToFsPath,
  operateHiddenFile,
  runWithConcurrency,
  waitForUserDecision
} from '../utils'

export function registerLibraryMaintenanceHandlers() {
  ipcMain.on('delSongs', async (_e, songFilePaths: string[], dirName: string) => {
    const recycleBinTargetDir = path.join(
      store.databaseDir,
      'library',
      getCoreFsDirName('RecycleBin'),
      dirName
    )
    fs.ensureDirSync(recycleBinTargetDir)
    const tasks: Array<() => Promise<any>> = []
    for (const item of songFilePaths) {
      const dest = path.join(recycleBinTargetDir, path.basename(item))
      tasks.push(() => fs.move(item, dest))
    }
    const batchId = `delSongs_${Date.now()}`
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(mainWindow.instance ?? null, batchId, 'delSongs', payload)
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'delSongs',
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
    if (failed > 0) {
      throw new Error('delSongs failed')
    }
    let descriptionJson = {
      uuid: uuidV4(),
      type: 'songList',
      order: Date.now()
    }
    const descPath = path.join(recycleBinTargetDir, '.description.json')
    await operateHiddenFile(descPath, async () => {
      if (!(await fs.pathExists(descPath))) {
        await fs.outputJSON(descPath, descriptionJson)
      }
    })
    try {
      const existing = await fs.readJSON(descPath)
      descriptionJson = { ...descriptionJson, ...existing }
    } catch {}
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('delSongsSuccess', {
        dirName,
        ...descriptionJson
      })
    }
  })

  ipcMain.handle('permanentlyDelSongs', async (_e, songFilePaths: string[]) => {
    const promises = songFilePaths.map((item) => fs.remove(item))
    await Promise.all(promises)
  })

  ipcMain.handle('dirPathExists', async (_e, targetPath: string) => {
    try {
      const filePath = path.join(
        store.databaseDir,
        mapRendererPathToFsPath(targetPath),
        '.description.json'
      )
      const descriptionJson = await fs.readJSON(filePath)
      const validTypes = ['root', 'library', 'dir', 'songList']
      return !!(
        descriptionJson.uuid &&
        descriptionJson.type &&
        validTypes.includes(descriptionJson.type)
      )
    } catch {
      return false
    }
  })
}
