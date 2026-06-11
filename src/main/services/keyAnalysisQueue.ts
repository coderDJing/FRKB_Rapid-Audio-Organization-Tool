import { EventEmitter } from 'node:events'
import { KeyAnalysisQueue } from './keyAnalysis/queue'
import type {
  KeyAnalysisBackgroundStatus,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory
} from './keyAnalysis/types'
import { normalizePath } from './keyAnalysis/types'
import * as LibraryCacheDb from '../libraryCacheDb'

// 分析是 CPU 重活，保持单路执行，给播放解码留调度余量。
const workerCount = 1
export const keyAnalysisEvents = new EventEmitter()
let queue: KeyAnalysisQueue | null = null
let nextManualBatchSeq = 0

type ManualKeyAnalysisBatch = {
  id: string
  titleKey: string
  filePaths: string[]
  pendingByPath: Map<string, string>
  total: number
  completed: number
  canceled: boolean
}

const manualBatches = new Map<string, ManualKeyAnalysisBatch>()

const getQueue = () => {
  if (!queue) {
    queue = new KeyAnalysisQueue(workerCount, keyAnalysisEvents)
  }
  return queue
}

export function enqueueKeyAnalysis(
  filePath: string,
  priority: KeyAnalysisPriority = 'low',
  options: {
    urgent?: boolean
    source?: 'foreground' | 'background'
    fastAnalysis?: boolean
    focusSlot?: string
    preemptible?: boolean
    category?: KeyAnalysisQueueCategory
    waveformOnly?: boolean
    manualBatchId?: string
    manualBatchIds?: string[]
  } = {}
) {
  getQueue().enqueue(filePath, priority, options)
}

export function enqueueKeyAnalysisList(
  filePaths: string[],
  priority: KeyAnalysisPriority = 'low',
  options: {
    urgent?: boolean
    source?: 'foreground' | 'background'
    fastAnalysis?: boolean
    focusSlot?: string
    preemptible?: boolean
    category?: KeyAnalysisQueueCategory
    waveformOnly?: boolean
    manualBatchId?: string
    manualBatchIds?: string[]
  } = {}
) {
  getQueue().enqueueList(filePaths, priority, options)
}

const emitManualBatchProgress = (batch: ManualKeyAnalysisBatch) => {
  keyAnalysisEvents.emit('manual-batch-progress', {
    id: batch.id,
    titleKey: batch.titleKey,
    now: Math.min(batch.completed, batch.total),
    total: batch.total,
    cancelable: true,
    cancelChannel: 'key-analysis:cancel-manual-batch',
    cancelPayload: { batchId: batch.id }
  })
}

const finishManualBatch = (batch: ManualKeyAnalysisBatch, canceled = false) => {
  if (!manualBatches.has(batch.id)) return
  manualBatches.delete(batch.id)
  batch.canceled = canceled
  keyAnalysisEvents.emit('manual-batch-end', {
    batchId: batch.id,
    filePaths: batch.filePaths,
    canceled
  })
  keyAnalysisEvents.emit('manual-batch-progress', {
    id: batch.id,
    ...(canceled
      ? { dismiss: true }
      : {
          titleKey: batch.titleKey,
          now: batch.total,
          total: batch.total,
          cancelable: false
        })
  })
  if (canceled) {
    for (const filePath of batch.filePaths) {
      keyAnalysisEvents.emit('analysis-stage-update', {
        filePath,
        stage: 'job-error',
        manualBatchIds: [batch.id]
      })
    }
  }
}

const completeManualBatchFile = (filePath: string, manualBatchIds?: string[]) => {
  const normalizedPath = normalizePath(filePath)
  if (!normalizedPath) return
  const batchIdSet =
    Array.isArray(manualBatchIds) && manualBatchIds.length > 0 ? new Set(manualBatchIds) : null
  for (const batch of manualBatches.values()) {
    if (batchIdSet && !batchIdSet.has(batch.id)) continue
    if (!batch.pendingByPath.has(normalizedPath)) continue
    batch.pendingByPath.delete(normalizedPath)
    batch.completed = Math.min(batch.total, batch.completed + 1)
    if (batch.pendingByPath.size === 0) {
      finishManualBatch(batch)
    } else {
      emitManualBatchProgress(batch)
    }
  }
}

