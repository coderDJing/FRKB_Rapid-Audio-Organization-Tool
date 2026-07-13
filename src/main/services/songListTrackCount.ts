import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'

type CountWorkerRequest = {
  scanPath: string
  audioExt: string[]
}

type CountWorkerResponse = {
  count?: number
  error?: string
}

type PendingCountRequest = {
  request: CountWorkerRequest
  resolve: (count: number) => void
  reject: (error: Error) => void
}

// 曲目数只是展示信息，不能为了它让多个递归遍历同时压垮慢盘和 Electron 主进程。
const MAX_CONCURRENT_COUNT_WORKERS = 1

let activeWorkerCount = 0
const pendingRequests: PendingCountRequest[] = []
const inFlightByKey = new Map<string, Promise<number>>()

const createRequestKey = (request: CountWorkerRequest) =>
  `${request.scanPath}\u0000${[...request.audioExt].sort().join('\u0000')}`

const countFilesInWorker = (request: CountWorkerRequest): Promise<number> =>
  new Promise((resolve, reject) => {
    const workerPath = resolveMainWorkerPath(__dirname, 'songListTrackCountWorker.js')
    const worker = new Worker(workerPath)
    let settled = false

    const cleanup = () => {
      worker.removeAllListeners()
      void worker.terminate()
    }
    const finishResolve = (count: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(count)
    }
    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    worker.once('message', (payload: CountWorkerResponse) => {
      if (payload?.error) {
        finishReject(new Error(payload.error))
        return
      }
      if (typeof payload?.count !== 'number' || !Number.isFinite(payload.count)) {
        finishReject(new Error('songListTrackCount worker returned invalid count'))
        return
      }
      finishResolve(Math.max(0, Math.floor(payload.count)))
    })
    worker.once('error', (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error || 'unknown error')))
    })
    worker.once('exit', (code) => {
      if (settled) return
      finishReject(new Error(`songListTrackCount worker exited: ${String(code ?? '')}`))
    })
    worker.postMessage(request)
  })

const drainCountQueue = () => {
  while (activeWorkerCount < MAX_CONCURRENT_COUNT_WORKERS && pendingRequests.length > 0) {
    const pending = pendingRequests.shift()
    if (!pending) return
    activeWorkerCount += 1
    void countFilesInWorker(pending.request)
      .then(pending.resolve, pending.reject)
      .finally(() => {
        activeWorkerCount -= 1
        drainCountQueue()
      })
  }
}

export const countSongListTracksOffMainThread = (request: CountWorkerRequest): Promise<number> => {
  const normalizedPath = String(request.scanPath || '').trim()
  const normalizedExtensions = Array.isArray(request.audioExt)
    ? request.audioExt.filter((extension): extension is string => typeof extension === 'string')
    : []
  if (!normalizedPath) return Promise.resolve(0)

  const normalizedRequest = {
    scanPath: normalizedPath,
    audioExt: normalizedExtensions
  }
  const key = createRequestKey(normalizedRequest)
  const existing = inFlightByKey.get(key)
  if (existing) return existing

  const task = new Promise<number>((resolve, reject) => {
    pendingRequests.push({ request: normalizedRequest, resolve, reject })
    drainCountQueue()
  })
  inFlightByKey.set(key, task)
  void task.then(
    () => inFlightByKey.delete(key),
    () => inFlightByKey.delete(key)
  )
  return task
}
