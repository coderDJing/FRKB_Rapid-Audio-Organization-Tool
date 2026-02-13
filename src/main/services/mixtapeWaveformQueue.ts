import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixxxWaveformData } from '../waveformCache'

type WorkerJob = {
  jobId: number
  filePath: string
  targetRate: number
  resolve: (result: MixxxWaveformData | null) => void
  reject: (error: Error) => void
}

type WorkerResult = {
  mixxxWaveformData?: MixxxWaveformData | null
}

const MIXTAPE_WAVEFORM_TARGET_RATE = 441
let workerPool: MixtapeWaveformWorkerPool | null = null
const inflight = new Set<string>()

class MixtapeWaveformWorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: WorkerJob[] = []
  private pending = new Map<number, WorkerJob>()
  private busy = new Map<Worker, number>()
  private nextJobId = 0

  constructor(workerCount: number) {
    const count = Math.max(1, workerCount)
    for (let i = 0; i < count; i++) {
      this.workers.push(this.createWorker())
    }
  }

  request(filePath: string, targetRate: number): Promise<MixxxWaveformData | null> {
    return new Promise((resolve, reject) => {
      const jobId = ++this.nextJobId
      const job: WorkerJob = { jobId, filePath, targetRate, resolve, reject }
      this.pending.set(jobId, job)
      this.queue.push(job)
      this.drain()
    })
  }

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workers', 'mixtapeWaveformWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: any) => {
      const jobId = payload?.jobId
      const job = this.pending.get(jobId)
      if (!job) {
        this.busy.delete(worker)
        this.idle.push(worker)
        this.drain()
        return
      }

      this.pending.delete(jobId)
      this.busy.delete(worker)
      this.idle.push(worker)
      this.drain()

      if (payload?.error) {
        job.reject(new Error(payload.error))
        return
      }
      const result = payload?.result as WorkerResult | undefined
      job.resolve(result?.mixxxWaveformData ?? null)
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

  private handleWorkerFailure(worker: Worker, error: Error) {
    const jobId = this.busy.get(worker)
    if (jobId) {
      const job = this.pending.get(jobId)
      if (job) {
        this.pending.delete(jobId)
        job.reject(error)
      }
      this.busy.delete(worker)
    }

    this.workers = this.workers.filter((item) => item !== worker)
    this.idle = this.idle.filter((item) => item !== worker)

    const replacement = this.createWorker()
    this.workers.push(replacement)
    this.drain()
  }

  private drain() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.shift()
      const job = this.queue.shift()
      if (!worker || !job) return
      this.busy.set(worker, job.jobId)
      worker.postMessage({
        jobId: job.jobId,
        filePath: job.filePath,
        targetRate: job.targetRate
      })
    }
  }
}

const getWorkerPool = () => {
  if (workerPool) return workerPool
  const workerCount = Math.max(1, Math.min(2, os.cpus().length))
  workerPool = new MixtapeWaveformWorkerPool(workerCount)
  return workerPool
}

const notifyMixtapeWaveformUpdated = (filePath: string) => {
  try {
    mixtapeWindow.broadcast?.('mixtape-waveform-updated', { filePath })
  } catch {}
}

const computeMixtapeWaveform = async (filePath: string, listRoot?: string) => {
  if (!filePath) return
  const normalized = filePath.trim()
  if (!normalized) return
  if (inflight.has(normalized)) return
  inflight.add(normalized)
  try {
    let resolvedRoot = listRoot?.trim() || ''
    if (!resolvedRoot) {
      resolvedRoot = (await findSongListRoot(path.dirname(normalized))) || ''
    }
    if (!resolvedRoot) return
    const stat = await fs.stat(normalized).catch(() => null)
    if (!stat) {
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const waveform = await getWorkerPool().request(normalized, MIXTAPE_WAVEFORM_TARGET_RATE)
    if (!waveform) return
    await LibraryCacheDb.upsertMixtapeWaveformCacheEntry(
      resolvedRoot,
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      waveform
    )
    notifyMixtapeWaveformUpdated(normalized)
  } catch (error) {
    log.error('[mixtape] waveform build failed', { filePath: normalized, error })
  } finally {
    inflight.delete(normalized)
  }
}

export function queueMixtapeWaveforms(filePaths: string[], listRoot?: string) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  for (const filePath of filePaths) {
    void computeMixtapeWaveform(filePath, listRoot)
  }
}
