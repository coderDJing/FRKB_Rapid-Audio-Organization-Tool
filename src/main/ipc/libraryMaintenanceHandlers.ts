import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import store from '../store'
import mainWindow from '../window/mainWindow'
import {
  getCoreFsDirName,
  mapRendererPathToFsPath,
  runWithConcurrency,
  waitForUserDecision
} from '../utils'
import { findLibraryNodeByPath, insertLibraryNode } from '../libraryTreeDb'

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
    const recycleNodePath = path.join('library', getCoreFsDirName('RecycleBin'), dirName)
    const existingNode = findLibraryNodeByPath(recycleNodePath)
    let descriptionJson = {
      uuid: existingNode?.uuid || uuidV4(),
      type: 'songList',
      order: existingNode?.order ?? Date.now()
    }
    if (!existingNode) {
      const parentNode = findLibraryNodeByPath(path.join('library', getCoreFsDirName('RecycleBin')))
      if (parentNode) {
        insertLibraryNode({
          uuid: descriptionJson.uuid,
          parentUuid: parentNode.uuid,
          dirName,
          nodeType: 'songList',
          order: descriptionJson.order
        })
      }
    }
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
      const mapped = mapRendererPathToFsPath(targetPath)
      const absPath = path.join(store.databaseDir, mapped)
      if (!(await fs.pathExists(absPath))) return false
      const node = findLibraryNodeByPath(mapped)
      const validTypes = ['root', 'library', 'dir', 'songList']
      return !!(node && validTypes.includes(node.nodeType))
    } catch {
      return false
    }
  })
}
