import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { notifyCuratedArtistLibraryChanged } from '../curatedArtistLibrary'
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { getLibrary } from '../utils'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import {
  LibraryMergeError,
  inspectLibraryMergeSource,
  isLibraryMergeActive,
  mergeFrkbLibraries,
  type LibraryMergeMode
} from '../services/libraryMerge'
import { acquireLibraryMergeMutationLock } from '../services/libraryMerge/runtime'

type LibraryMergeStartPayload = {
  sourceRoot?: unknown
  mode?: unknown
}

const normalizeMode = (value: unknown): LibraryMergeMode =>
  value === 'delete-source' ? 'delete-source' : 'copy'

const getTargetRoot = (): string =>
  String(store.databaseDir || store.settingConfig?.databaseUrl || '').trim()

const getErrorPayload = (error: unknown) => {
  if (error instanceof LibraryMergeError) {
    return { success: false as const, code: error.code, message: error.message }
  }
  return {
    success: false as const,
    code: 'LIBRARY_MERGE_FAILED',
    message: error instanceof Error ? error.message : String(error || 'unknown error')
  }
}

const logLibraryMergeFailure = (
  operation: 'select-source' | 'inspect-source' | 'start',
  error: unknown,
  sourceRoot?: string
): void => {
  const code = error instanceof LibraryMergeError ? error.code : 'LIBRARY_MERGE_FAILED'
  const message = error instanceof Error ? error.message : String(error || 'unknown error')
  log.error('[library-merge] operation failed', {
    operation,
    code,
    message,
    ...(sourceRoot ? { sourceRoot } : {})
  })
}

const runMerge = async (sourceRoot: string, mode: LibraryMergeMode) => {
  const targetRoot = getTargetRoot()
  if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
  const releaseMutationLock = await acquireLibraryMergeMutationLock(mainWindow.instance)
  try {
    const result = await mergeFrkbLibraries({
      sourceRoot,
      targetRoot,
      appVersion: app.getVersion(),
      mode,
      onProgress: (progress) => {
        try {
          mainWindow.instance?.webContents.send('library-merge:progress', progress)
        } catch {}
      }
    })
    markGlobalSongSearchDirty('library-merge')
    notifyCuratedArtistLibraryChanged()
    const libraryTree = await getLibrary({ skipSync: true })
    mainWindow.instance?.webContents.send('library-tree-updated', libraryTree)
    return result
  } finally {
    releaseMutationLock()
  }
}

const selectSourceRoot = async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'FRKB 数据库', extensions: ['frkbdb'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const manifestPath = result.filePaths[0]
  if (path.basename(manifestPath) !== 'FRKB.database.frkbdb') {
    throw new LibraryMergeError('SOURCE_MANIFEST_INVALID', '请选择 FRKB.database.frkbdb')
  }
  return path.dirname(manifestPath)
}

export function openLibraryMergeDialog(): void {
  if (isLibraryMergeActive()) return
  mainWindow.instance?.webContents.send('library-merge:open-dialog')
}

export function registerLibraryMergeHandlers(): void {
  ipcMain.handle('library-merge:select-source', async () => {
    try {
      const sourceRoot = await selectSourceRoot()
      return { success: true as const, sourceRoot }
    } catch (error) {
      logLibraryMergeFailure('select-source', error)
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:inspect', async (_event, sourceRoot: unknown) => {
    try {
      const targetRoot = getTargetRoot()
      if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
      const summary = await inspectLibraryMergeSource({
        sourceRoot: String(sourceRoot || ''),
        targetRoot,
        appVersion: app.getVersion()
      })
      return { success: true as const, summary }
    } catch (error) {
      logLibraryMergeFailure('inspect-source', error, String(sourceRoot || '').trim())
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:start', async (_event, payload?: LibraryMergeStartPayload) => {
    try {
      const sourceRoot = String(payload?.sourceRoot || '').trim()
      if (!sourceRoot) throw new LibraryMergeError('SOURCE_MANIFEST_INVALID', '未选择来源库')
      const result = await runMerge(sourceRoot, normalizeMode(payload?.mode))
      return { success: true as const, result }
    } catch (error) {
      logLibraryMergeFailure('start', error, String(payload?.sourceRoot || '').trim())
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:active', () => isLibraryMergeActive())
  ipcMain.handle('library-merge:run-from-menu', async () => {
    openLibraryMergeDialog()
    return { success: true as const }
  })
}
