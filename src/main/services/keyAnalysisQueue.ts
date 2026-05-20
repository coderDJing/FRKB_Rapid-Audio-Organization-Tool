import { EventEmitter } from 'node:events'
import { KeyAnalysisQueue } from './keyAnalysis/queue'
import type { KeyAnalysisBackgroundStatus, KeyAnalysisPriority } from './keyAnalysis/types'
import * as LibraryCacheDb from '../libraryCacheDb'

// 分析是 CPU 重活，保持单路执行，给播放解码留调度余量。
const workerCount = 1
export const keyAnalysisEvents = new EventEmitter()
let queue: KeyAnalysisQueue | null = null

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
    category?: 'visible'
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
    category?: 'visible'
  } = {}
) {
  getQueue().enqueueList(filePaths, priority, options)
}

export function replaceVisibleKeyAnalysisList(filePaths: string[]) {
  getQueue().replaceVisibleList(filePaths)
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
