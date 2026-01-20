import os from 'node:os'
import { EventEmitter } from 'node:events'
import { KeyAnalysisQueue } from './keyAnalysis/queue'
import type { KeyAnalysisBackgroundStatus, KeyAnalysisPriority } from './keyAnalysis/types'

const workerCount = Math.max(1, Math.min(2, os.cpus().length))
export const keyAnalysisEvents = new EventEmitter()
let queue: KeyAnalysisQueue | null = null

const getQueue = () => {
  if (!queue) {
    queue = new KeyAnalysisQueue(workerCount, keyAnalysisEvents)
  }
  return queue
}

export function enqueueKeyAnalysis(filePath: string, priority: KeyAnalysisPriority = 'low') {
  getQueue().enqueue(filePath, priority)
}

export function enqueueKeyAnalysisList(filePaths: string[], priority: KeyAnalysisPriority = 'low') {
  getQueue().enqueueList(filePaths, priority)
}

export function enqueueKeyAnalysisImmediate(filePath: string) {
  getQueue().enqueue(filePath, 'high', { urgent: true })
}

export function startKeyAnalysisBackground() {
  getQueue().startBackgroundSweep()
}

export function cancelKeyAnalysisBackground(pauseMs?: number) {
  if (!queue) return
  queue.cancelBackgroundWork(pauseMs)
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

export function invalidateKeyAnalysisCache(filePaths: string[] | string) {
  if (!queue) return
  const list = Array.isArray(filePaths) ? filePaths : [filePaths]
  queue.invalidateDoneByPath(list)
}

export type { KeyAnalysisBackgroundStatus } from './keyAnalysis/types'
