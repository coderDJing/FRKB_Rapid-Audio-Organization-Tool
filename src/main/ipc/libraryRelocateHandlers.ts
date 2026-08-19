import { dialog, ipcMain, type OpenDialogOptions } from 'electron'
import path from 'node:path'
import { log } from '../log'
import store from '../store'
import mainWindow from '../window/mainWindow'
import databaseInitWindow from '../window/databaseInitWindow'
import libraryRelocateWindow from '../window/libraryRelocateWindow'
import startupWindow from '../window/startupWindow'
import { mergeLayoutConfig, persistLayoutConfig } from '../layoutConfig'
import { prepareAndOpenMainWindow } from '../bootstrap/prepareDatabase'
import { openLibraryRelocateDialog } from '../services/libraryRelocate/openDialog'
import {
  LibraryRelocateError,
  abortLibraryRelocate,
  beginRelocateAbortSignal,
  checkLibraryRelocateReady,
  getLibraryRelocateProgress,
  getRelocateBusyDetails,
  inspectPendingLibraryRelocate,
  isLibraryRelocateActive,
  journalToPreview,
  notifyRelocateUserEnter,
  prepareLibraryRuntimeForRelocate,
  previewLibraryRelocate,
  readLibraryRelocateJournal,
  requestRelocateCancel,
  runLibraryRelocate,
  toRelocateErrorCode,
  toRelocateErrorMessage,
  waitForRelocateUserEnter,
  type LibraryRelocatePreview,
  type LibraryRelocateProgress
} from '../services/libraryRelocate'

let runningRelocate: Promise<void> | null = null

const getErrorPayload = (error: unknown) => {
  if (error instanceof LibraryRelocateError) {
    return {
      success: false as const,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(getRelocateBusyDetails(error) || {})
    }
  }
  return {
    success: false as const,
    code: toRelocateErrorCode(error),
    message: toRelocateErrorMessage(error)
  }
}

const persistMainLayout = async () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  const size = win.getSize()
  const next = mergeLayoutConfig(store.layoutConfig, {
    isMaxMainWin: !!win.isMaximized(),
    ...(size ? { mainWindowWidth: size[0], mainWindowHeight: size[1] } : {})
  })
  store.layoutConfig = next
  await persistLayoutConfig(next)
}

const closeMainWindowAndWait = async () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  await persistMainLayout()
  await new Promise<void>((resolve) => {
    win.once('closed', () => resolve())
    win.close()
  })
}

const pushProgress = (progress: LibraryRelocateProgress) => {
  libraryRelocateWindow.setProgress(progress)
}

const finishToMainWindow = async () => {
  // 先建立接替窗口，再关闭移动窗；否则会短暂触发 window-all-closed 并退出应用。
  await startupWindow.createWindow()
  libraryRelocateWindow.closeWindow()
  await prepareAndOpenMainWindow()
}

const finishToInitWindow = async () => {
  databaseInitWindow.createWindow({ needErrorHint: true })
  libraryRelocateWindow.closeWindow()
}

const runRelocateSession = async (
  preview: LibraryRelocatePreview,
  options: { closeMain: boolean }
) => {
  const signal = beginRelocateAbortSignal()
  pushProgress({
    phase: 'preparing',
    sourcePath: preview.sourcePath,
    destPath: preview.destPath,
    copiedBytes: 0,
    totalBytes: preview.totalBytes,
    copiedFiles: 0,
    totalFiles: preview.totalFiles,
    currentPath: '',
    sameVolume: preview.sameVolume,
    canCancel: false
  })
  if (options.closeMain) {
    await closeMainWindowAndWait()
  }
  await prepareLibraryRuntimeForRelocate()
  try {
    const result = await runLibraryRelocate({ preview, signal, onProgress: pushProgress })
    if (result.phase === 'source-cleanup-failed') {
      await waitForRelocateUserEnter()
    }
    await finishToMainWindow()
  } catch (error) {
    if (error instanceof LibraryRelocateError && error.code === 'CANCELED') {
      const aborted = await abortLibraryRelocate({ onProgress: pushProgress })
      if (aborted.sourceExists) await finishToMainWindow()
      else await finishToInitWindow()
      return
    }
    log.error('[library-relocate] 移动 FRKB 库失败', {
      code: toRelocateErrorCode(error),
      message: toRelocateErrorMessage(error),
      sourcePath: preview.sourcePath,
      destPath: preview.destPath
    })
  }
}

const enqueueRelocateSession = (
  preview: LibraryRelocatePreview,
  options: { closeMain: boolean }
) => {
  runningRelocate = runRelocateSession(preview, options).finally(() => {
    runningRelocate = null
  })
}

