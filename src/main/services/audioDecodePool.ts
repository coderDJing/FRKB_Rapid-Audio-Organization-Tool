import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import type { MixxxWaveformData } from '../waveformCache'
import { isMissingFileDecodeError } from './decodeErrorUtils'

export type SharedRawWaveformData = {
  duration: number
  sampleRate: number
  rate: number
  frames: number
  minLeft: Buffer
  maxLeft: Buffer
  minRight: Buffer
  maxRight: Buffer
}

export type DecodeAudioMetrics = {
  decodeMs: number
  waveformMs: number
  rawMs: number
  keyMs: number
  totalMs: number
  cacheHit?: boolean
  chain?: 'cache' | 'inflight' | 'worker'
  waitMs?: number
  cacheStore?: 'stored' | 'skipped-no-key' | 'skipped-empty-pcm' | 'skipped-invalid-pcm'
}

export type DecodeAudioResult = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  mixxxWaveformData?: MixxxWaveformData | null
  rawWaveformData?: SharedRawWaveformData | null
  keyText?: string
  keyError?: string
  metrics?: DecodeAudioMetrics
}

export type DecodeAudioOptions = {
  analyzeKey?: boolean
  needWaveform?: boolean
  waveformTargetRate?: number
  needRawWaveform?: boolean
  rawTargetRate?: number
  fileStat?: { size: number; mtimeMs: number } | null
  traceLabel?: string
}

type WorkerJob = {
  jobId: number
  filePath: string
  analyzeKey: boolean
  needWaveform: boolean
  waveformTargetRate?: number
  needRawWaveform: boolean
  rawTargetRate?: number
  resolve: (result: DecodeAudioResult) => void
  reject: (error: Error) => void
}

type CoreDecodedData = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
}

type CoreCacheEntry = CoreDecodedData & {
  key: string
  bytes: number
  createdAt: number
  accessedAt: number
}

type CoreKeyResolution = {
  key: string
  source: 'provided-stat' | 'fs-stat' | 'path-only'
}

const CORE_CACHE_TTL_MS = 90_000
const CORE_CACHE_MAX_BYTES = 256 * 1024 * 1024
const CORE_CACHE_MAX_ENTRIES = 4

const coreCache = new Map<string, CoreCacheEntry>()
let coreCacheBytes = 0
const coreInflight = new Map<string, Promise<DecodeAudioResult>>()

const nowMs = () => Date.now()

const normalizeDecodeMetrics = (
  value: Partial<DecodeAudioMetrics> | null | undefined
): DecodeAudioMetrics => ({
  decodeMs: Number(value?.decodeMs) || 0,
  waveformMs: Number(value?.waveformMs) || 0,
  rawMs: Number(value?.rawMs) || 0,
  keyMs: Number(value?.keyMs) || 0,
  totalMs: Number(value?.totalMs) || 0,
  cacheHit: value?.cacheHit === true,
  chain: value?.chain,
  waitMs: Number.isFinite(value?.waitMs as number) ? Number(value?.waitMs) : undefined,
  cacheStore: value?.cacheStore
})

const projectCoreOnlyResult = (
  core: CoreDecodedData,
  metrics?: Partial<DecodeAudioMetrics>
): DecodeAudioResult => ({
  pcmData: core.pcmData,
  sampleRate: core.sampleRate,
  channels: core.channels,
  totalFrames: core.totalFrames,
  mixxxWaveformData: null,
  rawWaveformData: null,
  metrics: normalizeDecodeMetrics(metrics)
})

const clearCoreCacheEntry = (key: string) => {
  const entry = coreCache.get(key)
  if (!entry) return
  coreCache.delete(key)
  coreCacheBytes = Math.max(0, coreCacheBytes - entry.bytes)
}

const pruneCoreCache = () => {
  const now = nowMs()
  for (const [key, entry] of coreCache.entries()) {
    if (now - entry.createdAt > CORE_CACHE_TTL_MS) {
      clearCoreCacheEntry(key)
    }
  }
  if (coreCache.size <= CORE_CACHE_MAX_ENTRIES && coreCacheBytes <= CORE_CACHE_MAX_BYTES) return

  const sorted = Array.from(coreCache.entries()).sort((a, b) => a[1].accessedAt - b[1].accessedAt)
  for (const [key] of sorted) {
    if (coreCache.size <= CORE_CACHE_MAX_ENTRIES && coreCacheBytes <= CORE_CACHE_MAX_BYTES) break
    clearCoreCacheEntry(key)
  }
}

const getCoreCache = (key: string): CoreDecodedData | null => {
  pruneCoreCache()
  const entry = coreCache.get(key)
  if (!entry) return null
  entry.accessedAt = nowMs()
  return {
    pcmData: entry.pcmData,
    sampleRate: entry.sampleRate,
    channels: entry.channels,
    totalFrames: entry.totalFrames
  }
}

const toPcmBuffer = (value: unknown): Buffer | null => {
  if (!value) return null
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }
  return null
}

