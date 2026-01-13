import { ipcMain, shell, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
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
import {
  getRecycleBinRootAbs,
  moveFileToRecycleBin,
  normalizeRendererPlaylistPath,
  permanentlyDeleteFile
} from '../../recycleBinService'
import { listRecycleBinRecords, deleteRecycleBinRecords } from '../../recycleBinDb'

export function registerFilesystemHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.on('openFileExplorer', (_e, targetPath) => {
    const mapped = mapRendererPathToFsPath(String(targetPath || ''))
    shell.openPath(path.join(store.databaseDir, mapped))
  })

  ipcMain.on('show-item-in-folder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('emptyDir', async (_e, targetPath: string) => {
    const mappedPath = mapRendererPathToFsPath(targetPath)
    const absPath = path.join(store.databaseDir, mappedPath)
    const audioExts = store.settingConfig.audioExt
    const songFileUrls = await collectFilesWithExtensions(absPath, audioExts)
    const originalPlaylistPath = normalizeRendererPlaylistPath(targetPath)

    if (songFileUrls.length === 0) {
      await removeNonAudioEntries(absPath, audioExts)
      return
    }
    const tasks: Array<() => Promise<any>> = songFileUrls.map((srcPath) => {
      return async () => {
        const result = await moveFileToRecycleBin(srcPath, {
          originalPlaylistPath
        })
        if (result.status === 'failed') {
          throw new Error(result.error || 'move to recycle bin failed')
        }
        return result
      }
    })
    const batchId = `emptyDir_${Date.now()}`
    const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
      concurrency: 16,
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(getWindow(), batchId, 'emptyDir', payload)
    })
    await removeNonAudioEntries(absPath, audioExts)
    const targetWindow = getWindow()
    if (targetWindow && hasENOSPC) {
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
  })

  ipcMain.handle('emptyRecycleBin', async () => {
    const recycleBinPath = getRecycleBinRootAbs()
    if (!recycleBinPath) return
    try {
      if (!(await fs.pathExists(recycleBinPath))) return
      const entries = await fs.readdir(recycleBinPath, { withFileTypes: true })
      const deleteTasks: Array<Promise<any>> = []
      for (const entry of entries) {
        const entryPath = path.join(recycleBinPath, entry.name)
        if (entry.isDirectory()) {
          deleteTasks.push(fs.remove(entryPath))
        } else if (entry.isFile()) {
          deleteTasks.push(permanentlyDeleteFile(entryPath))
        }
      }
      await Promise.all(deleteTasks)
      const libraryRoot = path.join(store.databaseDir, 'library')
      const records = listRecycleBinRecords()
      const missingRecords: string[] = []
      for (const record of records) {
        const absPath = path.isAbsolute(record.filePath)
          ? record.filePath
          : path.join(libraryRoot, record.filePath)
        if (!(await fs.pathExists(absPath))) {
          missingRecords.push(record.filePath)
        }
      }
      if (missingRecords.length > 0) {
        deleteRecycleBinRecords(missingRecords)
      }
      const parentNode = findLibraryNodeByPath(path.join('library', getCoreFsDirName('RecycleBin')))
      if (parentNode) {
        removeLibraryNodesByParentUuid(parentNode.uuid)
      }
    } catch (error) {
      console.error('清空回收站失败:', error)
    }
  })

  ipcMain.handle('operateFileSystemChange', async (_e, operateArray: FileSystemOperation[]) => {
    const results: Array<{ uuid: string; status: string }> = []
    try {
      for (const item of operateArray) {
        let operationStatus = 'processed'
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
        } else if (item.type === 'delete') {
          const mappedPath = mapRendererPathToFsPath(item.path)
          const dirPath = path.join(store.databaseDir, mappedPath)
          const isEmpty = await isDirectoryEffectivelyEmpty(dirPath, store.settingConfig.audioExt)
          if (isEmpty) {
            await fs.remove(dirPath)
            removeLibraryNode(item.uuid)
            operationStatus = 'removed'
          } else {
            try {
              const audioExts = store.settingConfig.audioExt
              const audioFiles = await collectFilesWithExtensions(dirPath, audioExts)
              const tasks: Array<() => Promise<any>> = audioFiles.map((srcPath) => async () => {
                const result = await moveFileToRecycleBin(srcPath)
                if (result.status === 'failed') {
                  throw new Error(result.error || 'move to recycle bin failed')
                }
                return result
              })
              const batchId = `recycleMove_${Date.now()}`
              const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
                concurrency: 16,
                stopOnENOSPC: true,
                onInterrupted: async (payload) =>
                  waitForUserDecision(getWindow(), batchId, 'recycleMove', payload)
              })
              await removeNonAudioEntries(dirPath, audioExts)
              if (failed === 0) {
                await fs.remove(dirPath)
                removeLibraryNode(item.uuid)
              }
              operationStatus = failed === 0 ? 'recycled' : 'recycle_failed'
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
        results.push({ uuid: item.uuid, status: operationStatus })
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

function normalizeAudioExtensions(input?: string[]): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!raw) continue
    let ext = String(raw).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    result.add(ext)
  }
  return result
}

async function removeNonAudioEntries(dirPath: string, audioExtensions: string[]) {
  const audioSet = normalizeAudioExtensions(audioExtensions)
  await removeNonAudioRecursive(dirPath, audioSet, true)
}

async function removeNonAudioRecursive(dirPath: string, audioSet: Set<string>, keepRoot: boolean) {
  let entries: fs.Dirent[] = []
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await removeNonAudioRecursive(fullPath, audioSet, false)
      continue
    }
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (!audioSet.has(ext)) {
        try {
          await fs.remove(fullPath)
        } catch {}
      }
    }
  }
  if (!keepRoot) {
    try {
      const remain = await fs.readdir(dirPath)
      if (remain.length === 0) {
        await fs.remove(dirPath)
      }
    } catch {}
  }
}
