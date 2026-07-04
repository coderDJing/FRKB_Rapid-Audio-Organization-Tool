import type { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import path from 'node:path'
import { createKeyAnalysisBackground, type KeyAnalysisBackground } from './background'
import { createKeyAnalysisPersistence, type KeyAnalysisPersistence } from './persistence'
import { createKeyAnalysisWorkerPool, type KeyAnalysisWorkerPool } from './workerPool'
import { createKeyAnalysisFailureTracker, type KeyAnalysisFailureTracker } from './failureTracker'
import { log } from '../../log'
import {
  BACKGROUND_MAX_INFLIGHT,
  KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_JOB_TIMEOUT_MS,
  KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS,
  KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_WORKER_MAX,
  normalizePath,
  type KeyAnalysisAudioProbe,
  type DoneEntry,
  type KeyAnalysisBackgroundStatus,
  type KeyAnalysisFailureRecord,
  type KeyAnalysisJob,
  type KeyAnalysisPreemptionKind,
  type KeyAnalysisPriority,
  type KeyAnalysisProgress,
  type KeyAnalysisQueueCategory,
  type KeyAnalysisSource
} from './types'

type KeyAnalysisEnqueueOptions = {
  urgent?: boolean
  source?: KeyAnalysisSource
  fastAnalysis?: boolean
  focusSlot?: string
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  manualBatchId?: string
  manualBatchIds?: string[]
}

/**
 * 全局 key-analysis 队列。
 *
 * 核心原则：
 * - 所有分析任务（手动批量、可见列表、播放分析、后台闲时）共享同一个队列实例。
 * - 并发额度属于全局队列，不属于任何单个任务或 batch。
 * - 任务只负责逻辑归属（batch id、进度、取消），不持有并发额度，不自己 drain 队列。
 * - 10 个任务同时存在，也只能共享同一份额度（例如全局上限 2，则最多同时分析 2 首）。
 * - 优先级决定 job 选择顺序，不改变总并发上限。
 */
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
  private preemptedJobs = new Map<number, KeyAnalysisPreemptionKind>()
  private expectedWorkerTerminations = new WeakMap<Worker, string>()
  private focusPathBySlot = new Map<string, string>()
  private doneByPath = new Map<string, DoneEntry>()
  private failedByPath = new Map<string, KeyAnalysisFailureRecord>()
  private failureProbeInFlight = new Set<string>()
  private probeCache = new Map<
    string,
    {
      size: number
      mtimeMs: number
      probedAt: number
      probe: KeyAnalysisAudioProbe
    }
  >()
  private jobTimeouts = new Map<number, ReturnType<typeof setTimeout>>()
  private retiringWorkers = new Set<Worker>()
  private nextJobId = 0
  private events: EventEmitter
  private persistence: KeyAnalysisPersistence
  private background: KeyAnalysisBackground
  private workerPool: KeyAnalysisWorkerPool
  private failureTracker: KeyAnalysisFailureTracker
  private globalConcurrencyLimit = 1

  /**
   * 创建全局 key-analysis 队列。
   * @param workerCount 全局 worker 数量上限（所有任务共享，不按 batch 变化）
   * @param events 全局事件发射器
   */
  constructor(workerCount: number, events: EventEmitter) {
    const count = Math.max(1, Math.min(workerCount, KEY_ANALYSIS_WORKER_MAX))
    this.globalConcurrencyLimit = count
    this.events = events
    this.persistence = createKeyAnalysisPersistence({
      doneByPath: this.doneByPath,
      events
    })
    this.failureTracker = createKeyAnalysisFailureTracker({
      failedByPath: this.failedByPath,
      probeCache: this.probeCache,
      failureProbeInFlight: this.failureProbeInFlight
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
      preemptedJobs: this.preemptedJobs,
      retiringWorkers: this.retiringWorkers,
      getGlobalConcurrencyLimit: () => this.globalConcurrencyLimit,
      getForegroundWorker: () => this.foregroundWorker,
      setForegroundWorker: (worker) => {
        this.foregroundWorker = worker
      },
      markExpectedWorkerTermination: (worker, reason) => {
        this.markExpectedWorkerTermination(worker, reason)
      },
      clearExpectedWorkerTermination: (worker) => {
        this.clearExpectedWorkerTermination(worker)
      },
      consumeExpectedWorkerTermination: (worker) => this.consumeExpectedWorkerTermination(worker),
      persistence: this.persistence,
      background: this.background,
      enqueue: (filePath, priority, options) => this.enqueue(filePath, priority, options),
      onJobProgress: (worker, job, progress) => this.handleJobProgress(worker, job, progress),
      onJobFailure: (job, reason, detail) =>
        this.failureTracker.recordJobFailure(job, reason, detail),
      onJobSuccess: (job) => this.failureTracker.clearJobFailure(job),
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

  isForegroundBusy(): boolean {
    return this.hasForegroundWork()
  }

  getWorkerCount(): number {
    return this.workers.length
  }

  /**
   * 运行时调整全局并发上限。
   * 扩容：立即创建新 worker 并加入 idle 池（含补充即将退出的 retiring worker 名额）。
   * 缩容：标记多余 worker 为 retiring，等当前 job 完成后退出，不主动 terminate in-flight job。
   * retiring worker 仍留在 this.workers 中直到 job 完成，计算有效数量时需排除。
   */
  setGlobalConcurrency(targetCount: number) {
    const clamped = Math.max(1, Math.min(targetCount, KEY_ANALYSIS_WORKER_MAX))
    this.globalConcurrencyLimit = clamped
    const current = this.workers.length
    const retiringCount = this.retiringWorkers.size
    const effectiveCurrent = current - retiringCount
    if (clamped === effectiveCurrent) return

    if (clamped > effectiveCurrent) {
      let toAdd = clamped - effectiveCurrent
      for (const worker of Array.from(this.retiringWorkers)) {
        if (toAdd <= 0) break
        if (!this.workers.includes(worker)) {
          this.retiringWorkers.delete(worker)
          continue
        }
        this.retiringWorkers.delete(worker)
        toAdd -= 1
      }
      for (let i = 0; i < toAdd; i += 1) {
        this.workers.push(this.workerPool.createWorker())
      }
      this.workerPool.refreshForegroundWorker()
      this.drain()
      return
    }

    // 缩容：标记多余 worker 为 retiring，等当前 job 完成后自然退出
    const toRemove = effectiveCurrent - clamped
    let removed = 0
    for (let i = this.workers.length - 1; i >= 0 && removed < toRemove; i -= 1) {
      const worker = this.workers[i]
      if (!worker) continue
      if (this.retiringWorkers.has(worker)) continue
      if (this.busy.has(worker)) {
        // worker 正在执行 job，标记为 retiring，job 完成后不再复用
        this.retiringWorkers.add(worker)
        removed += 1
      } else {
        // worker 空闲，直接移除
        this.workers.splice(i, 1)
        const idleIdx = this.idle.indexOf(worker)
        if (idleIdx !== -1) this.idle.splice(idleIdx, 1)
        this.markExpectedWorkerTermination(worker, 'concurrency-downscale')
        void worker.terminate().catch(() => {
          this.clearExpectedWorkerTermination(worker)
          this.retiringWorkers.delete(worker)
        })
        removed += 1
      }
    }
    this.workerPool.refreshForegroundWorker()
    this.drain()
  }

  private releaseWorkerAfterSkippedJob(worker: Worker) {
    if (!this.retiringWorkers.has(worker)) {
      this.idle.push(worker)
      return
    }
    this.retiringWorkers.delete(worker)
    const workerIdx = this.workers.indexOf(worker)
    if (workerIdx !== -1) this.workers.splice(workerIdx, 1)
    const idleIdx = this.idle.indexOf(worker)
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1)
    this.markExpectedWorkerTermination(worker, 'concurrency-retire')
    void worker.terminate().catch(() => {
      this.clearExpectedWorkerTermination(worker)
    })
    this.workerPool.refreshForegroundWorker()
  }

  startBackgroundSweep() {
    this.background.startBackgroundSweep()
  }

  hasTrackedPath(normalizedPath: string): boolean {
    if (!normalizedPath) return false
    return this.pendingByPath.has(normalizedPath) || this.activeByPath.has(normalizedPath)
  }

  private applyWaveformOnlyOption(job: KeyAnalysisJob, waveformOnly?: boolean) {
    if (waveformOnly !== true) {
      if (waveformOnly === false || job.waveformOnly) {
        job.waveformOnly = false
      }
      return
    }
    if (job.waveformOnly === true) {
      job.waveformOnly = true
    }
  }

  private applyQueueCategory(job: KeyAnalysisJob, category?: KeyAnalysisQueueCategory) {
    if (!category) return
    if (job.category === 'manual-batch' && category !== 'manual-batch') return
    if (job.priority === 'high' && category === 'visible') return
    if (job.category === 'visible' && category === 'waveform-preview') return
    job.category = category
  }

  private normalizeManualBatchIds(options: {
    manualBatchId?: string
    manualBatchIds?: string[]
  }): string[] {
    const ids = [options.manualBatchId, ...(options.manualBatchIds || [])]
    return Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter((id) => id.length > 0))
    )
  }

  private addManualBatchIdsToJob(job: KeyAnalysisJob, batchIds: string[]) {
    if (!batchIds.length) return
    const current = Array.isArray(job.manualBatchIds) ? job.manualBatchIds.filter(Boolean) : []
    job.manualBatchIds = Array.from(new Set([...current, ...batchIds]))
  }

  private isTerminalStage(stage: unknown): stage is 'job-done' | 'job-error' {
    return stage === 'job-done' || stage === 'job-error'
  }

  private emitTerminalStageForManualBatchIds(job: KeyAnalysisJob, batchIds: string[]) {
    if (!batchIds.length || !this.isTerminalStage(job.trace?.lastStage)) return
    this.events.emit('analysis-stage-update', {
      filePath: job.filePath,
      stage: job.trace.lastStage,
      needsKey: job.needsKey,
      needsBpm: job.needsBpm,
      needsWaveform: job.needsWaveform,
      needsEnergy: job.needsEnergy,
      needsStructure: job.needsStructure,
      manualBatchIds: batchIds
    })
  }

  private removeManualBatchIdFromJob(job: KeyAnalysisJob, batchId: string): boolean {
    const current = job.manualBatchIds?.filter(Boolean) || []
    if (!current.includes(batchId)) return false
    const next = current.filter((id) => id !== batchId)
    job.manualBatchIds = next.length ? next : undefined
    return true
  }

  private isManualOnlyJob(job: KeyAnalysisJob): boolean {
    return job.category === 'manual-batch' && !this.hasActiveFocusSlot(job)
  }

  enqueue(
    filePath: string,
    priority: KeyAnalysisPriority,
    options: KeyAnalysisEnqueueOptions = {}
  ) {
    if (!filePath) return
    if (priority === 'background' && !this.background.isEnabled()) return
    this.background.clearBackgroundTimer()
    const normalizedPath = normalizePath(filePath)
    const source = options.source || (priority === 'background' ? 'background' : 'foreground')
    const focusSlot = this.normalizeFocusSlot(options.focusSlot)
    const manualBatchIds = this.normalizeManualBatchIds(options)
    if (source === 'foreground') {
      this.background.touchForeground()
    }
    if (focusSlot) {
      this.releaseFocusSlotFromPreviousAssignment(focusSlot, normalizedPath)
    }
    const active = this.activeByPath.get(normalizedPath)
    if (active) {
      this.addFocusSlotToJob(active, focusSlot)
      this.addManualBatchIdsToJob(active, manualBatchIds)
      this.emitTerminalStageForManualBatchIds(active, manualBatchIds)
      return
    }
    const existing = this.pendingByPath.get(normalizedPath)
    if (existing) {
      if (this.isHigherPriority(priority, existing.priority)) {
        this.removePending(existing)
        existing.priority = priority
        existing.source = source
        if (options.fastAnalysis !== undefined) {
          existing.fastAnalysis = options.fastAnalysis
        }
        if (options.preemptible !== undefined) {
          existing.preemptible = options.preemptible
        }
        this.applyQueueCategory(existing, options.category)
        this.applyWaveformOnlyOption(existing, options.waveformOnly)
        this.addManualBatchIdsToJob(existing, manualBatchIds)
        this.addFocusSlotToJob(existing, focusSlot)
        this.addPending(existing, options.urgent)
      } else {
        if (options.preemptible !== undefined) {
          existing.preemptible = options.preemptible
        }
        this.applyQueueCategory(existing, options.category)
        this.applyWaveformOnlyOption(existing, options.waveformOnly)
        this.addManualBatchIdsToJob(existing, manualBatchIds)
        this.addFocusSlotToJob(existing, focusSlot)
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
      fastAnalysis: options.fastAnalysis ?? false,
      source,
      preemptible: options.preemptible === true,
      category: options.category,
      waveformOnly: options.waveformOnly === true,
      manualBatchIds: manualBatchIds.length ? manualBatchIds : undefined
    }
    this.addFocusSlotToJob(job, focusSlot)
    this.addPending(job, options.urgent)
    if (source === 'foreground') {
      this.workerPool.maybePreemptForJob(job)
    }
    this.drain()
  }

  enqueueList(
    filePaths: string[],
    priority: KeyAnalysisPriority,
    options: KeyAnalysisEnqueueOptions = {}
  ) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      this.enqueue(filePath, priority, options)
    }
  }

  replaceVisibleList(filePaths: string[], options: { waveformOnly?: boolean } = {}) {
    for (const job of Array.from(this.pendingByPath.values())) {
      if (job.category !== 'visible') continue
      if (this.hasActiveFocusSlot(job)) continue
      this.removePending(job)
    }

    this.enqueueList(filePaths, 'low', {
      source: 'foreground',
      preemptible: true,
      category: 'visible',
      waveformOnly: options.waveformOnly === true
    })
    this.drain()
  }

  cancelBackgroundWork(pauseMs?: number) {
    for (const [worker, jobId] of this.busy.entries()) {
      const job = this.inFlight.get(jobId)
      if (job && job.source === 'background') {
        this.background.unmarkProcessing(job.jobId)
        this.markExpectedWorkerTermination(worker, 'background-cancel')
        void worker.terminate().catch(() => {
          this.clearExpectedWorkerTermination(worker)
        })
      }
    }
    this.background.cancelBackgroundWork(pauseMs)
  }

  async cancelByPath(filePaths: string[]) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    const normalizedPaths = new Set(
      filePaths
        .filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0)
        .map((filePath) => normalizePath(filePath))
        .filter(Boolean)
    )
    if (normalizedPaths.size === 0) return

    for (const normalizedPath of normalizedPaths) {
      const pending = this.pendingByPath.get(normalizedPath)
      if (pending) {
        this.removePending(pending)
      }
      this.doneByPath.delete(normalizedPath)
      this.failedByPath.delete(normalizedPath)
      this.probeCache.delete(normalizedPath)
    }

    for (const [focusSlot, normalizedPath] of this.focusPathBySlot.entries()) {
      if (normalizedPaths.has(normalizedPath)) {
        this.focusPathBySlot.delete(focusSlot)
      }
    }

    const terminations: Array<Promise<unknown>> = []
    for (const [worker, jobId] of Array.from(this.busy.entries())) {
      const job = this.inFlight.get(jobId)
      if (!job || !normalizedPaths.has(job.normalizedPath)) continue
      if (job.source === 'background') {
        this.background.unmarkProcessing(job.jobId)
      }
      this.markExpectedWorkerTermination(worker, 'path-cancel')
      terminations.push(
        worker.terminate().catch(() => {
          this.clearExpectedWorkerTermination(worker)
        })
      )
    }

    if (terminations.length > 0) {
      await Promise.allSettled(terminations)
      this.background.emitBackgroundStatus()
    }
  }

  async cancelManualBatch(batchId: string) {
    const normalizedBatchId = String(batchId || '').trim()
    if (!normalizedBatchId) return

    for (const job of Array.from(this.pendingByPath.values())) {
      if (!this.removeManualBatchIdFromJob(job, normalizedBatchId)) continue
      if (!job.manualBatchIds && this.isManualOnlyJob(job)) {
        this.removePending(job)
      }
    }

    const terminations: Array<Promise<unknown>> = []
    for (const [worker, jobId] of Array.from(this.busy.entries())) {
      const job = this.inFlight.get(jobId)
      if (!job) continue
      if (!this.removeManualBatchIdFromJob(job, normalizedBatchId)) continue
      if (job.manualBatchIds || !this.isManualOnlyJob(job)) continue
      this.markExpectedWorkerTermination(worker, 'manual-batch-cancel')
      terminations.push(
        worker.terminate().catch(() => {
          this.clearExpectedWorkerTermination(worker)
        })
      )
    }

    if (terminations.length > 0) {
      await Promise.allSettled(terminations)
      this.background.emitBackgroundStatus()
    }
  }

  private markExpectedWorkerTermination(worker: Worker, reason: string) {
    this.expectedWorkerTerminations.set(worker, reason)
  }

  private clearExpectedWorkerTermination(worker: Worker) {
    this.expectedWorkerTerminations.delete(worker)
  }

  private consumeExpectedWorkerTermination(worker: Worker): string | null {
    const reason = this.expectedWorkerTerminations.get(worker) || null
    this.expectedWorkerTerminations.delete(worker)
    return reason
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

  private normalizeFocusSlot(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase()
  }

  private addFocusSlotToJob(job: KeyAnalysisJob, focusSlot?: string) {
    const normalizedSlot = this.normalizeFocusSlot(focusSlot)
    if (!normalizedSlot) return
    const currentSlots = Array.isArray(job.focusSlots) ? job.focusSlots.filter(Boolean) : []
    if (!currentSlots.includes(normalizedSlot)) {
      job.focusSlots = [...currentSlots, normalizedSlot]
    } else {
      job.focusSlots = currentSlots
    }
    this.focusPathBySlot.set(normalizedSlot, job.normalizedPath)
  }

  private removeFocusSlotFromJob(job: KeyAnalysisJob, focusSlot: string) {
    const normalizedSlot = this.normalizeFocusSlot(focusSlot)
    if (!normalizedSlot || !Array.isArray(job.focusSlots) || job.focusSlots.length === 0) return
    const nextSlots = job.focusSlots.filter(
      (slot) => this.normalizeFocusSlot(slot) !== normalizedSlot
    )
    job.focusSlots = nextSlots.length > 0 ? nextSlots : undefined
  }

  private hasActiveFocusSlot(job: KeyAnalysisJob): boolean {
    return Array.isArray(job.focusSlots) && job.focusSlots.length > 0
  }

  private releaseFocusSlotFromPreviousAssignment(focusSlot: string, nextNormalizedPath: string) {
    const previousNormalizedPath = this.focusPathBySlot.get(focusSlot)
    if (!previousNormalizedPath || previousNormalizedPath === nextNormalizedPath) {
      this.focusPathBySlot.set(focusSlot, nextNormalizedPath)
      return
    }

    const previousJob =
      this.activeByPath.get(previousNormalizedPath) ||
      this.pendingByPath.get(previousNormalizedPath)
    if (previousJob) {
      this.removeFocusSlotFromJob(previousJob, focusSlot)
      if (!this.hasActiveFocusSlot(previousJob)) {
        if (this.pendingByPath.get(previousNormalizedPath) === previousJob) {
          this.removePending(previousJob)
        }
      }
    }

    this.focusPathBySlot.set(focusSlot, nextNormalizedPath)
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

  private clampStageTimeoutMs(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return KEY_ANALYSIS_JOB_TIMEOUT_MS
    return Math.max(1000, Math.min(Math.round(timeoutMs), KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS))
  }

  private getEstimatedDurationSec(job: KeyAnalysisJob): number | undefined {
    const probeDuration = Number(job.probe?.durationSec)
    if (Number.isFinite(probeDuration) && probeDuration > 0) {
      return probeDuration
    }
    const trace = job.trace
    const framesToProcess = Number(trace?.framesToProcess)
    const sampleRate = Number(trace?.sampleRate)
    if (
      Number.isFinite(framesToProcess) &&
      framesToProcess > 0 &&
      Number.isFinite(sampleRate) &&
      sampleRate > 0
    ) {
      return framesToProcess / sampleRate
    }
    const totalFrames = Number(trace?.totalFrames)
    if (
      Number.isFinite(totalFrames) &&
      totalFrames > 0 &&
      Number.isFinite(sampleRate) &&
      sampleRate > 0
    ) {
      return totalFrames / sampleRate
    }
    return undefined
  }

  private getStageTimeoutMs(job: KeyAnalysisJob, stage?: KeyAnalysisProgress['stage']): number {
    const estimatedDurationSec = this.getEstimatedDurationSec(job)
    const hasDuration = Number.isFinite(estimatedDurationSec) && Number(estimatedDurationSec) > 0
    const durationSec = hasDuration ? Number(estimatedDurationSec) : 0
    if (stage === 'decode-start') {
      let timeoutMs = KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS
      if (hasDuration) {
        timeoutMs = Math.max(timeoutMs, durationSec * 1000 * 1.25 + 120000)
      } else {
        const fileSizeMb = Math.max(0, Number(job.fileSize || 0)) / (1024 * 1024)
        timeoutMs = Math.max(timeoutMs, 120000 + fileSizeMb * 12000)
      }
      return this.clampStageTimeoutMs(timeoutMs)
    }

    if (stage === 'analyze-start') {
      const timeoutMs = hasDuration
        ? Math.max(KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS, durationSec * 1000 * 0.6 + 30000)
        : KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS
      return this.clampStageTimeoutMs(timeoutMs)
    }

    if (stage === 'waveform-start') {
      const timeoutMs = hasDuration
        ? Math.max(KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS, durationSec * 1000 * 0.25 + 20000)
        : KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS
      return this.clampStageTimeoutMs(timeoutMs)
    }

    return KEY_ANALYSIS_JOB_TIMEOUT_MS
  }

  private clearJobTimeout(jobId: number) {
    const timer = this.jobTimeouts.get(jobId)
    if (!timer) return
    clearTimeout(timer)
    this.jobTimeouts.delete(jobId)
  }

  private cleanupStaleJobTimeouts() {
    if (this.jobTimeouts.size === 0) return
    for (const jobId of this.jobTimeouts.keys()) {
      if (!this.inFlight.has(jobId)) {
        this.clearJobTimeout(jobId)
      }
    }
  }

  private scheduleJobTimeout(
    worker: Worker,
    job: KeyAnalysisJob,
    stage: KeyAnalysisProgress['stage'] = job.trace?.lastStage || 'job-received'
  ) {
    this.clearJobTimeout(job.jobId)
    const timeoutMs = this.getStageTimeoutMs(job, stage)
    const estimatedDurationSec = this.getEstimatedDurationSec(job)
    const timer = setTimeout(() => {
      this.jobTimeouts.delete(job.jobId)
      const activeJob = this.inFlight.get(job.jobId)
      if (!activeJob) return
      if (this.busy.get(worker) !== job.jobId) return
      activeJob.trace = {
        ...(activeJob.trace || {}),
        timedOutAt: Date.now()
      }
      this.failureTracker.recordJobFailure(activeJob, 'timeout')
      const trace = activeJob.trace
      const stageStuckMs =
        typeof trace?.lastUpdateAt === 'number' ? Date.now() - trace.lastUpdateAt : undefined
      log.error('[闲时分析] 任务执行超时，终止 worker', {
        filePath: activeJob.filePath,
        fileName: path.basename(activeJob.filePath),
        source: activeJob.source,
        workerThreadId: worker.threadId,
        stage: trace?.lastStage || 'unknown',
        stageStuckMs,
        elapsedMs: trace?.elapsedMs,
        decodeMs: trace?.decodeMs,
        analyzeMs: trace?.analyzeMs,
        waveformMs: trace?.waveformMs,
        decodeBackend: trace?.decodeBackend || 'unknown',
        sampleRate: trace?.sampleRate,
        channels: trace?.channels,
        totalFrames: trace?.totalFrames,
        framesToProcess: trace?.framesToProcess,
        partialKeyPersisted: trace?.partialKeyPersisted === true,
        partialBpmPersisted: trace?.partialBpmPersisted === true,
        detail: trace?.detail,
        timeoutMs,
        estimatedDurationSec
      })
      this.markExpectedWorkerTermination(worker, 'timeout')
      void worker.terminate().catch(() => {
        this.clearExpectedWorkerTermination(worker)
      })
    }, timeoutMs)
    this.jobTimeouts.set(job.jobId, timer)
  }

  private handleJobProgress(worker: Worker, job: KeyAnalysisJob, progress: KeyAnalysisProgress) {
    if (this.busy.get(worker) !== job.jobId) return
    if (progress.stage === 'job-done' || progress.stage === 'job-error') {
      this.clearJobTimeout(job.jobId)
      return
    }
    if (
      progress.stage === 'decode-start' ||
      progress.stage === 'analyze-start' ||
      progress.stage === 'waveform-start'
    ) {
      this.scheduleJobTimeout(worker, job, progress.stage)
    }
  }

  private emitCachedEnergyIfVisible(job: KeyAnalysisJob) {
    if (job.category !== 'manual-batch' && job.category !== 'visible') return
    if (job.prepareDetails?.energyCacheHit !== true) return
    const cached = this.doneByPath.get(job.normalizedPath)
    if (cached?.energyScore === undefined || cached.energyAlgorithmVersion === undefined) return
    this.events.emit('energy-updated', {
      filePath: job.filePath,
      energyScore: cached.energyScore,
      energyAlgorithmVersion: cached.energyAlgorithmVersion
    })
  }

  /**
   * 从全局待处理队列中取出 job 并分配给 idle worker。
   * 并发控制逻辑：
   * - worker 数量上限由 setGlobalConcurrency 动态调整（全局共享，不按 batch 变化）
   * - 后台分析受 BACKGROUND_MAX_INFLIGHT 限制，不会抢满全部 worker
   * - 优先级决定 job 选择顺序，不改变总并发上限
   */
  private drain() {
    this.failureTracker.cleanupStaleFailures()
    this.failureTracker.cleanupStaleProbeCache()
    this.cleanupStaleJobTimeouts()
    while (this.idle.length > 0) {
      if (this.busy.size >= this.globalConcurrencyLimit) break
      const hasForegroundPending =
        this.pendingHigh.length > 0 || this.pendingMedium.length > 0 || this.pendingLow.length > 0
      const allowAggressiveBackgroundConcurrency =
        !hasForegroundPending &&
        this.pendingBackground.length > 0 &&
        this.background.canUseAggressiveConcurrency()
      if (!hasForegroundPending && this.pendingBackground.length > 0) {
        const maxBackgroundInFlight = allowAggressiveBackgroundConcurrency
          ? Math.max(BACKGROUND_MAX_INFLIGHT, this.workers.length)
          : BACKGROUND_MAX_INFLIGHT
        if (this.countBackgroundInFlight() >= maxBackgroundInFlight) break
      }
      const worker = this.workerPool.getIdleWorker(
        hasForegroundPending ||
          !this.workerPool.getReservedWorker() ||
          allowAggressiveBackgroundConcurrency
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
          this.emitCachedEnergyIfVisible(job)
          this.events.emit('analysis-job-skipped', {
            filePath: job.filePath,
            manualBatchIds: job.manualBatchIds
          })
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.releaseWorkerAfterSkippedJob(worker)
          this.drain()
          return
        }
        const coolingRecord =
          job.needsKey || job.needsBpm ? this.failureTracker.getFailureCooldownRecord(job) : null
        if (coolingRecord) {
          this.events.emit('analysis-job-skipped', {
            filePath: job.filePath,
            manualBatchIds: job.manualBatchIds
          })
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.releaseWorkerAfterSkippedJob(worker)
          this.drain()
          return
        }
        if (job.source === 'background') {
          job.startTime = Date.now()
          this.background.markProcessing(job.jobId)
          this.background.emitBackgroundStatus()
        }
        try {
          await this.failureTracker.ensureJobProbe(job)
        } catch (error) {
          log.error('[闲时分析] 音频探测失败，回退默认预算', {
            jobId: job.jobId,
            filePath: job.filePath,
            source: job.source,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        job.trace = {
          ...(job.trace || {}),
          lastStage: 'job-received',
          lastUpdateAt: Date.now(),
          elapsedMs: 0
        }
        this.scheduleJobTimeout(worker, job, 'job-received')
        worker.postMessage({
          jobId: job.jobId,
          filePath: job.filePath,
          fastAnalysis: job.fastAnalysis,
          needsKey: job.needsKey,
          needsBpm: job.needsBpm,
          needsWaveform: job.needsWaveform,
          needsEnergy: job.needsEnergy,
          needsStructure: job.needsStructure,
          cachedBpm: job.cachedBpm,
          cachedFirstBeatMs: job.cachedFirstBeatMs,
          cachedBarBeatOffset: job.cachedBarBeatOffset
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
      const normalizedPath = normalizePath(filePath)
      this.doneByPath.delete(normalizedPath)
      this.failedByPath.delete(normalizedPath)
      this.probeCache.delete(normalizedPath)
    }
  }

  invalidateSongStructureByPath(filePaths: string[]) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      if (!filePath) continue
      const normalizedPath = normalizePath(filePath)
      const done = this.doneByPath.get(normalizedPath)
      if (!done?.songStructure) continue
      this.doneByPath.set(normalizedPath, {
        ...done,
        songStructure: undefined
      })
    }
  }

  remapTrackedPath(fromPath: string, toPath: string) {
    const fromNormalizedPath = normalizePath(fromPath)
    const toNormalizedPath = normalizePath(toPath)
    if (!fromNormalizedPath || !toNormalizedPath || fromNormalizedPath === toNormalizedPath) return

    const rebindJobPath = (job: KeyAnalysisJob) => {
      job.filePath = toPath
      job.normalizedPath = toNormalizedPath
    }

    const pendingJob = this.pendingByPath.get(fromNormalizedPath)
    if (pendingJob) {
      const hasConflict =
        this.pendingByPath.has(toNormalizedPath) || this.activeByPath.has(toNormalizedPath)
      this.pendingByPath.delete(fromNormalizedPath)
      if (hasConflict) {
        this.removePending(pendingJob)
      } else {
        rebindJobPath(pendingJob)
        this.pendingByPath.set(toNormalizedPath, pendingJob)
      }
    }

    const activeJob = this.activeByPath.get(fromNormalizedPath)
    if (activeJob) {
      this.activeByPath.delete(fromNormalizedPath)
      rebindJobPath(activeJob)
      this.activeByPath.set(toNormalizedPath, activeJob)
    }

    const doneEntry = this.doneByPath.get(fromNormalizedPath)
    if (doneEntry) {
      this.doneByPath.delete(fromNormalizedPath)
      if (!this.doneByPath.has(toNormalizedPath)) {
        this.doneByPath.set(toNormalizedPath, doneEntry)
      }
    }

    const failedEntry = this.failedByPath.get(fromNormalizedPath)
    if (failedEntry) {
      this.failedByPath.delete(fromNormalizedPath)
      if (!this.failedByPath.has(toNormalizedPath)) {
        this.failedByPath.set(toNormalizedPath, failedEntry)
      }
    }

    const probeEntry = this.probeCache.get(fromNormalizedPath)
    if (probeEntry) {
      this.probeCache.delete(fromNormalizedPath)
      if (!this.probeCache.has(toNormalizedPath)) {
        this.probeCache.set(toNormalizedPath, probeEntry)
      }
    }

    for (const [focusSlot, normalizedPath] of this.focusPathBySlot.entries()) {
      if (normalizedPath === fromNormalizedPath) {
        this.focusPathBySlot.set(focusSlot, toNormalizedPath)
      }
    }
  }
}
