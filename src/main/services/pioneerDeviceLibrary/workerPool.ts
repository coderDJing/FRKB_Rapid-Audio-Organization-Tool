import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../../log'
import { resolveMainWorkerPath } from '../../workerPath'

type ReadPlaylistTreeJob = {
  jobId: number
  type: 'read-playlist-tree'
  exportPdbPath: string
}

type ReadPlaylistTracksJob = {
  jobId: number
  type: 'read-playlist-tracks'
  exportPdbPath: string
  playlistId: number
}

type ReadPreviewWaveformsJob = {
  jobId: number
  type: 'read-preview-waveforms'
  analyzeFilePaths: string[]
}

type ReadCueJob = {
  jobId: number
  type: 'read-cues'
  analyzeFilePaths: string[]
}

type PioneerWorkerJob =
  | ReadPlaylistTreeJob
  | ReadPlaylistTracksJob
  | ReadPreviewWaveformsJob
  | ReadCueJob

type PioneerWorkerResponse = {
  jobId: number
  type: PioneerWorkerJob['type']
  progress?: unknown
  result?: unknown
  error?: string
}

class PioneerDeviceWorkerPool {
  private worker: Worker | null = null
  private nextJobId = 0
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      type: PioneerWorkerJob['type']
      onProgress?: (progress: unknown) => void
    }
  >()

  private ensureWorker() {
    if (this.worker) return this.worker
    const workerPath = resolveMainWorkerPath(__dirname, 'pioneerDeviceLibraryWorker.js')
    const worker = new Worker(workerPath)

    worker.on('message', (payload: PioneerWorkerResponse) => {
      const job = this.pending.get(payload.jobId)
      if (!job) return
      if (typeof payload.progress !== 'undefined') {
        job.onProgress?.(payload.progress)
        return
      }
      this.pending.delete(payload.jobId)
      if (payload.error) {
        job.reject(new Error(payload.error))
        return
      }
      job.resolve(payload.result)
    })

    worker.on('error', (error) => {
      log.error('[pioneer-device-library] worker error', error)
      this.failAllPending(error)
      this.worker = null
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`pioneer device worker exited with code ${code}`)
        log.error('[pioneer-device-library] worker exit', error)
        this.failAllPending(error)
      }
      this.worker = null
    })

    this.worker = worker
    return worker
  }

  private failAllPending(error: Error) {
    for (const [, job] of this.pending) {
      job.reject(error)
    }
    this.pending.clear()
  }

  private runJob<T>(
    type: PioneerWorkerJob['type'],
    payload: Omit<PioneerWorkerJob, 'jobId' | 'type'>,
    options?: { onProgress?: (progress: unknown) => void }
  ): Promise<T> {
    const worker = this.ensureWorker()
    const jobId = ++this.nextJobId
    const message = {
      jobId,
      type,
      ...payload
    } as PioneerWorkerJob

    return new Promise<T>((resolve, reject) => {
      this.pending.set(jobId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        type,
        onProgress: options?.onProgress
      })
      worker.postMessage(message)
    })
  }

  readPlaylistTree<T>(exportPdbPath: string) {
    return this.runJob<T>('read-playlist-tree', { exportPdbPath })
  }

  readPlaylistTracks<T>(exportPdbPath: string, playlistId: number) {
    return this.runJob<T>('read-playlist-tracks', { exportPdbPath, playlistId })
  }

  readPreviewWaveforms<T>(analyzeFilePaths: string[], onProgress?: (progress: unknown) => void) {
    return this.runJob<T>('read-preview-waveforms', { analyzeFilePaths }, { onProgress })
  }

  readCues<T>(analyzeFilePaths: string[], onProgress?: (progress: unknown) => void) {
    return this.runJob<T>('read-cues', { analyzeFilePaths }, { onProgress })
  }
}

let pioneerDeviceWorkerPool: PioneerDeviceWorkerPool | null = null

const getPioneerDeviceWorkerPool = () => {
  if (pioneerDeviceWorkerPool) return pioneerDeviceWorkerPool
  pioneerDeviceWorkerPool = new PioneerDeviceWorkerPool()
  return pioneerDeviceWorkerPool
}

export const readPioneerPlaylistTreeInWorker = <T>(exportPdbPath: string) =>
  getPioneerDeviceWorkerPool().readPlaylistTree<T>(exportPdbPath)

export const readPioneerPlaylistTracksInWorker = <T>(exportPdbPath: string, playlistId: number) =>
  getPioneerDeviceWorkerPool().readPlaylistTracks<T>(exportPdbPath, playlistId)

export const readPioneerPreviewWaveformsInWorker = <T>(
  analyzeFilePaths: string[],
  onProgress?: (progress: unknown) => void
) => getPioneerDeviceWorkerPool().readPreviewWaveforms<T>(analyzeFilePaths, onProgress)

export const readPioneerCuesInWorker = <T>(
  analyzeFilePaths: string[],
  onProgress?: (progress: unknown) => void
) => getPioneerDeviceWorkerPool().readCues<T>(analyzeFilePaths, onProgress)
