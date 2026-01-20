import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { log } from '../../log'
import type { KeyAnalysisBackground } from './background'
import type { KeyAnalysisPersistence } from './persistence'
import {
  isValidBpm,
  isValidKeyText,
  type KeyAnalysisJob,
  type KeyAnalysisPriority,
  type WorkerPayload
} from './types'

type KeyAnalysisWorkerPoolDeps = {
  workers: Worker[]
  idle: Worker[]
  busy: Map<Worker, number>
  inFlight: Map<number, KeyAnalysisJob>
  activeByPath: Map<string, KeyAnalysisJob>
  preemptedJobIds: Set<number>
  getForegroundWorker: () => Worker | null
  setForegroundWorker: (worker: Worker | null) => void
  persistence: KeyAnalysisPersistence
  background: KeyAnalysisBackground
  enqueue: (
    filePath: string,
    priority: KeyAnalysisPriority,
    options?: { urgent?: boolean; source?: 'foreground' | 'background'; fastAnalysis?: boolean }
  ) => void
  drain: () => void
  events: EventEmitter
}

export const createKeyAnalysisWorkerPool = (deps: KeyAnalysisWorkerPoolDeps) => {
  const removeWorkerFromList = (list: Worker[], worker: Worker) => {
    const idx = list.indexOf(worker)
    if (idx !== -1) list.splice(idx, 1)
  }

  const handleWorkerFailure = (worker: Worker, error: Error) => {
    const jobId = deps.busy.get(worker)
    const wasPreempted = typeof jobId === 'number' && deps.preemptedJobIds.has(jobId)
    const wasForegroundWorker = deps.getForegroundWorker() === worker
    let preemptedJob: KeyAnalysisJob | null = null
    let job: KeyAnalysisJob | undefined
    if (typeof jobId === 'number') {
      job = deps.inFlight.get(jobId)
      if (job) {
        if (job.source === 'background') {
          if (!wasPreempted) {
            const errorMsg = `[闲时分析] Worker 崩溃 - ${path.basename(job.filePath)}`
            log.error(errorMsg, error)
          }
          deps.background.unmarkProcessing(job.jobId)
        }
        deps.activeByPath.delete(job.normalizedPath)
        deps.inFlight.delete(jobId)
      }
      if (wasPreempted) {
        deps.preemptedJobIds.delete(jobId)
        if (job) {
          preemptedJob = job
        }
      }
      deps.busy.delete(worker)
    } else {
      const errorMsg = '[闲时分析] Worker 崩溃（无关联任务）'
      log.error(errorMsg, error)
    }

    removeWorkerFromList(deps.workers, worker)
    removeWorkerFromList(deps.idle, worker)

    let replacement: Worker | null = null
    if (!wasPreempted) {
      replacement = createWorker()
      deps.workers.push(replacement)
    }
    if (wasForegroundWorker) {
      deps.setForegroundWorker(replacement)
    }
    refreshForegroundWorker()
    deps.drain()
    if (preemptedJob) {
      deps.enqueue(preemptedJob.filePath, 'background', { source: 'background' })
    }
    deps.background.emitBackgroundStatus()
  }

  const handleWorkerMessage = async (worker: Worker, payload: WorkerPayload) => {
    const jobId = payload?.jobId
    const job = deps.inFlight.get(jobId)
    const payloadResult = payload?.result
    const payloadError = payload?.error

    if (typeof jobId === 'number') {
      deps.preemptedJobIds.delete(jobId)
    }
    deps.inFlight.delete(jobId)
    deps.busy.delete(worker)
    deps.idle.push(worker)
    if (job) {
      deps.activeByPath.delete(job.normalizedPath)
      if (job.source === 'background') {
        const results: string[] = []
        const errors: string[] = []
        if (payloadResult?.keyText && !payloadResult.keyError) results.push('key')
        else if (payloadResult?.keyError) errors.push(`key: ${payloadResult.keyError}`)
        if (payloadResult?.bpm && !payloadResult.bpmError) results.push('bpm')
        else if (payloadResult?.bpmError) errors.push(`bpm: ${payloadResult.bpmError}`)
        if (payloadResult?.mixxxWaveformData) results.push('waveform')
        if (payloadError) errors.push(`worker错误: ${payloadError}`)

        if (errors.length > 0) {
          const elapsed = job.startTime ? Date.now() - job.startTime : 0
          const statusMsg = `[闲时分析] 任务完成但有错误 - ${path.basename(job.filePath)} (耗时: ${elapsed}ms) 错误: ${errors.join('; ')}`
          log.warn(statusMsg)
        }

        deps.background.unmarkProcessing(job.jobId)
        deps.background.emitBackgroundStatus()
      }
    }

    if (job && payloadResult && !payloadResult.keyError) {
      const keyText = payloadResult.keyText
      if (isValidKeyText(keyText)) {
        await deps.persistence.persistKey(job.filePath, keyText)
      }
    }

    if (job && payloadResult && !payloadResult.bpmError) {
      const bpmValue = payloadResult.bpm
      if (isValidBpm(bpmValue)) {
        await deps.persistence.persistBpm(job.filePath, bpmValue)
      }
    }

    if (job && payloadResult?.mixxxWaveformData && job.needsWaveform) {
      await deps.persistence.persistWaveform(job.filePath, payloadResult.mixxxWaveformData)
      deps.events.emit('waveform-updated', { filePath: job.filePath })
    }

    deps.drain()
  }

  const createWorker = (): Worker => {
    const workerPath = path.join(__dirname, 'workers', 'keyAnalysisWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: WorkerPayload) => {
      void handleWorkerMessage(worker, payload)
    })

    worker.on('error', (error) => {
      handleWorkerFailure(worker, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        handleWorkerFailure(worker, new Error(`worker exited: ${code}`))
      }
    })

    deps.idle.push(worker)
    return worker
  }

  const refreshForegroundWorker = () => {
    if (deps.workers.length <= 1) {
      deps.setForegroundWorker(null)
      return
    }
    const current = deps.getForegroundWorker()
    if (current && deps.workers.includes(current)) {
      return
    }
    deps.setForegroundWorker(deps.workers[0] || null)
  }

  const getReservedWorker = (): Worker | null => {
    if (deps.workers.length <= 1) return null
    return deps.getForegroundWorker()
  }

  const getIdleWorker = (allowReserved: boolean): Worker | null => {
    if (deps.idle.length === 0) return null
    const reserved = getReservedWorker()
    if (!reserved || allowReserved) {
      return deps.idle.shift() || null
    }
    const idx = deps.idle.findIndex((item) => item !== reserved)
    if (idx === -1) return null
    const [worker] = deps.idle.splice(idx, 1)
    return worker || null
  }

  const maybePreemptBackground = () => {
    if (deps.idle.length > 0) return
    if (deps.workers.length <= 1) return
    if (deps.getForegroundWorker()) return
    for (const [worker, jobId] of deps.busy.entries()) {
      const job = deps.inFlight.get(jobId)
      if (job && job.source === 'background') {
        deps.preemptedJobIds.add(jobId)
        void worker.terminate().catch(() => {})
        return
      }
    }
  }

  const countBackgroundInFlight = (): number => {
    let count = 0
    for (const job of deps.inFlight.values()) {
      if (job.source === 'background') count += 1
    }
    return count
  }

  return {
    countBackgroundInFlight,
    createWorker,
    getIdleWorker,
    getReservedWorker,
    maybePreemptBackground,
    refreshForegroundWorker
  }
}

export type KeyAnalysisWorkerPool = ReturnType<typeof createKeyAnalysisWorkerPool>
