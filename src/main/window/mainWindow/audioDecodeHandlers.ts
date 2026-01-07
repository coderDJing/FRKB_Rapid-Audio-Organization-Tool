import { app, ipcMain, type BrowserWindow } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { enqueueKeyAnalysis, enqueueKeyAnalysisImmediate } from '../../services/keyAnalysisQueue'

const clonePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) {
    return new Float32Array(0)
  }
  if (pcmData instanceof Float32Array) {
    return new Float32Array(pcmData)
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(pcmData)) {
    const buffer = pcmData as Buffer
    const view = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4)
    )
    return new Float32Array(view)
  }
  if (pcmData instanceof Uint8Array) {
    const view = new Float32Array(
      pcmData.buffer,
      pcmData.byteOffset,
      Math.floor(pcmData.byteLength / 4)
    )
    return new Float32Array(view)
  }
  return new Float32Array(0)
}

type DecodeWorkerResult = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: any
  keyText?: string
  keyError?: string
}

type WorkerJob = {
  jobId: number
  filePath: string
  analyzeKey: boolean
  resolve: (result: DecodeWorkerResult) => void
  reject: (error: Error) => void
}

class AudioDecodeWorkerPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: WorkerJob[] = []
  private pending = new Map<number, WorkerJob>()
  private busy = new Map<Worker, number>()
  private nextJobId = 0
  private cacheRoot: string

  constructor(workerCount: number, cacheRoot: string) {
    this.cacheRoot = cacheRoot
    const count = Math.max(1, workerCount)
    for (let i = 0; i < count; i++) {
      this.workers.push(this.createWorker())
    }
  }

  decode(filePath: string, options: { analyzeKey?: boolean } = {}): Promise<DecodeWorkerResult> {
    return new Promise((resolve, reject) => {
      const jobId = ++this.nextJobId
      const job: WorkerJob = {
        jobId,
        filePath,
        analyzeKey: Boolean(options.analyzeKey),
        resolve,
        reject
      }
      this.pending.set(jobId, job)
      this.queue.push(job)
      this.drain()
    })
  }

  private createWorker(): Worker {
    const workerPath = path.join(__dirname, 'workers', 'audioDecodeWorker.js')
    const worker = new Worker(workerPath, {
      workerData: { cacheRoot: this.cacheRoot }
    })

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

      job.resolve(payload.result as DecodeWorkerResult)
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
        analyzeKey: job.analyzeKey
      })
    }
  }
}

let decodePool: AudioDecodeWorkerPool | null = null

const getDecodePool = () => {
  if (decodePool) return decodePool
  const workerCount = Math.max(1, Math.min(2, os.cpus().length))
  const cacheRoot = app.getPath('userData')
  decodePool = new AudioDecodeWorkerPool(workerCount, cacheRoot)
  return decodePool
}

export function registerAudioDecodeHandlers(getWindow: () => BrowserWindow | null) {
  const handleDecode =
    (eventName: 'readSongFile' | 'readNextSongFile', successEvent: string, errorEvent: string) =>
    async (_e: Electron.IpcMainEvent, filePath: string, requestId: string) => {
      try {
        const pool = getDecodePool()
        if (eventName === 'readSongFile') {
          enqueueKeyAnalysisImmediate(filePath)
        } else {
          enqueueKeyAnalysis(filePath, 'high')
        }
        const result = await pool.decode(filePath, { analyzeKey: false })
        const payload = {
          pcmData: clonePcmData(result.pcmData),
          sampleRate: result.sampleRate,
          channels: result.channels,
          totalFrames: result.totalFrames,
          mixxxWaveformData: result.mixxxWaveformData ?? null
        }
        getWindow()?.webContents.send(successEvent, payload, filePath, requestId)
      } catch (error) {
        console.error(`解码歌曲文件失败(${eventName}) ${filePath}:`, error)
        getWindow()?.webContents.send(errorEvent, filePath, (error as Error).message, requestId)
      }
    }

  ipcMain.on('readSongFile', handleDecode('readSongFile', 'readedSongFile', 'readSongFileError'))
  ipcMain.on(
    'readNextSongFile',
    handleDecode('readNextSongFile', 'readedNextSongFile', 'readNextSongFileError')
  )
}
