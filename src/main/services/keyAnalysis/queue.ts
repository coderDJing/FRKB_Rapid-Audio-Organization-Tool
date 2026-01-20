import type { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { createKeyAnalysisBackground, type KeyAnalysisBackground } from './background'
import { createKeyAnalysisPersistence, type KeyAnalysisPersistence } from './persistence'
import { createKeyAnalysisWorkerPool, type KeyAnalysisWorkerPool } from './workerPool'
import {
  BACKGROUND_MAX_INFLIGHT,
  normalizePath,
  type DoneEntry,
  type KeyAnalysisBackgroundStatus,
  type KeyAnalysisJob,
  type KeyAnalysisPriority,
  type KeyAnalysisSource
} from './types'

export class KeyAnalysisQueue {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private foregroundWorker: Worker | null = null
  private pendingHigh: KeyAnalysisJob[] = []
  private pendingMedium: KeyAnalysisJob[] = []
  private pendingLow: KeyAnalysisJob[] = []
  private pendingBackground: KeyAnalysisJob[] = []
  private pendingByPath = new Map<string, KeyAnalysisJob>()
  private activeByPath = new Map<string, KeyAnalysisJob>()
  private busy = new Map<Worker, number>()
  private inFlight = new Map<number, KeyAnalysisJob>()
  private preemptedJobIds = new Set<number>()
  private doneByPath = new Map<string, DoneEntry>()
  private nextJobId = 0
  private events: EventEmitter
  private persistence: KeyAnalysisPersistence
  private background: KeyAnalysisBackground
  private workerPool: KeyAnalysisWorkerPool

  constructor(workerCount: number, events: EventEmitter) {
    const count = Math.max(1, workerCount)
    this.events = events
    this.persistence = createKeyAnalysisPersistence({
      doneByPath: this.doneByPath,
      events
    })
    this.background = createKeyAnalysisBackground({
      events,
      enqueueList: (filePaths, priority, options) => this.enqueueList(filePaths, priority, options),
      clearPendingBackground: () => this.clearPendingBackground(),
      hasForegroundWork: () => this.hasForegroundWork(),
      isIdle: () => this.isIdle(),
      countBackgroundInFlight: () => this.countBackgroundInFlight(),
      getPendingBackgroundCount: () => this.pendingBackground.length,
      pendingByPath: this.pendingByPath,
      activeByPath: this.activeByPath,
      doneByPath: this.doneByPath,
      persistence: this.persistence
    })
    this.workerPool = createKeyAnalysisWorkerPool({
      workers: this.workers,
      idle: this.idle,
      busy: this.busy,
      inFlight: this.inFlight,
      activeByPath: this.activeByPath,
      preemptedJobIds: this.preemptedJobIds,
      getForegroundWorker: () => this.foregroundWorker,
      setForegroundWorker: (worker) => {
        this.foregroundWorker = worker
      },
      persistence: this.persistence,
      background: this.background,
      enqueue: (filePath, priority, options) => this.enqueue(filePath, priority, options),
      drain: () => this.drain(),
      events: this.events
    })
    for (let i = 0; i < count; i += 1) {
      this.workers.push(this.workerPool.createWorker())
    }
    this.workerPool.refreshForegroundWorker()
  }

  getBackgroundStatusSnapshot(): KeyAnalysisBackgroundStatus {
    return this.background.getBackgroundStatusSnapshot()
  }

  startBackgroundSweep() {
    this.background.startBackgroundSweep()
  }

  enqueue(
    filePath: string,
    priority: KeyAnalysisPriority,
    options: { urgent?: boolean; source?: KeyAnalysisSource; fastAnalysis?: boolean } = {}
  ) {
    if (!filePath) return
    if (priority === 'background' && !this.background.isEnabled()) return
    this.background.clearBackgroundTimer()
    const normalizedPath = normalizePath(filePath)
    const source = options.source || (priority === 'background' ? 'background' : 'foreground')
    if (source === 'foreground') {
      this.background.touchForeground()
    }
    if (this.activeByPath.has(normalizedPath)) return
    const existing = this.pendingByPath.get(normalizedPath)
    if (existing) {
      if (this.isHigherPriority(priority, existing.priority)) {
        this.removePending(existing)
        existing.priority = priority
        existing.source = source
        if (options.fastAnalysis !== undefined) {
          existing.fastAnalysis = options.fastAnalysis
        }
        this.addPending(existing, options.urgent)
      }
      if (options.urgent && existing.priority === 'high') {
        this.removePending(existing)
        this.addPending(existing, true)
      }
      return
    }

    const job: KeyAnalysisJob = {
      jobId: ++this.nextJobId,
      filePath,
      normalizedPath,
      priority,
      fastAnalysis: options.fastAnalysis ?? true,
      source
    }
    this.addPending(job, options.urgent)
    if (source === 'foreground') {
      this.workerPool.maybePreemptBackground()
    }
    this.drain()
  }

  enqueueList(
    filePaths: string[],
    priority: KeyAnalysisPriority,
    options: { urgent?: boolean; source?: KeyAnalysisSource; fastAnalysis?: boolean } = {}
  ) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      this.enqueue(filePath, priority, options)
    }
  }

  cancelBackgroundWork(pauseMs?: number) {
    for (const [worker, jobId] of this.busy.entries()) {
      const job = this.inFlight.get(jobId)
      if (job && job.source === 'background') {
        this.background.unmarkProcessing(job.jobId)
        void worker.terminate().catch(() => {})
      }
    }
    this.background.cancelBackgroundWork(pauseMs)
  }

  private clearPendingBackground() {
    if (this.pendingBackground.length === 0) return
    for (const job of this.pendingBackground) {
      this.pendingByPath.delete(job.normalizedPath)
    }
    this.pendingBackground = []
  }

  private isHigherPriority(next: KeyAnalysisPriority, current: KeyAnalysisPriority): boolean {
    const rank = { high: 4, medium: 3, low: 2, background: 1 }
    return rank[next] > rank[current]
  }

  private addPending(job: KeyAnalysisJob, urgent?: boolean) {
    this.pendingByPath.set(job.normalizedPath, job)
    if (job.priority === 'high') {
      if (urgent) {
        this.pendingHigh.unshift(job)
      } else {
        this.pendingHigh.push(job)
      }
    } else if (job.priority === 'medium') {
      this.pendingMedium.push(job)
    } else if (job.priority === 'low') {
      this.pendingLow.push(job)
    } else {
      this.pendingBackground.push(job)
    }
    if (job.priority === 'background') {
      this.background.emitBackgroundStatus()
    }
  }

  private removePending(job: KeyAnalysisJob) {
    const removeFrom = (queue: KeyAnalysisJob[]) => {
      const idx = queue.findIndex((item) => item.normalizedPath === job.normalizedPath)
      if (idx !== -1) queue.splice(idx, 1)
    }
    removeFrom(this.pendingHigh)
    removeFrom(this.pendingMedium)
    removeFrom(this.pendingLow)
    removeFrom(this.pendingBackground)
    this.pendingByPath.delete(job.normalizedPath)
    if (job.priority === 'background') {
      this.background.emitBackgroundStatus()
    }
  }

  private popNextJob(): KeyAnalysisJob | null {
    const job =
      this.pendingHigh.shift() ||
      this.pendingMedium.shift() ||
      this.pendingLow.shift() ||
      this.pendingBackground.shift()
    if (!job) return null
    this.pendingByPath.delete(job.normalizedPath)
    return job
  }

  private hasForegroundWork(): boolean {
    if (
      this.pendingHigh.length > 0 ||
      this.pendingMedium.length > 0 ||
      this.pendingLow.length > 0
    ) {
      return true
    }
    for (const job of this.inFlight.values()) {
      if (job.source === 'foreground') return true
    }
    return false
  }

  private isIdle(): boolean {
    return (
      this.inFlight.size === 0 &&
      this.pendingHigh.length === 0 &&
      this.pendingMedium.length === 0 &&
      this.pendingLow.length === 0 &&
      this.pendingBackground.length === 0
    )
  }

  private countBackgroundInFlight(): number {
    return this.workerPool.countBackgroundInFlight()
  }

  private drain() {
    while (this.idle.length > 0) {
      const hasForegroundPending =
        this.pendingHigh.length > 0 || this.pendingMedium.length > 0 || this.pendingLow.length > 0
      if (!hasForegroundPending && this.pendingBackground.length > 0) {
        if (this.countBackgroundInFlight() >= BACKGROUND_MAX_INFLIGHT) break
      }
      const worker = this.workerPool.getIdleWorker(
        hasForegroundPending || !this.workerPool.getReservedWorker()
      )
      if (!worker) break
      const job = this.popNextJob()
      if (!job) {
        this.idle.push(worker)
        break
      }
      this.busy.set(worker, job.jobId)
      this.inFlight.set(job.jobId, job)
      this.activeByPath.set(job.normalizedPath, job)

      void (async () => {
        const ready = await this.persistence.prepareJob(job)
        if (!ready) {
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.idle.push(worker)
          this.drain()
          return
        }
        if (job.source === 'background') {
          job.startTime = Date.now()
          this.background.markProcessing(job.jobId)
          this.background.emitBackgroundStatus()
        }
        worker.postMessage({
          jobId: job.jobId,
          filePath: job.filePath,
          fastAnalysis: job.fastAnalysis,
          needsKey: job.needsKey,
          needsBpm: job.needsBpm,
          needsWaveform: job.needsWaveform
        })
      })()
    }
    if (this.isIdle()) {
      this.background.scheduleBackgroundScan()
    }
    this.background.emitBackgroundStatus()
  }

  invalidateDoneByPath(filePaths: string[]) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      if (!filePath) continue
      this.doneByPath.delete(normalizePath(filePath))
    }
  }
}
