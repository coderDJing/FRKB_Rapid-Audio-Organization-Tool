import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'

type RawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
}

type WorkerJob = {
  jobId: number
  filePath: string
  targetRate: number
  resolve: (result: RawWaveformData | null) => void
  reject: (error: Error) => void
}

type WorkerResult = {
  rawWaveformData?: RawWaveformData | null
}

const RAW_WAVEFORM_TARGET_RATE = 2400
let workerPool: MixtapeRawWaveformWorkerPool | null = null
const inflight = new Set<string>()

class MixtapeRawWaveformWorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: WorkerJob[] = []
  private pending = new Map<number, WorkerJob>()
  private busy = new Map<Worker, number>()
  private nextJobId = 0

  constructor(workerCount: number) {
    const count = Math.max(1, workerCount)
    for (let i = 0; i < count; i += 1) {
      this.workers.push(this.createWorker())
    }
  }

  request(filePath: string, targetRate: number): Promise<RawWaveformData | null> {
    return new Promise((resolve, reject) => {
      const jobId = ++this.nextJobId
      const job: WorkerJob = { jobId, filePath, targetRate, resolve, reject }
      this.pending.set(jobId, job)
      this.queue.push(job)
      this.drain()
    })
  }

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workers', 'mixtapeRawWaveformWorker.js')
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
      job.resolve(result?.rawWaveformData ?? null)
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
  workerPool = new MixtapeRawWaveformWorkerPool(workerCount)
  return workerPool
}

export async function requestMixtapeRawWaveform(
  filePath: string,
  targetRate?: number
): Promise<RawWaveformData | null> {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return null
  const rate =
    Number.isFinite(targetRate) && (targetRate as number) > 0
      ? (targetRate as number)
      : RAW_WAVEFORM_TARGET_RATE
  return getWorkerPool().request(normalized, rate)
}

const computeMixtapeRawWaveform = async (
  filePath: string,
  listRoot?: string,
  targetRate?: number
) => {
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
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(resolvedRoot, normalized)
      return
    }
    const cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(resolvedRoot, normalized, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })
    if (cached) return
    const waveform = await requestMixtapeRawWaveform(normalized, targetRate)
    if (!waveform) return
    await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
      resolvedRoot,
      normalized,
      { size: stat.size, mtimeMs: stat.mtimeMs },
      waveform
    )
  } catch (error) {
    log.error('[mixtape] raw waveform build failed', { filePath: normalized, error })
  } finally {
    inflight.delete(normalized)
  }
}

export function queueMixtapeRawWaveforms(
  filePaths: string[],
  listRoot?: string,
  targetRate?: number
) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  for (const filePath of filePaths) {
    void computeMixtapeRawWaveform(filePath, listRoot, targetRate)
  }
}
