import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'

type KeyAnalysisPriority = 'high' | 'medium' | 'low'

type KeyAnalysisJob = {
  jobId: number
  filePath: string
  normalizedPath: string
  priority: KeyAnalysisPriority
  fastAnalysis: boolean
}

type KeyAnalysisResult = {
  filePath: string
  keyText: string
}

type DoneEntry = {
  size: number
  mtimeMs: number
  keyText?: string
}

type WorkerPayload = {
  jobId: number
  filePath: string
  result?: { keyText: string; error?: string }
  error?: string
}

const normalizePath = (value: string): string => {
  let normalized = path.normalize(value || '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

class KeyAnalysisQueue {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private pendingHigh: KeyAnalysisJob[] = []
  private pendingMedium: KeyAnalysisJob[] = []
  private pendingLow: KeyAnalysisJob[] = []
  private pendingByPath = new Map<string, KeyAnalysisJob>()
  private activeByPath = new Map<string, KeyAnalysisJob>()
  private busy = new Map<Worker, number>()
  private inFlight = new Map<number, KeyAnalysisJob>()
  private doneByPath = new Map<string, DoneEntry>()
  private nextJobId = 0
  private events: EventEmitter

  constructor(workerCount: number, events: EventEmitter) {
    const count = Math.max(1, workerCount)
    this.events = events
    for (let i = 0; i < count; i += 1) {
      this.workers.push(this.createWorker())
    }
  }

  enqueue(filePath: string, priority: KeyAnalysisPriority, options: { urgent?: boolean } = {}) {
    if (!filePath) return
    const normalizedPath = normalizePath(filePath)
    if (this.activeByPath.has(normalizedPath)) return
    const existing = this.pendingByPath.get(normalizedPath)
    if (existing) {
      if (this.isHigherPriority(priority, existing.priority)) {
        this.removePending(existing)
        existing.priority = priority
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
      fastAnalysis: true
    }
    this.addPending(job, options.urgent)
    this.drain()
  }

  enqueueList(
    filePaths: string[],
    priority: KeyAnalysisPriority,
    options: { urgent?: boolean } = {}
  ) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return
    for (const filePath of filePaths) {
      this.enqueue(filePath, priority, options)
    }
  }

  private isHigherPriority(next: KeyAnalysisPriority, current: KeyAnalysisPriority): boolean {
    const rank = { high: 3, medium: 2, low: 1 }
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
    } else {
      this.pendingLow.push(job)
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
    this.pendingByPath.delete(job.normalizedPath)
  }

  private popNextJob(): KeyAnalysisJob | null {
    const job = this.pendingHigh.shift() || this.pendingMedium.shift() || this.pendingLow.shift()
    if (!job) return null
    this.pendingByPath.delete(job.normalizedPath)
    return job
  }

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workers', 'keyAnalysisWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: WorkerPayload) => {
      this.handleWorkerMessage(worker, payload)
    })

    worker.on('error', (error) => {
      this.handleWorkerFailure(worker, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerFailure(worker, new Error(`worker exited: ${code}`))
      }
    })

    this.idle.push(worker)
    return worker
  }

  private handleWorkerFailure(worker: Worker, _error: Error) {
    const jobId = this.busy.get(worker)
    if (jobId) {
      const job = this.inFlight.get(jobId)
      if (job) {
        this.activeByPath.delete(job.normalizedPath)
        this.inFlight.delete(jobId)
      }
      this.busy.delete(worker)
    }

    this.workers = this.workers.filter((item) => item !== worker)
    this.idle = this.idle.filter((item) => item !== worker)

    const replacement = this.createWorker()
    this.workers.push(replacement)
    this.drain()
  }

  private async handleWorkerMessage(worker: Worker, payload: WorkerPayload) {
    const jobId = payload?.jobId
    const job = this.inFlight.get(jobId)

    this.inFlight.delete(jobId)
    this.busy.delete(worker)
    this.idle.push(worker)
    if (job) {
      this.activeByPath.delete(job.normalizedPath)
    }

    if (job && payload?.result && !payload.result.error) {
      const keyText = payload.result.keyText
      if (typeof keyText === 'string' && keyText.trim() !== '') {
        await this.persistKey(job.filePath, keyText)
      }
    }

    this.drain()
  }

  private async persistKey(filePath: string, keyText: string) {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      this.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await LibraryCacheDb.updateSongCacheKey(listRoot, filePath, keyText)
      }

      const payload: KeyAnalysisResult = { filePath, keyText }
      this.events.emit('key-updated', payload)
    } catch {
      this.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText
      })
      const payload: KeyAnalysisResult = { filePath, keyText }
      this.events.emit('key-updated', payload)
    }
  }

  private async prepareJob(job: KeyAnalysisJob): Promise<boolean> {
    const filePath = job.filePath
    let stat: { size: number; mtimeMs: number }
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      await this.handleMissingFile(job.filePath)
      return false
    }

    const done = this.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      return false
    }

    const listRoot = await findSongListRoot(path.dirname(filePath))
    if (listRoot) {
      const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
      if (cached && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1) {
        const cachedKey = (cached.info as any)?.key
        if (typeof cachedKey === 'string' && cachedKey.trim() !== '') {
          this.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: cachedKey
          })
          return false
        }
      }
    }

    return true
  }

  private async handleMissingFile(filePath: string) {
    try {
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
      }
    } catch {}
  }

  private drain() {
    while (this.idle.length > 0) {
      const job = this.popNextJob()
      if (!job) return
      const worker = this.idle.shift()
      if (!worker) return
      this.busy.set(worker, job.jobId)
      this.inFlight.set(job.jobId, job)
      this.activeByPath.set(job.normalizedPath, job)

      void (async () => {
        const ready = await this.prepareJob(job)
        if (!ready) {
          this.inFlight.delete(job.jobId)
          this.busy.delete(worker)
          this.activeByPath.delete(job.normalizedPath)
          this.idle.push(worker)
          this.drain()
          return
        }
        worker.postMessage({
          jobId: job.jobId,
          filePath: job.filePath,
          fastAnalysis: job.fastAnalysis
        })
      })()
    }
  }
}

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
