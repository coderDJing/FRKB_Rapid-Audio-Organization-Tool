import { log } from '../../log'
import libraryRelocateWindow from '../../window/libraryRelocateWindow'
import {
  autoFinishPendingRelocate,
  clearLibraryRelocateJournal,
  inspectPendingLibraryRelocate,
  toRelocateErrorCode,
  toRelocateErrorMessage,
  waitForRelocateUserEnter,
  type LibraryRelocateProgress
} from './index'

export type LibraryRelocateStartupResult = 'continue' | 'wait-ui'

const pushProgress = (progress: LibraryRelocateProgress) => {
  libraryRelocateWindow.setProgress(progress)
}

export const handleLibraryRelocateStartup = async (): Promise<LibraryRelocateStartupResult> => {
  const pending = await inspectPendingLibraryRelocate()
  if (pending.kind === 'none') return 'continue'
  await libraryRelocateWindow.createWindow()
  if (pending.kind === 'orphan') {
    await clearLibraryRelocateJournal()
    libraryRelocateWindow.closeWindow()
    return 'continue'
  }
  if (pending.kind === 'auto-finish') {
    try {
      const result = await autoFinishPendingRelocate(pushProgress)
      if (result.phase === 'source-cleanup-failed') {
        await waitForRelocateUserEnter()
      }
      return 'continue'
    } catch (error) {
      log.error('[library-relocate] 收尾未完成的移动任务失败', {
        code: toRelocateErrorCode(error),
        message: toRelocateErrorMessage(error)
      })
      pushProgress({
        phase: 'failed',
        sourcePath: pending.journal.sourcePath,
        destPath: pending.journal.destPath,
        copiedBytes: pending.journal.copiedBytes,
        totalBytes: pending.journal.totalBytes,
        copiedFiles: pending.journal.copiedFiles,
        totalFiles: pending.journal.totalFiles,
        currentPath: '',
        sameVolume: pending.journal.sameVolume,
        canCancel: false,
        errorCode: toRelocateErrorCode(error),
        errorMessage: toRelocateErrorMessage(error)
      })
      return 'wait-ui'
    }
  }
  pushProgress({
    phase: pending.kind === 'abort-only' ? 'abort-only' : 'prompt',
    sourcePath: pending.journal.sourcePath,
    destPath: pending.journal.destPath,
    copiedBytes: pending.journal.copiedBytes,
    totalBytes: pending.journal.totalBytes,
    copiedFiles: pending.journal.copiedFiles,
    totalFiles: pending.journal.totalFiles,
    currentPath: '',
    sameVolume: pending.journal.sameVolume,
    canCancel: false
  })
  return 'wait-ui'
}
