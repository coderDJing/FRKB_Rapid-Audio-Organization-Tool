import type { BrowserWindow } from 'electron'
import { isAnyMixtapeWindowOpen } from '../../window/mixtapeWindow'
import { getKeyAnalysisBackgroundStatus, isKeyAnalysisForegroundBusy } from '../keyAnalysisQueue'
import { isMetadataAutoFillBusy } from '../metadataAutoFill'
import { isAudioConversionBusy } from '../audioConversion'
import { isPlaylistBatchRenameBusy } from '../playlistBatchRename'
import { isMixtapeRawWaveformQueueBusy } from '../mixtapeRawWaveformQueue'
import { isMixtapeStemQueueBusy } from '../mixtapeStemQueue'
import { isMixtapeWaveformQueueBusy } from '../mixtapeWaveformQueue'
import {
  isLibraryTreeWatcherBusy,
  startLibraryTreeWatcher,
  stopLibraryTreeWatcher
} from '../../libraryTreeWatcher'
import {
  getBackgroundTaskExecutionStatus,
  pauseBackgroundTaskExecution
} from '../backgroundOrchestrator'
import { isHorizontalBrowseTransportRecordingActive } from '../../ipc/horizontalBrowseTransportBridge'
import { isImportSongsBusy } from './operationActivity'
import { LibraryMergeError } from './types'
import { isLibraryMergeMutationLocked, setLibraryMergeMutationLocked } from './mutationGate'

export { isLibraryMergeMutationLocked } from './mutationGate'

export const getLibraryMergeBusyReasons = (): string[] => {
  const reasons: string[] = []
  const keyBackground = getKeyAnalysisBackgroundStatus()
  if (
    isKeyAnalysisForegroundBusy() ||
    keyBackground.active ||
    keyBackground.pending > 0 ||
    keyBackground.inFlight > 0 ||
    keyBackground.processing > 0 ||
    keyBackground.scanInProgress
  ) {
    reasons.push('key-analysis')
  }
  if (isMetadataAutoFillBusy()) reasons.push('metadata-auto-fill')
  if (isAudioConversionBusy()) reasons.push('audio-conversion')
  if (isPlaylistBatchRenameBusy()) reasons.push('playlist-batch-rename')
  if (isImportSongsBusy()) reasons.push('import')
  if (isMixtapeWaveformQueueBusy()) reasons.push('mixtape-waveform')
  if (isMixtapeRawWaveformQueueBusy()) reasons.push('mixtape-raw-waveform')
  if (isMixtapeStemQueueBusy()) reasons.push('mixtape-stem')
  if (isAnyMixtapeWindowOpen()) reasons.push('mixtape-window')
  if (isLibraryTreeWatcherBusy()) reasons.push('library-tree-watcher')
  if (isHorizontalBrowseTransportRecordingActive()) reasons.push('recording')
  const backgroundStatus = getBackgroundTaskExecutionStatus()
  if (backgroundStatus.pending > 0 || backgroundStatus.running) reasons.push('background-task')
  return reasons
}

export const acquireLibraryMergeMutationLock = (mainWindow: BrowserWindow | null): (() => void) => {
  if (isLibraryMergeMutationLocked()) {
    throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前库已有合并任务正在运行')
  }
  const reasons = getLibraryMergeBusyReasons()
  if (reasons.length > 0) {
    throw new LibraryMergeError('LIBRARY_BUSY', `当前库仍有运行中任务：${reasons.join(', ')}`)
  }
  const resumeBackgroundTasks = pauseBackgroundTaskExecution()
  setLibraryMergeMutationLocked(true)
  stopLibraryTreeWatcher()
  let released = false
  return () => {
    if (released) return
    released = true
    setLibraryMergeMutationLocked(false)
    resumeBackgroundTasks()
    startLibraryTreeWatcher(mainWindow)
  }
}

export const assertLibraryMergeMutationAllowed = (): void => {
  if (isLibraryMergeMutationLocked()) {
    throw new LibraryMergeError('LIBRARY_MERGE_IN_PROGRESS', '正在合并 FRKB 库，暂时不能修改当前库')
  }
}
