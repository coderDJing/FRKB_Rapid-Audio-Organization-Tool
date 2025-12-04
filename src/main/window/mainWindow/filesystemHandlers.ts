import { ipcMain, shell, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import store from '../../store'
import {
  collectFilesWithExtensions,
  mapRendererPathToFsPath,
  getCoreFsDirName,
  runWithConcurrency,
  waitForUserDecision,
  operateHiddenFile
} from '../../utils'
import { FileSystemOperation } from '@renderer/utils/diffLibraryTree'

export function registerFilesystemHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.on('openFileExplorer', (_e, targetPath) => {
    shell.openPath(path.join(store.databaseDir, targetPath))
  })

  ipcMain.on('show-item-in-folder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('emptyDir', async (_e, targetPath: string, dirName: string) => {
    const recycleBinTargetDir = path.join(
      store.databaseDir,
      'library',
      getCoreFsDirName('RecycleBin'),
      dirName
    )
    const songFileUrls = await collectFilesWithExtensions(
      path.join(store.databaseDir, mapRendererPathToFsPath(targetPath)),
      store.settingConfig.audioExt
    )
    if (songFileUrls.length === 0) return
    const tasks: Array<() => Promise<any>> = songFileUrls.map((srcPath) => {
      const destPath = path.join(recycleBinTargetDir, path.basename(srcPath))
      return () => fs.move(srcPath, destPath)
    })
    const batchId = `emptyDir_${Date.now()}`
    const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
      concurrency: 16,
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(getWindow(), batchId, 'emptyDir', payload)
    })
    const descriptionJson = {
      uuid: uuidV4(),
      type: 'songList',
      order: Date.now()
    }
    await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
      fs.outputJSON(path.join(recycleBinTargetDir, '.description.json'), descriptionJson)
    })
    const targetWindow = getWindow()
    if (targetWindow) {
      targetWindow.webContents.send('delSongsSuccess', {
        dirName,
        ...descriptionJson
      })
      if (hasENOSPC) {
        targetWindow.webContents.send('file-batch-summary', {
          context: 'emptyDir',
          total: tasks.length,
          success,
          failed,
          hasENOSPC,
          skipped,
          errorSamples: []
        })
      }
    }
  })

  ipcMain.handle('emptyRecycleBin', async () => {
    const recycleBinPath = path.join(store.databaseDir, 'library', getCoreFsDirName('RecycleBin'))
    try {
      const recycleBinDirs = await fs.readdir(recycleBinPath)
      const deletePromises = recycleBinDirs.map(async (dir) => {
        const dirPath = path.join(recycleBinPath, dir)
        const stat = await fs.stat(dirPath)
        if (stat.isDirectory()) {
          return fs.remove(dirPath)
        }
      })
      await Promise.all(deletePromises)
    } catch (error) {
      console.error('清空回收站失败:', error)
    }
  })

  ipcMain.handle('operateFileSystemChange', async (_e, operateArray: FileSystemOperation[]) => {
    const results: Array<{ uuid: string; status: string; recycleBinDir?: any }> = []
    try {
      for (const item of operateArray) {
        let operationStatus = 'processed'
        let recycleBinInfo: any = null
        if (item.type === 'create') {
          const createPath = path.join(store.databaseDir, item.path)
          await operateHiddenFile(path.join(createPath, '.description.json'), async () => {
            await fs.ensureDir(path.dirname(createPath))
            await fs.ensureDir(createPath)
            await fs.outputJSON(path.join(createPath, '.description.json'), {
              uuid: item.uuid,
              type: item.nodeType,
              order: item.order
            })
          })
          operationStatus = 'created'
        } else if (item.type === 'reorder') {
          await operateHiddenFile(
            path.join(store.databaseDir, item.path, '.description.json'),
            async () => {
              let existingData = {}
              try {
                existingData = await fs.readJson(
                  path.join(store.databaseDir, item.path, '.description.json')
                )
              } catch {}
              await fs.outputJSON(path.join(store.databaseDir, item.path, '.description.json'), {
                ...existingData,
                uuid: item.uuid,
                type: item.nodeType,
                order: item.order
              })
            }
          )
          operationStatus = 'reordered'
        } else if (item.type === 'rename') {
          const oldFullPath = path.join(store.databaseDir, item.path)
          const newFullPath = path.join(
            store.databaseDir,
            item.path.slice(0, item.path.lastIndexOf('/') + 1) + item.newName
          )
          if (await fs.pathExists(oldFullPath)) {
            await fs.rename(oldFullPath, newFullPath)
            operationStatus = 'renamed'
          } else {
            console.warn(`Rename source path not found: ${oldFullPath}`)
            operationStatus = 'rename_failed_source_not_found'
          }
        } else if (item.type === 'delete' && item.recycleBinDir) {
          const dirPath = path.join(store.databaseDir, item.path)
          const recycleBinTargetDir = path.join(
            store.databaseDir,
            'library',
            getCoreFsDirName('RecycleBin'),
            item.recycleBinDir.dirName
          )
          const isEmpty = await isDirectoryEffectivelyEmpty(dirPath, store.settingConfig.audioExt)
          if (isEmpty) {
            await fs.remove(dirPath)
            operationStatus = 'removed'
          } else {
            try {
              await fs.ensureDir(recycleBinTargetDir)
              const itemsToMove = await fs.readdir(dirPath)
              const tasks: Array<() => Promise<any>> = []
              for (const dirItem of itemsToMove) {
                if (dirItem !== '.description.json') {
                  const srcPath = path.join(dirPath, dirItem)
                  const destPath = path.join(recycleBinTargetDir, dirItem)
                  tasks.push(() => fs.move(srcPath, destPath, { overwrite: true }))
                }
              }
              const batchId = `recycleMove_${Date.now()}`
              const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
                concurrency: 16,
                stopOnENOSPC: true,
                onInterrupted: async (payload) =>
                  waitForUserDecision(getWindow(), batchId, 'recycleMove', payload)
              })
              if (failed === 0) {
                await fs.remove(dirPath)
              }
              const descriptionJson = {
                uuid: item.recycleBinDir.uuid,
                type: item.recycleBinDir.type,
                order: item.recycleBinDir.order
              }
              await operateHiddenFile(
                path.join(recycleBinTargetDir, '.description.json'),
                async () => {
                  await fs.outputJSON(
                    path.join(recycleBinTargetDir, '.description.json'),
                    descriptionJson
                  )
                }
              )
              operationStatus = 'recycled'
              recycleBinInfo = item.recycleBinDir
              if (hasENOSPC && getWindow()) {
                getWindow()?.webContents.send('file-batch-summary', {
                  context: 'recycleMove',
                  total: tasks.length,
                  success,
                  failed,
                  hasENOSPC,
                  skipped,
                  errorSamples: []
                })
              }
            } catch (moveError) {
              console.error(`Error moving ${item.path} to recycle bin:`, moveError)
              await fs.remove(dirPath).catch((cleanupError) => {
                console.error(
                  `Failed to cleanup original directory ${dirPath} after move error:`,
                  cleanupError
                )
              })
              operationStatus = 'recycle_failed'
            }
          }
        } else if (item.type === 'permanentlyDelete') {
          await fs.remove(path.join(store.databaseDir, item.path))
          operationStatus = 'permanently_deleted'
        } else if (item.type === 'move') {
          const srcFullPath = path.join(store.databaseDir, item.path)
          const destFullPath = path.join(store.databaseDir, item.newPath as string)
          if (await fs.pathExists(srcFullPath)) {
            await fs.ensureDir(path.dirname(destFullPath))
            await fs.move(srcFullPath, destFullPath, { overwrite: true })
            await operateHiddenFile(path.join(destFullPath, '.description.json'), async () => {
              let existingData = {}
              try {
                existingData = await fs.readJson(path.join(destFullPath, '.description.json'))
              } catch {}
              await fs.outputJSON(path.join(destFullPath, '.description.json'), {
                ...existingData,
                uuid: item.uuid,
                type: item.nodeType,
                order: item.order
              })
            })
            operationStatus = 'moved'
          } else {
            console.warn(`Move source path not found: ${srcFullPath}`)
            operationStatus = 'move_failed_source_not_found'
          }
        }
        results.push({ uuid: item.uuid, status: operationStatus, recycleBinDir: recycleBinInfo })
      }
      return { success: true, details: results }
    } catch (error) {
      console.error('operateFileSystemChange error:', error)
      return { success: false, error: (error as Error).message, details: results }
    }
  })
}

async function isDirectoryEffectivelyEmpty(dirPath: string, audioExtensions: string[]) {
  try {
    if (!(await fs.pathExists(dirPath))) {
      return true
    }
    const items = await fs.readdir(dirPath, { withFileTypes: true })
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name)
      if (item.isFile()) {
        const lowerExt = path.extname(item.name).toLowerCase()
        if (audioExtensions.includes(lowerExt)) {
          return false
        }
      } else if (item.isDirectory()) {
        if (!(await isDirectoryEffectivelyEmpty(fullPath, audioExtensions))) {
          return false
        }
      }
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }
    console.error(`Error checking directory emptiness for ${dirPath}:`, error)
    return false
  }
}
