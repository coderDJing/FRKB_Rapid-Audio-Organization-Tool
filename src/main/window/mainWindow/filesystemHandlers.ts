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
  waitForUserDecision
} from '../../utils'
import { FileSystemOperation } from '@renderer/utils/diffLibraryTree'
import {
  findLibraryNodeByPath,
  insertLibraryNode,
  moveLibraryNode,
  removeLibraryNode,
  removeLibraryNodesByParentUuid,
  updateLibraryNodeName,
  updateLibraryNodeOrder
} from '../../libraryTreeDb'

export function registerFilesystemHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.on('openFileExplorer', (_e, targetPath) => {
    const mapped = mapRendererPathToFsPath(String(targetPath || ''))
    shell.openPath(path.join(store.databaseDir, mapped))
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
    await fs.ensureDir(recycleBinTargetDir)
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
    const recycleNodePath = path.join('library', getCoreFsDirName('RecycleBin'), dirName)
    const existingNode = findLibraryNodeByPath(recycleNodePath)
    const descriptionJson = {
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
      const parentNode = findLibraryNodeByPath(path.join('library', getCoreFsDirName('RecycleBin')))
      if (parentNode) {
        removeLibraryNodesByParentUuid(parentNode.uuid)
      }
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
          const mappedPath = mapRendererPathToFsPath(item.path)
          const createPath = path.join(store.databaseDir, mappedPath)
          await fs.ensureDir(path.dirname(createPath))
          await fs.ensureDir(createPath)
          const parentNode = findLibraryNodeByPath(path.dirname(mappedPath))
          if (parentNode) {
            insertLibraryNode({
              uuid: item.uuid,
              parentUuid: parentNode.uuid,
              dirName: path.basename(mappedPath),
              nodeType: (item.nodeType as any) || 'dir',
              order: item.order
            })
          }
          operationStatus = 'created'
        } else if (item.type === 'reorder') {
          updateLibraryNodeOrder(item.uuid, item.order ?? null)
          operationStatus = 'reordered'
        } else if (item.type === 'rename') {
          const mappedOldPath = mapRendererPathToFsPath(item.path)
          const mappedNewPath = item.newPath
            ? mapRendererPathToFsPath(item.newPath)
            : path.join(path.dirname(mappedOldPath), item.newName || '')
          const oldFullPath = path.join(store.databaseDir, mappedOldPath)
          const newFullPath = path.join(store.databaseDir, mappedNewPath)
          if (await fs.pathExists(oldFullPath)) {
            await fs.rename(oldFullPath, newFullPath)
            updateLibraryNodeName(item.uuid, path.basename(mappedNewPath))
            operationStatus = 'renamed'
          } else {
            console.warn(`Rename source path not found: ${oldFullPath}`)
            operationStatus = 'rename_failed_source_not_found'
          }
        } else if (item.type === 'delete' && item.recycleBinDir) {
          const mappedPath = mapRendererPathToFsPath(item.path)
          const dirPath = path.join(store.databaseDir, mappedPath)
          const recycleBinTargetDir = path.join(
            store.databaseDir,
            'library',
            getCoreFsDirName('RecycleBin'),
            item.recycleBinDir.dirName
          )
          const isEmpty = await isDirectoryEffectivelyEmpty(dirPath, store.settingConfig.audioExt)
          if (isEmpty) {
            await fs.remove(dirPath)
            removeLibraryNode(item.uuid)
            operationStatus = 'removed'
          } else {
            try {
              await fs.ensureDir(recycleBinTargetDir)
              const itemsToMove = await fs.readdir(dirPath)
              const tasks: Array<() => Promise<any>> = []
              for (const dirItem of itemsToMove) {
                if (dirItem.startsWith('.description.json')) {
                  continue
                }
                const srcPath = path.join(dirPath, dirItem)
                const destPath = path.join(recycleBinTargetDir, dirItem)
                tasks.push(() => fs.move(srcPath, destPath, { overwrite: true }))
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
                removeLibraryNode(item.uuid)
              }
              operationStatus = 'recycled'
              recycleBinInfo = item.recycleBinDir
              const recycleNodePath = path.join(
                'library',
                getCoreFsDirName('RecycleBin'),
                item.recycleBinDir.dirName
              )
              const existingRecycle = findLibraryNodeByPath(recycleNodePath)
              if (!existingRecycle) {
                const parentNode = findLibraryNodeByPath(
                  path.join('library', getCoreFsDirName('RecycleBin'))
                )
                if (parentNode) {
                  insertLibraryNode({
                    uuid: item.recycleBinDir.uuid,
                    parentUuid: parentNode.uuid,
                    dirName: item.recycleBinDir.dirName,
                    nodeType: 'songList',
                    order: item.recycleBinDir.order
                  })
                }
              }
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
          const mappedPath = mapRendererPathToFsPath(item.path)
          await fs.remove(path.join(store.databaseDir, mappedPath))
          removeLibraryNode(item.uuid)
          operationStatus = 'permanently_deleted'
        } else if (item.type === 'move') {
          const mappedOldPath = mapRendererPathToFsPath(item.path)
          const mappedNewPath = mapRendererPathToFsPath(item.newPath as string)
          const srcFullPath = path.join(store.databaseDir, mappedOldPath)
          const destFullPath = path.join(store.databaseDir, mappedNewPath)
          if (await fs.pathExists(srcFullPath)) {
            await fs.ensureDir(path.dirname(destFullPath))
            await fs.move(srcFullPath, destFullPath, { overwrite: true })
            const parentNode = findLibraryNodeByPath(path.dirname(mappedNewPath))
            if (parentNode) {
              moveLibraryNode(item.uuid, parentNode.uuid, path.basename(mappedNewPath))
              if (item.order !== undefined) {
                updateLibraryNodeOrder(item.uuid, item.order)
              }
            }
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
