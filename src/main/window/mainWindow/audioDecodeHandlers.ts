import { ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../../log'
import { findSongListRoot } from '../../services/cacheMaintenance'
import { enqueueKeyAnalysis, enqueueKeyAnalysisImmediate } from '../../services/keyAnalysisQueue'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../../services/songInfoLite'
import type { MixxxWaveformData } from '../../waveformCache'

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
  mixxxWaveformData?: MixxxWaveformData | null
  keyText?: string
  keyError?: string
}

type WorkerJob = {
  jobId: number
  filePath: string
  analyzeKey: boolean
  needWaveform: boolean
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

  constructor(workerCount: number) {
    const count = Math.max(1, workerCount)
    for (let i = 0; i < count; i++) {
      this.workers.push(this.createWorker())
    }
  }

  decode(
    filePath: string,
    options: { analyzeKey?: boolean; needWaveform?: boolean } = {}
  ): Promise<DecodeWorkerResult> {
    return new Promise((resolve, reject) => {
      const jobId = ++this.nextJobId
      const job: WorkerJob = {
        jobId,
        filePath,
        analyzeKey: Boolean(options.analyzeKey),
        needWaveform: Boolean(options.needWaveform),
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
        analyzeKey: job.analyzeKey,
        needWaveform: job.needWaveform
      })
    }
  }
}

let decodePool: AudioDecodeWorkerPool | null = null

const getDecodePool = () => {
  if (decodePool) return decodePool
  const workerCount = Math.max(1, Math.min(2, os.cpus().length))
  decodePool = new AudioDecodeWorkerPool(workerCount)
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
        let stat: { size: number; mtimeMs: number } | null = null
        try {
          const fsStat = await fs.stat(filePath)
          stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
        } catch {}

        const listRoot = await findSongListRoot(path.dirname(filePath))
        let cachedWaveform: MixxxWaveformData | null = null
        if (stat && listRoot) {
          const cached = await LibraryCacheDb.loadWaveformCacheData(listRoot, filePath, stat)
          if (cached) {
            cachedWaveform = cached
          }
        }

        const result = await pool.decode(filePath, {
          analyzeKey: false,
          needWaveform: !cachedWaveform
        })
        const mixxxWaveformData = cachedWaveform ?? result.mixxxWaveformData ?? null
        if (!cachedWaveform && mixxxWaveformData && listRoot && stat) {
          const cachedEntry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
          if (!cachedEntry) {
            const info = applyLiteDefaults(buildLiteSongInfo(filePath), filePath)
            await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              info
            })
          }
          await LibraryCacheDb.upsertWaveformCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            mixxxWaveformData
          )
        }
        const payload = {
          pcmData: clonePcmData(result.pcmData),
          sampleRate: result.sampleRate,
          channels: result.channels,
          totalFrames: result.totalFrames,
          mixxxWaveformData
        }
        getWindow()?.webContents.send(successEvent, payload, filePath, requestId)
      } catch (error) {
        const errorMsg = `解码歌曲文件失败(${eventName}) ${filePath}`
        log.error(errorMsg, error)
        console.error(`${errorMsg}:`, error)
        getWindow()?.webContents.send(errorEvent, filePath, (error as Error).message, requestId)
      }
    }

  const handlePreviewDecode = async (
    _e: Electron.IpcMainEvent,
    filePath: string,
    requestId: string
  ) => {
    try {
      const pool = getDecodePool()
      const result = await pool.decode(filePath, {
        analyzeKey: false,
        needWaveform: false
      })
      const payload = {
        pcmData: clonePcmData(result.pcmData),
        sampleRate: result.sampleRate,
        channels: result.channels,
        totalFrames: result.totalFrames
      }
      getWindow()?.webContents.send('readedPreviewSongFile', payload, filePath, requestId)
    } catch (error) {
      const errorMsg = `解码预览文件失败 ${filePath}`
      log.error(errorMsg, error)
      console.error(`${errorMsg}:`, error)
      getWindow()?.webContents.send(
        'readPreviewSongFileError',
        filePath,
        (error as Error).message,
        requestId
      )
    }
  }

  ipcMain.on('readSongFile', handleDecode('readSongFile', 'readedSongFile', 'readSongFileError'))
  ipcMain.on(
    'readNextSongFile',
    handleDecode('readNextSongFile', 'readedNextSongFile', 'readNextSongFileError')
  )
  ipcMain.on('readPreviewSongFile', handlePreviewDecode)
}
