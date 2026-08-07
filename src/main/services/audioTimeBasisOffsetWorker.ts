import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { resolveMainWorkerPath } from '../workerPath'
import { log } from '../log'
import { resolveBundledFfprobePath } from './audioTimeBasisOffset'

type WorkerResponse = {
  requestId: number
  offsetMs?: number
  error?: string
}

type PendingRequest = {
  filePath: string
  resolve: (offsetMs: number) => void
  reject: (error: Error) => void
}

const timeBasisOffsetCache = new Map<string, Promise<number>>()
const pendingRequests = new Map<number, PendingRequest>()
let worker: Worker | null = null
let nextRequestId = 0

const normalizeLookupKey = (filePath: string) => {
  const resolved = path.resolve(filePath).trim()
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const normalizeOffset = (value: unknown) => {
  const offsetMs = Number(value)
  return Number.isFinite(offsetMs) && offsetMs >= 0 ? Number(offsetMs.toFixed(3)) : 0
}

const rejectPendingRequests = (error: Error) => {
  for (const pending of pendingRequests.values()) pending.reject(error)
  pendingRequests.clear()
}

const resetWorker = (error?: Error) => {
  const current = worker
  worker = null
  if (current) {
    current.removeAllListeners()
    void current.terminate()
  }
  if (error) {
    log.error('[audio-time-basis] worker failed', { error: error.message })
    rejectPendingRequests(error)
  }
}

const ensureWorker = () => {
  if (worker) return worker
  const workerPath = resolveMainWorkerPath(__dirname, 'audioTimeBasisOffsetWorker.js')
  const nextWorker = new Worker(workerPath)
  nextWorker.unref()
  nextWorker.on('message', (response: WorkerResponse) => {
    const pending = pendingRequests.get(response.requestId)
    if (!pending) return
    pendingRequests.delete(response.requestId)
    if (response.error) {
      log.error('[audio-time-basis] worker probe failed', {
        filePath: pending.filePath,
        error: response.error
      })
      pending.reject(new Error(response.error))
      return
    }
    pending.resolve(normalizeOffset(response.offsetMs))
  })
  nextWorker.on('error', (error) => {
    resetWorker(error instanceof Error ? error : new Error(String(error)))
  })
  nextWorker.on('exit', (code) => {
    if (worker !== nextWorker) return
    resetWorker(new Error(`audio time-basis worker exited: ${String(code ?? '')}`))
  })
  worker = nextWorker
  return nextWorker
}

const resolveInWorker = (filePath: string) => {
  const requestId = ++nextRequestId
  const ffprobePath = resolveBundledFfprobePath()
  const currentWorker = ensureWorker()
  return new Promise<number>((resolve, reject) => {
    pendingRequests.set(requestId, { filePath, resolve, reject })
    try {
      currentWorker.postMessage({ requestId, ffprobePath, filePath })
    } catch (error) {
      pendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export const resolveAudioTimeBasisOffsetMsOffMainThread = async (filePath: string) => {
  const cacheKey = normalizeLookupKey(filePath)
  if (!cacheKey) return 0
  let promise = timeBasisOffsetCache.get(cacheKey)
  if (!promise) {
    promise = resolveInWorker(filePath)
    timeBasisOffsetCache.set(cacheKey, promise)
    void promise.catch(() => {
      if (timeBasisOffsetCache.get(cacheKey) === promise) timeBasisOffsetCache.delete(cacheKey)
    })
  }
  return await promise
}

export const hasCachedAudioTimeBasisOffsetMsOffMainThread = (filePath: string) =>
  timeBasisOffsetCache.has(normalizeLookupKey(filePath))