const setCoreCache = (
  key: string,
  result: DecodeAudioResult
): 'stored' | 'skipped-no-key' | 'skipped-empty-pcm' | 'skipped-invalid-pcm' => {
  if (!key) return 'skipped-no-key'
  const pcm = toPcmBuffer(result?.pcmData)
  if (!pcm) return 'skipped-invalid-pcm'
  if (pcm.byteLength <= 0) return 'skipped-empty-pcm'
  const entry: CoreCacheEntry = {
    key,
    pcmData: pcm,
    sampleRate: Number(result.sampleRate) || 0,
    channels: Number(result.channels) || 0,
    totalFrames: Number(result.totalFrames) || 0,
    bytes: pcm.byteLength,
    createdAt: nowMs(),
    accessedAt: nowMs()
  }
  clearCoreCacheEntry(key)
  coreCache.set(key, entry)
  coreCacheBytes += entry.bytes
  pruneCoreCache()
  return 'stored'
}

const resolveCoreKey = async (
  filePath: string,
  fileStat?: { size: number; mtimeMs: number } | null
): Promise<CoreKeyResolution> => {
  const normalized = String(filePath || '')
    .trim()
    .toLowerCase()
  if (!normalized) return { key: '', source: 'path-only' }

  const size = Number(fileStat?.size)
  const mtimeMs = Number(fileStat?.mtimeMs)
  if (Number.isFinite(size) && Number.isFinite(mtimeMs)) {
    return {
      key: `${normalized}|${size}|${Math.round(mtimeMs)}`,
      source: 'provided-stat'
    }
  }

  try {
    const stat = await fs.stat(filePath)
    return {
      key: `${normalized}|${stat.size}|${Math.round(stat.mtimeMs)}`,
      source: 'fs-stat'
    }
  } catch {
    return {
      key: normalized,
      source: 'path-only'
    }
  }
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

  decode(filePath: string, options: DecodeAudioOptions = {}): Promise<DecodeAudioResult> {
    return new Promise((resolve, reject) => {
      const jobId = ++this.nextJobId
      const job: WorkerJob = {
        jobId,
        filePath,
        analyzeKey: Boolean(options.analyzeKey),
        needWaveform: Boolean(options.needWaveform),
        waveformTargetRate: options.waveformTargetRate,
        needRawWaveform: Boolean(options.needRawWaveform),
        rawTargetRate: options.rawTargetRate,
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
      job.resolve(payload.result as DecodeAudioResult)
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
        needWaveform: job.needWaveform,
        waveformTargetRate: job.waveformTargetRate,
        needRawWaveform: job.needRawWaveform,
        rawTargetRate: job.rawTargetRate
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

const isCoreOnlyRequest = (options: DecodeAudioOptions) =>
  !options.analyzeKey && !options.needWaveform && !options.needRawWaveform

export async function decodeAudioShared(
  filePath: string,
  options: DecodeAudioOptions = {}
): Promise<DecodeAudioResult> {
  const normalized = String(filePath || '').trim()
  if (!normalized) {
    throw new Error('Missing file path')
  }
  const traceLabel = String(options.traceLabel || 'default')
  const coreKeyResolution = await resolveCoreKey(normalized, options.fileStat)
  const coreKey = coreKeyResolution.key
  const coreOnly = isCoreOnlyRequest(options)

  if (coreOnly && coreKey) {
    const cached = getCoreCache(coreKey)
    if (cached) {
      return projectCoreOnlyResult(cached, {
        cacheHit: true,
        chain: 'cache'
      })
    }
    const inflight = coreInflight.get(coreKey)
    if (inflight) {
      const waitStartedAt = nowMs()
      const shared = await inflight
      const waitMs = nowMs() - waitStartedAt
      const sourceMetrics = normalizeDecodeMetrics(shared.metrics)
      return projectCoreOnlyResult(shared, {
        decodeMs: sourceMetrics.decodeMs,
        waveformMs: sourceMetrics.waveformMs,
        rawMs: sourceMetrics.rawMs,
        keyMs: sourceMetrics.keyMs,
        totalMs: sourceMetrics.totalMs,
        cacheHit: false,
        chain: 'inflight',
        waitMs
      })
    }
  }

  const workerTask = getDecodePool().decode(normalized, options)
  if (coreKey) {
    coreInflight.set(coreKey, workerTask)
  }

  try {
    const result = await workerTask
    const cacheStore = coreKey ? setCoreCache(coreKey, result) : 'skipped-no-key'
    const metrics = normalizeDecodeMetrics(result.metrics)
    const chainedMetrics: DecodeAudioMetrics = {
      ...metrics,
      cacheHit: false,
      chain: 'worker',
      cacheStore
    }
    return coreOnly
      ? projectCoreOnlyResult(result, chainedMetrics)
      : {
          ...result,
          metrics: chainedMetrics
        }
  } catch (error) {
    const isExpectedMixtapeMissingFile =
      traceLabel.startsWith('mixtape-') && isMissingFileDecodeError(error)
    if (!isExpectedMixtapeMissingFile) {
      log.error('[decode-pool] decode failed', {
        label: traceLabel,
        filePath: normalized,
        options: {
          analyzeKey: Boolean(options.analyzeKey),
          needWaveform: Boolean(options.needWaveform),
          waveformTargetRate: options.waveformTargetRate,
          needRawWaveform: Boolean(options.needRawWaveform),
          rawTargetRate: options.rawTargetRate
        },
        error
      })
    }
    throw error
  } finally {
    if (coreKey && coreInflight.get(coreKey) === workerTask) {
      coreInflight.delete(coreKey)
    }
  }
}
