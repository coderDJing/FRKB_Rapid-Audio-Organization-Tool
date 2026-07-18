import type { BrowserWindow } from 'electron'
import { isAnyMixtapeWindowOpen } from '../../window/mixtapeWindow'
import {
  cancelAllKeyAnalysisForLibraryMerge,
  getKeyAnalysisLibraryMergeActivity
} from '../keyAnalysisQueue'
import {
  cancelAllMetadataAutoFill,
  isMetadataAutoFillBusy,
  waitForMetadataAutoFillIdle
} from '../metadataAutoFill'
import { isAudioConversionBusy } from '../audioConversion'
import { isPlaylistBatchRenameBusy } from '../playlistBatchRename'
import {
  cancelMixtapeRawWaveformQueueForLibraryMerge,
  isMixtapeRawWaveformQueueBusy,
  waitForMixtapeRawWaveformQueueIdle
} from '../mixtapeRawWaveformQueue'
import { isMixtapeStemQueueBusy } from '../mixtapeStemQueue'
import {
  cancelMixtapeWaveformQueueForLibraryMerge,
  isMixtapeWaveformQueueBusy,
  waitForMixtapeWaveformQueueIdle
} from '../mixtapeWaveformQueue'
import {
  isLibraryTreeWatcherBusy,
  startLibraryTreeWatcher,
  stopLibraryTreeWatcher
} from '../../libraryTreeWatcher'
import {
  getBackgroundTaskExecutionStatus,
  interruptBackgroundTaskExecution
} from '../backgroundOrchestrator'
import { isHorizontalBrowseTransportRecordingActive } from '../../ipc/horizontalBrowseTransportBridge'
import { isImportSongsBusy } from './operationActivity'
import {
  LibraryMergeError,
  type LibraryMergeBusyClassification,
  type LibraryMergeBusyReason,
  type LibraryMergeScope
} from './types'
import { isLibraryMergeMutationLocked, setLibraryMergeMutationLocked } from './mutationGate'

export { isLibraryMergeMutationLocked } from './mutationGate'

/**
 * Finer busy policy (risk-tiered):
 * - Only real in-flight work needs a confirm dialog (cancellable).
 * - Pending-only queues are cleared silently before taking the lock.
 * - Hard-blocking covers moves/import/rename/recording and full-scope mixtape writers.
 * - Curated merge does not hard-block open mixtape windows or stem jobs (they do not
 *   share curated playlist / analysis write paths the same way full merge does).
 */
const CANCELLABLE_BUSY_REASONS = new Set<LibraryMergeBusyReason>([
  'key-analysis',
  'metadata-auto-fill',
  'mixtape-waveform',
  'mixtape-raw-waveform'
])

type BusyCollectOptions = {
  /** When true, surface a running orchestrator callback (rarely needed for UI). */
  includeBackgroundTask?: boolean
  scope?: LibraryMergeScope
}

const normalizeScope = (scope?: LibraryMergeScope): LibraryMergeScope =>
  scope === 'curated' ? 'curated' : 'full'

/**
 * User-facing busy reasons only. Pending-only key-analysis is intentionally omitted —
 * acquireLibraryMergeMutationLock clears it without prompting.
 */
const collectBusyReasons = (options: BusyCollectOptions = {}): LibraryMergeBusyReason[] => {
  const scope = normalizeScope(options.scope)
  const reasons: LibraryMergeBusyReason[] = []

  const keyActivity = getKeyAnalysisLibraryMergeActivity()
  // Confirm only when analysis is actually running / writing, not when merely queued.
  if (keyActivity.inFlight) {
    reasons.push('key-analysis')
  }

  if (isMetadataAutoFillBusy()) reasons.push('metadata-auto-fill')
  if (isAudioConversionBusy()) reasons.push('audio-conversion')
  if (isPlaylistBatchRenameBusy()) reasons.push('playlist-batch-rename')
  if (isImportSongsBusy()) reasons.push('import')

  // Waveform cache writers touch the library cache DB; cancel when in-flight.
  if (isMixtapeWaveformQueueBusy()) reasons.push('mixtape-waveform')
  if (isMixtapeRawWaveformQueueBusy()) reasons.push('mixtape-raw-waveform')

  // Full merge rewrites mixtape-related tree + files; curated import does not.
  if (scope === 'full') {
    if (isMixtapeStemQueueBusy()) reasons.push('mixtape-stem')
    if (isAnyMixtapeWindowOpen()) reasons.push('mixtape-window')
  }

  if (isLibraryTreeWatcherBusy()) reasons.push('library-tree-watcher')
  if (isHorizontalBrowseTransportRecordingActive()) reasons.push('recording')

  // Pending orchestrator work is dropped by interruptBackgroundTaskExecution.
  // Only a currently running callback is worth surfacing (and even then we wait,
  // not force-kill). Default probe path keeps this off to avoid noisy prompts.
  if (options.includeBackgroundTask === true) {
    const backgroundStatus = getBackgroundTaskExecutionStatus()
    if (backgroundStatus.running) reasons.push('background-task')
  }

  return reasons
}

