import type { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createKeyAnalysisBackground, type KeyAnalysisBackground } from './background'
import { createKeyAnalysisPersistence, type KeyAnalysisPersistence } from './persistence'
import { createKeyAnalysisWorkerPool, type KeyAnalysisWorkerPool } from './workerPool'
import { resolveBundledFfmpegPath } from '../../ffmpeg'
import { log } from '../../log'
import store from '../../store'
import { normalizeBeatGridAnalyzerProvider } from '../beatGridAlgorithmVersion'
import {
  BACKGROUND_MAX_INFLIGHT,
  KEY_ANALYSIS_ANALYZE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_DECODE_STAGE_TIMEOUT_MS,
  KEY_ANALYSIS_FAILURE_BASE_COOLDOWN_MS,
  KEY_ANALYSIS_FAILURE_MAX_COOLDOWN_MS,
  KEY_ANALYSIS_FAILURE_RECORD_TTL_MS,
  KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD,
  KEY_ANALYSIS_JOB_TIMEOUT_MS,
  KEY_ANALYSIS_STAGE_TIMEOUT_MAX_MS,
  KEY_ANALYSIS_TIMEOUT_PROBE_MIN_FILE_SIZE_BYTES,
  KEY_ANALYSIS_TIMEOUT_PROBE_TIMEOUT_MS,
  KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS,
  KEY_ANALYSIS_WAVEFORM_STAGE_TIMEOUT_MS,
  normalizePath,
  type KeyAnalysisAudioProbe,
  type DoneEntry,
  type KeyAnalysisBackgroundStatus,
  type KeyAnalysisFailureReason,
  type KeyAnalysisFailureRecord,
  type KeyAnalysisJob,
  type KeyAnalysisPreemptionKind,
  type KeyAnalysisPriority,
  type KeyAnalysisProgress,
  type KeyAnalysisSource
} from './types'

const execFileAsync = promisify(execFile)

