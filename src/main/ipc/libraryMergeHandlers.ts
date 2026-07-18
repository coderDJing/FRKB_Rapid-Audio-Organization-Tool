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
  getLibraryMergeBusySnapshot,
  isLibraryMergeActive,
  mergeFrkbLibraries,
  type LibraryMergeDuplicatePlaylistPolicy,
  type LibraryMergeMode,
  type LibraryMergeScope
} from '../services/libraryMerge'
import {
  inspectLibraryMergeSourceOffMainThread,
  LibraryMergeInspectCancelledError
} from '../services/libraryMerge/inspectOffThread'
import { acquireLibraryMergeMutationLock } from '../services/libraryMerge/runtime'

let activeInspectAbort: AbortController | null = null

type LibraryMergeStartPayload = {
  sourceRoot?: unknown
  mode?: unknown
  scope?: unknown
  duplicatePlaylistPolicy?: unknown
  cancelCancellableTasks?: unknown
}

const normalizeMode = (value: unknown): LibraryMergeMode =>
  value === 'delete-source' ? 'delete-source' : 'copy'

const normalizeScope = (value: unknown): LibraryMergeScope =>
  value === 'curated' ? 'curated' : 'full'

const normalizeDuplicatePlaylistPolicy = (value: unknown): LibraryMergeDuplicatePlaylistPolicy =>
  value === 'merge-into' ? 'merge-into' : 'rename'

const getTargetRoot = (): string =>
  String(store.databaseDir || store.settingConfig?.databaseUrl || '').trim()

const getErrorPayload = (error: unknown) => {
  if (error instanceof LibraryMergeError) {
    return {
      success: false as const,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    }
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
  context?: { sourceRoot?: string; scope?: LibraryMergeScope }
): void => {
  const code = error instanceof LibraryMergeError ? error.code : 'LIBRARY_MERGE_FAILED'
  const message = error instanceof Error ? error.message : String(error || 'unknown error')
  log.error('[library-merge] operation failed', {
    operation,
    code,
    message,
    ...(context?.scope ? { scope: context.scope } : {}),
    ...(context?.sourceRoot ? { sourceRoot: context.sourceRoot } : {})
  })
}

const runMerge = async (
  sourceRoot: string,
  mode: LibraryMergeMode,
  scope: LibraryMergeScope,
  cancelCancellableTasks: boolean,
  duplicatePlaylistPolicy: LibraryMergeDuplicatePlaylistPolicy
) => {
  const targetRoot = getTargetRoot()
  if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
  const releaseMutationLock = await acquireLibraryMergeMutationLock(mainWindow.instance, {
    cancelCancellableTasks,
    scope
  })
  try {
    const result = await mergeFrkbLibraries({
      sourceRoot,
      targetRoot,
      appVersion: app.getVersion(),
      mode,
      scope,
      duplicatePlaylistPolicy,
      onProgress: (progress) => {
        try {
          mainWindow.instance?.webContents.send('library-merge:progress', {
            ...progress,
            scope
          })
        } catch {}
      }
    })
    markGlobalSongSearchDirty('library-merge')
    if (scope === 'full') {
      notifyCuratedArtistLibraryChanged()
    }
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

export function openLibraryMergeDialog(scope: LibraryMergeScope = 'full'): void {
  if (isLibraryMergeActive()) return
  const channel =
    scope === 'curated' ? 'curated-library-merge:open-dialog' : 'library-merge:open-dialog'
  mainWindow.instance?.webContents.send(channel)
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

  ipcMain.handle('library-merge:inspect', async (_event, payload: unknown) => {
    const sourceRoot =
      typeof payload === 'string'
        ? payload
        : payload && typeof payload === 'object' && 'sourceRoot' in payload
          ? String((payload as { sourceRoot?: unknown }).sourceRoot || '')
          : ''
    const scope =
      payload && typeof payload === 'object' && 'scope' in payload
        ? normalizeScope((payload as { scope?: unknown }).scope)
        : 'full'
    const duplicatePlaylistPolicy =
      payload && typeof payload === 'object' && 'duplicatePlaylistPolicy' in payload
        ? normalizeDuplicatePlaylistPolicy(
            (payload as { duplicatePlaylistPolicy?: unknown }).duplicatePlaylistPolicy
          )
        : 'rename'
    activeInspectAbort?.abort()
    const abortController = new AbortController()
    activeInspectAbort = abortController
    try {
      const targetRoot = getTargetRoot()
      if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
      const summary = await inspectLibraryMergeSourceOffMainThread({
        sourceRoot,
        targetRoot,
        appVersion: app.getVersion(),
        scope,
        duplicatePlaylistPolicy,
        signal: abortController.signal
      })
      return { success: true as const, summary }
    } catch (error) {
      if (error instanceof LibraryMergeInspectCancelledError) {
        return {
          success: false as const,
          code: 'INSPECT_CANCELLED',
          message: '已取消来源库检查'
        }
      }
      logLibraryMergeFailure('inspect-source', error, {
        sourceRoot: sourceRoot.trim(),
        scope
      })
      return getErrorPayload(error)
    } finally {
      if (activeInspectAbort === abortController) activeInspectAbort = null
    }
  })

  ipcMain.handle('library-merge:cancel-inspect', () => {
    activeInspectAbort?.abort()
    activeInspectAbort = null
    return { success: true as const }
  })

  ipcMain.handle('library-merge:busy-status', (_event, payload?: { scope?: unknown }) => {
    const scope = normalizeScope(payload?.scope)
    // User-facing probe: only in-flight cancellable work + hard blocks for this scope.
    // Pending-only queues are not reported (acquire clears them silently).
    const snapshot = getLibraryMergeBusySnapshot({
      includeBackgroundTask: false,
      scope
    })
    return {
      success: true as const,
      busy: snapshot.blocking.length > 0 || snapshot.cancellable.length > 0,
      scope,
      ...snapshot
    }
  })

  ipcMain.handle('library-merge:start', async (_event, payload?: LibraryMergeStartPayload) => {
    const scope = normalizeScope(payload?.scope)
    try {
      const sourceRoot = String(payload?.sourceRoot || '').trim()
      if (!sourceRoot) throw new LibraryMergeError('SOURCE_MANIFEST_INVALID', '未选择来源库')
      const result = await runMerge(
        sourceRoot,
        normalizeMode(payload?.mode),
        scope,
        payload?.cancelCancellableTasks === true,
        normalizeDuplicatePlaylistPolicy(payload?.duplicatePlaylistPolicy)
      )
      return { success: true as const, result }
    } catch (error) {
      logLibraryMergeFailure('start', error, {
        sourceRoot: String(payload?.sourceRoot || '').trim(),
        scope
      })
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:active', () => isLibraryMergeActive())
  ipcMain.handle('library-merge:run-from-menu', async (_event, payload?: { scope?: unknown }) => {
    openLibraryMergeDialog(normalizeScope(payload?.scope))
    return { success: true as const }
  })
}