keyAnalysisEvents.on(
  'analysis-stage-update',
  (payload?: { filePath?: string; stage?: string; manualBatchIds?: string[] }) => {
    const stage = String(payload?.stage || '')
    if (stage !== 'job-done' && stage !== 'job-error') return
    completeManualBatchFile(String(payload?.filePath || ''), payload?.manualBatchIds)
  }
)

keyAnalysisEvents.on(
  'analysis-job-skipped',
  (payload?: { filePath?: string; manualBatchIds?: string[] }) => {
    if (!Array.isArray(payload?.manualBatchIds) || payload.manualBatchIds.length === 0) return
    keyAnalysisEvents.emit('analysis-stage-update', {
      filePath: String(payload?.filePath || ''),
      stage: 'job-done',
      manualBatchIds: payload.manualBatchIds
    })
  }
)

export function enqueueManualKeyAnalysisBatch(
  filePaths: string[],
  options?: { titleKey?: string }
) {
  const pendingByPath = new Map<string, string>()
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof filePath !== 'string') continue
    const trimmed = filePath.trim()
    if (!trimmed) continue
    const normalized = normalizePath(trimmed)
    if (!normalized || pendingByPath.has(normalized)) continue
    pendingByPath.set(normalized, trimmed)
  }
  const uniqueFilePaths = Array.from(pendingByPath.values())
  if (uniqueFilePaths.length === 0) {
    return { batchId: '', queued: 0 }
  }

  const batchId = `key-analysis.manual.${Date.now()}.${++nextManualBatchSeq}`
  const batch: ManualKeyAnalysisBatch = {
    id: batchId,
    titleKey: String(options?.titleKey || 'tracks.analyzingTracks'),
    filePaths: uniqueFilePaths,
    pendingByPath,
    total: uniqueFilePaths.length,
    completed: 0,
    canceled: false
  }
  manualBatches.set(batchId, batch)
  keyAnalysisEvents.emit('manual-batch-start', {
    batchId,
    filePaths: uniqueFilePaths
  })
  emitManualBatchProgress(batch)
  enqueueKeyAnalysisList(uniqueFilePaths, 'medium', {
    source: 'foreground',
    preemptible: true,
    category: 'manual-batch',
    manualBatchId: batchId
  })
  return { batchId, queued: uniqueFilePaths.length }
}

export async function cancelManualKeyAnalysisBatch(batchId: string) {
  const normalizedBatchId = String(batchId || '').trim()
  const batch = manualBatches.get(normalizedBatchId)
  if (!batch) return { canceled: false }
  await getQueue().cancelManualBatch(normalizedBatchId)
  finishManualBatch(batch, true)
  return { canceled: true }
}

export function replaceVisibleKeyAnalysisList(
  filePaths: string[],
  options: { waveformOnly?: boolean } = {}
) {
  getQueue().replaceVisibleList(filePaths, options)
}

export function startKeyAnalysisBackground() {
  getQueue().startBackgroundSweep()
}

export function cancelKeyAnalysisBackground(pauseMs?: number) {
  if (!queue) return
  queue.cancelBackgroundWork(pauseMs)
}

export async function cancelKeyAnalysisForPaths(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  await queue.cancelByPath(list)
}

export function getKeyAnalysisBackgroundStatus(): KeyAnalysisBackgroundStatus {
  if (!queue) {
    return {
      active: false,
      pending: 0,
      inFlight: 0,
      processing: 0,
      scanInProgress: false,
      enabled: false
    }
  }
  return queue.getBackgroundStatusSnapshot()
}

export function isKeyAnalysisForegroundBusy(): boolean {
  if (!queue) return false
  return queue.isForegroundBusy()
}

export function invalidateKeyAnalysisCache(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  queue.invalidateDoneByPath(list)
  LibraryCacheDb.unregisterExternalAnalysisContexts(list)
}

export function remapKeyAnalysisTrackedPath(fromPath: string, toPath: string) {
  if (!queue) return
  queue.remapTrackedPath(fromPath, toPath)
}

export type { KeyAnalysisBackgroundStatus } from './keyAnalysis/types'