export function registerLibraryRelocateHandlers(): void {
  ipcMain.handle('library-relocate:run-from-menu', async () => {
    openLibraryRelocateDialog()
    return { success: true as const }
  })

  ipcMain.handle('library-relocate:check-ready', async () => {
    try {
      const ready = await checkLibraryRelocateReady()
      return { success: true as const, sourcePath: ready.sourcePath }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:select-parent', async () => {
    try {
      const ready = await checkLibraryRelocateReady()
      const win = mainWindow.instance
      const dialogOptions: OpenDialogOptions = {
        properties: ['openDirectory'],
        defaultPath: path.dirname(ready.sourcePath)
      }
      const result =
        win && !win.isDestroyed()
          ? await dialog.showOpenDialog(win, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !result.filePaths[0]) {
        return { success: true as const, canceled: true as const, parentPath: null }
      }
      return { success: true as const, canceled: false as const, parentPath: result.filePaths[0] }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:preview', async (_event, payload?: { parentPath?: unknown }) => {
    try {
      const ready = await checkLibraryRelocateReady()
      const parentPath = String(payload?.parentPath || '').trim()
      if (!parentPath) {
        throw new LibraryRelocateError('PARENT_MISSING', '未选择目标父目录')
      }
      const preview = await previewLibraryRelocate({
        sourcePath: ready.sourcePath,
        parentPath
      })
      return { success: true as const, preview }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:start', async (_event, payload?: { parentPath?: unknown }) => {
    try {
      const ready = await checkLibraryRelocateReady()
      const parentPath = String(payload?.parentPath || '').trim()
      if (!parentPath) {
        throw new LibraryRelocateError('PARENT_MISSING', '未选择目标父目录')
      }
      const preview = await previewLibraryRelocate({
        sourcePath: ready.sourcePath,
        parentPath
      })
      await libraryRelocateWindow.createWindow()
      enqueueRelocateSession(preview, { closeMain: true })
      return { success: true as const }
    } catch (error) {
      log.error('[library-relocate] 无法开始移动 FRKB 库', {
        code: toRelocateErrorCode(error),
        message: toRelocateErrorMessage(error)
      })
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:get-state', async () => {
    const pending = await inspectPendingLibraryRelocate()
    return {
      success: true as const,
      pending,
      progress: getLibraryRelocateProgress(),
      active: isLibraryRelocateActive()
    }
  })

  ipcMain.handle('library-relocate:continue', async () => {
    try {
      const journal = await readLibraryRelocateJournal()
      if (!journal) {
        throw new LibraryRelocateError('JOURNAL_INVALID', '没有可继续的 FRKB 库移动任务')
      }
      const preview = await previewLibraryRelocate({
        sourcePath: journal.sourcePath,
        parentPath: journal.parentPath,
        resumeDestPath: journal.destPath
      })
      enqueueRelocateSession(preview, { closeMain: false })
      return { success: true as const }
    } catch (error) {
      log.error('[library-relocate] 无法继续移动 FRKB 库', {
        code: toRelocateErrorCode(error),
        message: toRelocateErrorMessage(error)
      })
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:cancel', async () => {
    try {
      const current = getLibraryRelocateProgress()
      if (runningRelocate && current && !current.canCancel) {
        return { success: false as const, code: 'RELOCATE_ACTIVE', message: '当前阶段无法取消' }
      }
      requestRelocateCancel()
      if (runningRelocate) {
        await runningRelocate.catch(() => {})
        return { success: true as const }
      }
      const aborted = await abortLibraryRelocate({ onProgress: pushProgress })
      if (aborted.sourceExists) await finishToMainWindow()
      else await finishToInitWindow()
      return { success: true as const }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:abort', async () => {
    try {
      if (runningRelocate) {
        requestRelocateCancel()
        await runningRelocate.catch(() => {})
        return { success: true as const }
      }
      const aborted = await abortLibraryRelocate({ onProgress: pushProgress })
      if (aborted.sourceExists) await finishToMainWindow()
      else await finishToInitWindow()
      return { success: true as const }
    } catch (error) {
      log.error('[library-relocate] 放弃移动 FRKB 库失败', {
        code: toRelocateErrorCode(error),
        message: toRelocateErrorMessage(error)
      })
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:retry', async () => {
    try {
      const journal = await readLibraryRelocateJournal()
      const progress = getLibraryRelocateProgress()
      if (!journal && !progress) {
        throw new LibraryRelocateError('JOURNAL_INVALID', '没有可重试的 FRKB 库移动任务')
      }
      const preview = journal
        ? journalToPreview(journal)
        : {
            sourcePath: progress?.sourcePath || '',
            destPath: progress?.destPath || '',
            parentPath: path.dirname(progress?.destPath || ''),
            folderName: path.basename(progress?.destPath || ''),
            totalBytes: progress?.totalBytes || 0,
            totalFiles: progress?.totalFiles || 0,
            sameVolume: progress?.sameVolume === true
          }
      enqueueRelocateSession(preview, { closeMain: false })
      return { success: true as const }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-relocate:enter-library', () => {
    notifyRelocateUserEnter()
    return { success: true as const }
  })
}

export const isLibraryRelocateBlocking = (): boolean => isLibraryRelocateActive()