const resolveCurrentBeatGridAnalyzerProvider = () =>
  normalizeBeatGridAnalyzerProvider(store.settingConfig?.beatGridAnalyzerProvider) ?? 'beatthis'

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
      preemptedJobs: this.preemptedJobs,
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
      onJobFailure: (job, reason, detail) => this.recordJobFailure(job, reason, detail),
      onJobSuccess: (job) => this.clearJobFailure(job),
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

  startBackgroundSweep() {
    this.background.startBackgroundSweep()
  }

  enqueue(
    filePath: string,
    priority: KeyAnalysisPriority,
    options: {
      urgent?: boolean
      source?: KeyAnalysisSource
      fastAnalysis?: boolean
      focusSlot?: string
      preemptible?: boolean
      category?: 'visible'
    } = {}
  ) {
    if (!filePath) return
    if (priority === 'background' && !this.background.isEnabled()) return
    this.background.clearBackgroundTimer()
    const normalizedPath = normalizePath(filePath)
    const source = options.source || (priority === 'background' ? 'background' : 'foreground')
    const focusSlot = this.normalizeFocusSlot(options.focusSlot)
    if (source === 'foreground') {
      this.background.touchForeground()
    }
    if (focusSlot) {
      this.releaseFocusSlotFromPreviousAssignment(focusSlot, normalizedPath)
    }
    const active = this.activeByPath.get(normalizedPath)
    if (active) {
      this.addFocusSlotToJob(active, focusSlot)
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
        if (options.category !== undefined) {
          existing.category = options.category
        }
        this.addFocusSlotToJob(existing, focusSlot)
        this.addPending(existing, options.urgent)
      } else {
        if (options.preemptible !== undefined) {
          existing.preemptible = options.preemptible
        }
        if (options.category !== undefined) {
          existing.category = options.category
        }
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
      category: options.category
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
    options: {
      urgent?: boolean
      source?: KeyAnalysisSource
      fastAnalysis?: boolean
      focusSlot?: string
      preemptible?: boolean
      category?: 'visible'
    } = {}
  ) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      this.enqueue(filePath, priority, options)
    }
  }

  replaceVisibleList(filePaths: string[]) {
    const normalizedIncoming = Array.from(
      new Set(
        (Array.isArray(filePaths) ? filePaths : [])
          .filter((filePath) => typeof filePath === 'string')
          .map((filePath) => filePath.trim())
          .filter(Boolean)
          .map((filePath) => normalizePath(filePath))
      )
    )
    const keepSet = new Set(normalizedIncoming)

    for (const job of Array.from(this.pendingByPath.values())) {
      if (job.category !== 'visible') continue
      if (keepSet.has(job.normalizedPath)) continue
      this.removePending(job)
    }

    this.enqueueList(filePaths, 'low', {
      source: 'foreground',
      preemptible: true,
      category: 'visible'
    })
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

  private findWorkerByJobId(jobId: number): Worker | null {
    for (const [worker, activeJobId] of this.busy.entries()) {
      if (activeJobId === jobId) {
        return worker
      }
    }
    return null
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
        } else {
          const worker = this.findWorkerByJobId(previousJob.jobId)
          if (worker) {
            this.preemptedJobs.set(previousJob.jobId, 'focus-superseded')
            this.markExpectedWorkerTermination(worker, 'focus-superseded')
            void worker.terminate().catch(() => {
              this.clearExpectedWorkerTermination(worker)
            })
          }
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

  private cleanupStaleFailures() {
    if (this.failedByPath.size === 0) return
    const now = Date.now()
    for (const [normalizedPath, record] of this.failedByPath.entries()) {
      if (now - record.lastFailedAt <= KEY_ANALYSIS_FAILURE_RECORD_TTL_MS) continue
      this.failedByPath.delete(normalizedPath)
    }
  }

  private getJobFileVersion(job: KeyAnalysisJob): { size: number; mtimeMs: number } {
    const size = Number.isFinite(job.fileSize) ? Number(job.fileSize) : -1
    const mtimeMs = Number.isFinite(job.fileMtimeMs) ? Number(job.fileMtimeMs) : -1
    return { size, mtimeMs }
  }

  private isSameFileVersion(
    left: { size: number; mtimeMs: number },
    right: { size: number; mtimeMs: number }
  ): boolean {
    return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 1
  }

  private computeFailureCooldownMs(failCount: number): number {
    if (failCount < KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD) return 0
    const exp = failCount - KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD
    return Math.min(
      KEY_ANALYSIS_FAILURE_BASE_COOLDOWN_MS * 2 ** exp,
      KEY_ANALYSIS_FAILURE_MAX_COOLDOWN_MS
    )
  }

  private inferFailureCause(job: KeyAnalysisJob, reason: KeyAnalysisFailureReason): string {
    const stage = job.trace?.lastStage
    if (reason === 'timeout') {
      if (stage === 'decode-start') return 'decode-stage-timeout'
      if (stage === 'analyze-start') {
        const decodeMs = Number(job.trace?.decodeMs || 0)
        if (decodeMs >= KEY_ANALYSIS_JOB_TIMEOUT_MS * 0.75) {
          return 'decode-consumed-time-budget'
        }
        return 'analyze-stage-timeout'
      }
      if (stage === 'waveform-start') return 'waveform-stage-timeout'
      return 'job-timeout'
    }
    if (reason === 'worker-exit') return 'worker-process-exit'
    return 'worker-runtime-error'
  }

  private resolveBundledFfprobePath(): string | null {
    const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const envFfmpeg = String(process.env.FRKB_FFMPEG_PATH || '').trim()
    if (envFfmpeg) {
      const candidate = path.join(path.dirname(envFfmpeg), ffprobeName)
      if (existsSync(candidate)) return candidate
    }
    try {
      const ffmpegPath = resolveBundledFfmpegPath()
      const candidate = path.join(path.dirname(ffmpegPath), ffprobeName)
      if (existsSync(candidate)) return candidate
    } catch {}
    return null
  }

  private async probeAudioFile(filePath: string): Promise<KeyAnalysisAudioProbe> {
    const ffprobePath = this.resolveBundledFfprobePath()
    if (!ffprobePath) {
      return { error: 'ffprobe-not-found' }
    }
    try {
      const { stdout } = await execFileAsync(
        ffprobePath,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_entries',
          'format=duration,bit_rate:stream=codec_name,sample_rate,channels',
          '-select_streams',
          'a:0',
          filePath
        ],
        {
          windowsHide: true,
          timeout: KEY_ANALYSIS_TIMEOUT_PROBE_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024
        }
      )
      const parsed = JSON.parse(String(stdout || '{}')) as {
        format?: { duration?: string; bit_rate?: string }
        streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>
      }
      const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
      const durationSec = Number(parsed.format?.duration)
      const bitRate = Number(parsed.format?.bit_rate)
      const sampleRate = Number(stream?.sample_rate)
      const channels = Number(stream?.channels)
      return {
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
        bitRate: Number.isFinite(bitRate) ? bitRate : undefined,
        sampleRate: Number.isFinite(sampleRate) ? sampleRate : undefined,
        channels: Number.isFinite(channels) ? channels : undefined,
        codec: stream?.codec_name
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private scheduleFailureProbe(job: KeyAnalysisJob, reason: KeyAnalysisFailureReason) {
    const normalizedPath = job.normalizedPath
    if (!normalizedPath || this.failureProbeInFlight.has(normalizedPath)) return
    this.failureProbeInFlight.add(normalizedPath)
    void (async () => {
      try {
        const probe = await this.probeAudioFile(job.filePath)
        const { size, mtimeMs } = this.getJobFileVersion(job)
        this.probeCache.set(normalizedPath, { size, mtimeMs, probe, probedAt: Date.now() })
        job.probe = probe
        const current = this.failedByPath.get(normalizedPath)
        if (current) {
          current.lastProbe = probe
        }
        log.error('[闲时分析] 失败文件诊断', {
          filePath: job.filePath,
          fileName: path.basename(job.filePath),
          source: job.source,
          reason,
          stage: job.trace?.lastStage || 'unknown',
          decodeBackend: job.trace?.decodeBackend || 'unknown',
          inferredCause: current?.inferredCause || this.inferFailureCause(job, reason),
          failCount: current?.failCount,
          decodeMs: job.trace?.decodeMs,
          analyzeMs: job.trace?.analyzeMs,
          waveformMs: job.trace?.waveformMs,
          partialKeyPersisted: job.trace?.partialKeyPersisted === true,
          partialBpmPersisted: job.trace?.partialBpmPersisted === true,
          ...probe
        })
      } catch (error) {
        log.error('[闲时分析] 失败文件诊断异常', {
          filePath: job.filePath,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        this.failureProbeInFlight.delete(normalizedPath)
      }
    })()
  }

  private recordJobFailure(job: KeyAnalysisJob, reason: KeyAnalysisFailureReason, detail?: string) {
    const normalizedPath = job.normalizedPath
    const now = Date.now()
    const { size, mtimeMs } = this.getJobFileVersion(job)
    const existing = this.failedByPath.get(normalizedPath)
    const sameFileVersion = existing && this.isSameFileVersion(existing, { size, mtimeMs })
    const failCount = sameFileVersion ? existing.failCount + 1 : 1
    const cooldownMs = this.computeFailureCooldownMs(failCount)
    const nextRetryAt = now + cooldownMs
    const inferredCause = this.inferFailureCause(job, reason)
    const record: KeyAnalysisFailureRecord = {
      size,
      mtimeMs,
      failCount,
      firstFailedAt: sameFileVersion ? existing.firstFailedAt : now,
      lastFailedAt: now,
      nextRetryAt,
      lastReason: reason,
      lastStage: job.trace?.lastStage,
      lastDetail: detail || job.trace?.detail,
      inferredCause,
      lastProbe: existing?.lastProbe
    }
    this.failedByPath.set(normalizedPath, record)

    if (cooldownMs === 0) {
      log.error('[闲时分析] 任务失败（未进入冷却阈值）', {
        filePath: job.filePath,
        fileName: path.basename(job.filePath),
        source: job.source,
        reason,
        inferredCause,
        stage: job.trace?.lastStage || 'unknown',
        decodeBackend: job.trace?.decodeBackend || 'unknown',
        failCount,
        partialKeyPersisted: job.trace?.partialKeyPersisted === true,
        partialBpmPersisted: job.trace?.partialBpmPersisted === true,
        detail: record.lastDetail
      })
    }

    if (cooldownMs > 0) {
      log.error('[闲时分析] 任务失败进入冷却期，后续将暂时跳过', {
        filePath: job.filePath,
        fileName: path.basename(job.filePath),
        source: job.source,
        reason,
        inferredCause,
        stage: job.trace?.lastStage || 'unknown',
        decodeBackend: job.trace?.decodeBackend || 'unknown',
        failCount,
        cooldownMs,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
        partialKeyPersisted: job.trace?.partialKeyPersisted === true,
        partialBpmPersisted: job.trace?.partialBpmPersisted === true,
        detail: record.lastDetail
      })
    }
    this.scheduleFailureProbe(job, reason)
  }

  private clearJobFailure(job: KeyAnalysisJob) {
    if (!this.failedByPath.has(job.normalizedPath)) return
    this.failedByPath.delete(job.normalizedPath)
  }

  private getFailureCooldownRecord(job: KeyAnalysisJob): KeyAnalysisFailureRecord | null {
    if (job.priority === 'high') return null
    const record = this.failedByPath.get(job.normalizedPath)
    if (!record) return null
    const sameFileVersion = this.isSameFileVersion(record, this.getJobFileVersion(job))
    if (!sameFileVersion) {
      this.failedByPath.delete(job.normalizedPath)
      return null
    }
    if (record.nextRetryAt <= Date.now()) return null
    return record
  }

  private cleanupStaleProbeCache() {
    if (this.probeCache.size === 0) return
    const now = Date.now()
    for (const [normalizedPath, entry] of this.probeCache.entries()) {
      if (now - entry.probedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS) continue
      this.probeCache.delete(normalizedPath)
    }
  }

  private getProbeForJob(job: KeyAnalysisJob): KeyAnalysisAudioProbe | undefined {
    const normalizedPath = job.normalizedPath
    if (!normalizedPath) return undefined
    const fileVersion = this.getJobFileVersion(job)
    const cache = this.probeCache.get(normalizedPath)
    if (cache && this.isSameFileVersion(cache, fileVersion)) {
      if (Date.now() - cache.probedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS) {
        return cache.probe
      }
      this.probeCache.delete(normalizedPath)
    }

    const failed = this.failedByPath.get(normalizedPath)
    if (
      failed &&
      this.isSameFileVersion(failed, fileVersion) &&
      failed.lastProbe &&
      Date.now() - failed.lastFailedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS
    ) {
      this.probeCache.set(normalizedPath, {
        size: failed.size,
        mtimeMs: failed.mtimeMs,
        probe: failed.lastProbe,
        probedAt: failed.lastFailedAt
      })
      return failed.lastProbe
    }
    return undefined
  }

  private shouldProbeForTimeoutBudget(job: KeyAnalysisJob): boolean {
    if (job.probe) return false
    if (this.getProbeForJob(job)) return false
    const hasFailureRecord = this.failedByPath.has(job.normalizedPath)
    if (hasFailureRecord) return true
    const { size } = this.getJobFileVersion(job)
    return size >= KEY_ANALYSIS_TIMEOUT_PROBE_MIN_FILE_SIZE_BYTES
  }

  private async ensureJobProbe(job: KeyAnalysisJob) {
    const reusedProbe = this.getProbeForJob(job)
    if (reusedProbe) {
      job.probe = reusedProbe
      return
    }
    if (!this.shouldProbeForTimeoutBudget(job)) return
    const probe = await this.probeAudioFile(job.filePath)
    job.probe = probe
    const { size, mtimeMs } = this.getJobFileVersion(job)
    this.probeCache.set(job.normalizedPath, {
      size,
      mtimeMs,
      probe,
      probedAt: Date.now()
    })
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
      this.recordJobFailure(activeJob, 'timeout')
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

  private drain() {
    this.cleanupStaleFailures()
    this.cleanupStaleProbeCache()
    this.cleanupStaleJobTimeouts()
    while (this.idle.length > 0) {
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
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.idle.push(worker)
          this.drain()
          return
        }
        const coolingRecord = this.getFailureCooldownRecord(job)
        if (coolingRecord) {
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
        try {
          await this.ensureJobProbe(job)
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
          beatGridAnalyzerProvider: resolveCurrentBeatGridAnalyzerProvider()
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