export const classifyLibraryMergeBusyReasons = (
  reasons: readonly string[]
): LibraryMergeBusyClassification => {
  const cancellable: LibraryMergeBusyReason[] = []
  const blocking: LibraryMergeBusyReason[] = []
  for (const reason of reasons) {
    const normalized = String(reason || '').trim() as LibraryMergeBusyReason
    if (!normalized) continue
    if (CANCELLABLE_BUSY_REASONS.has(normalized)) {
      if (!cancellable.includes(normalized)) cancellable.push(normalized)
      continue
    }
    if (!blocking.includes(normalized)) blocking.push(normalized)
  }
  return { cancellable, blocking }
}

export const getLibraryMergeBusyReasons = (options: BusyCollectOptions = {}): string[] =>
  collectBusyReasons(options)

export const getLibraryMergeBusySnapshot = (
  options: BusyCollectOptions = {}
): LibraryMergeBusyClassification => classifyLibraryMergeBusyReasons(collectBusyReasons(options))

const waitForLibraryTreeWatcherIdle = async (timeoutMs = 30000): Promise<boolean> => {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (isLibraryTreeWatcherBusy()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/** Drop queued key-analysis work that has not started writing yet — no user prompt. */
const silentClearPendingOnlyKeyAnalysis = async (): Promise<void> => {
  const activity = getKeyAnalysisLibraryMergeActivity()
  if (activity.any && !activity.inFlight) {
    await cancelAllKeyAnalysisForLibraryMerge()
  }
}

const cancelCancellableBusyTasks = async (
  reasons: readonly LibraryMergeBusyReason[]
): Promise<void> => {
  const reasonSet = new Set(reasons)
  if (reasonSet.has('key-analysis')) {
    await cancelAllKeyAnalysisForLibraryMerge()
  }
  if (reasonSet.has('metadata-auto-fill')) {
    cancelAllMetadataAutoFill()
    const idle = await waitForMetadataAutoFillIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止元数据自动补全任务，请稍后再试'
      )
    }
  }
  if (reasonSet.has('mixtape-waveform')) {
    cancelMixtapeWaveformQueueForLibraryMerge()
    const idle = await waitForMixtapeWaveformQueueIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止 Mixtape 波形分析任务，请稍后再试'
      )
    }
  }
  if (reasonSet.has('mixtape-raw-waveform')) {
    cancelMixtapeRawWaveformQueueForLibraryMerge()
    const idle = await waitForMixtapeRawWaveformQueueIdle()
    if (!idle) {
      throw new LibraryMergeError(
        'LIBRARY_BUSY_CANCEL_FAILED',
        '无法及时停止 Mixtape 原始波形任务，请稍后再试'
      )
    }
  }
}

export type AcquireLibraryMergeMutationLockOptions = {
  cancelCancellableTasks?: boolean
  scope?: LibraryMergeScope
}

export const acquireLibraryMergeMutationLock = async (
  mainWindow: BrowserWindow | null,
  options: AcquireLibraryMergeMutationLockOptions = {}
): Promise<() => void> => {
  if (isLibraryMergeMutationLocked()) {
    throw new LibraryMergeError('MERGE_ALREADY_ACTIVE', '当前库已有合并任务正在运行')
  }

  const scope = normalizeScope(options.scope)

  // Give an in-flight tree reconcile a short window to finish before treating it as hard-busy.
  if (isLibraryTreeWatcherBusy()) {
    await waitForLibraryTreeWatcherIdle(5000)
  }

  // Drop pending orchestrator work and wait for any running bounded callback.
  const resumeBackgroundTasks = await interruptBackgroundTaskExecution()
  try {
    // Pending-only analysis queues never need a confirm dialog.
    await silentClearPendingOnlyKeyAnalysis()

    let snapshot = getLibraryMergeBusySnapshot({
      includeBackgroundTask: false,
      scope
    })
    if (snapshot.blocking.length > 0) {
      throw new LibraryMergeError('LIBRARY_BUSY_BLOCKING', '当前库仍有不能自动取消的任务', {
        blocking: snapshot.blocking,
        cancellable: snapshot.cancellable
      })
    }
    if (snapshot.cancellable.length > 0) {
      if (!options.cancelCancellableTasks) {
        throw new LibraryMergeError('LIBRARY_BUSY_CANCELLABLE', '当前库仍有可安全取消的分析任务', {
          blocking: [],
          cancellable: snapshot.cancellable
        })
      }
      await cancelCancellableBusyTasks(snapshot.cancellable)
      snapshot = getLibraryMergeBusySnapshot({
        includeBackgroundTask: false,
        scope
      })
      if (snapshot.blocking.length > 0 || snapshot.cancellable.length > 0) {
        throw new LibraryMergeError(
          'LIBRARY_BUSY_CANCEL_FAILED',
          '已尝试取消分析任务，但当前库仍未完全空闲',
          {
            blocking: snapshot.blocking,
            cancellable: snapshot.cancellable
          }
        )
      }
    }
  } catch (error) {
    resumeBackgroundTasks()
    throw error
  }

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
