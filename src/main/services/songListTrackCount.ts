import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'

type CountWorkerRequest = {
  scanPath: string
  audioExt: string[]
}

type BatchCountWorkerRequest = {
  scanPaths: string[]
  audioExt: string[]
}

type CountWorkerResponse = {
  count?: number
  counts?: number[]
  error?: string
}

type PendingCountRequest = {
  request: CountWorkerRequest | BatchCountWorkerRequest
  resolve: (counts: number[]) => void
  reject: (error: Error) => void
}

const isBatchRequest = (
  request: CountWorkerRequest | BatchCountWorkerRequest
): request is BatchCountWorkerRequest =>
  Array.isArray((request as BatchCountWorkerRequest).scanPaths)

// 曲目数只是展示信息，不能为了它让多个递归遍历同时压垮慢盘和 Electron 主进程。
const MAX_CONCURRENT_COUNT_WORKERS = 1

let activeWorkerCount = 0
const pendingRequests: PendingCountRequest[] = []
const inFlightByKey = new Map<string, Promise<number>>()

const createRequestKey = (request: CountWorkerRequest) =>
  `${request.scanPath}\u0000${[...request.audioExt].sort().join('\u0000')}`

const normalizeCount = (value: number) => Math.max(0, Math.floor(value))

const countFilesInWorker = (
  request: CountWorkerRequest | BatchCountWorkerRequest
): Promise<number[]> =>
  new Promise((resolve, reject) => {
    const workerPath = resolveMainWorkerPath(__dirname, 'songListTrackCountWorker.js')
    const worker = new Worker(workerPath)
    let settled = false
    const batch = isBatchRequest(request)

    const cleanup = () => {
      worker.removeAllListeners()
      void worker.terminate()
    }
    const finishResolve = (counts: number[]) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(counts)
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
      if (batch) {
        const counts = payload?.counts
        if (!Array.isArray(counts) || counts.length !== request.scanPaths.length) {
          finishReject(new Error('songListTrackCount worker returned invalid batch counts'))
          return
        }
        finishResolve(
          counts.map((count) =>
            typeof count === 'number' && Number.isFinite(count) ? normalizeCount(count) : 0
          )
        )
        return
      }
      if (typeof payload?.count !== 'number' || !Number.isFinite(payload.count)) {
        finishReject(new Error('songListTrackCount worker returned invalid count'))
        return
      }
      finishResolve([normalizeCount(payload.count)])
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

const normalizeExtensions = (audioExt: unknown) =>
  Array.isArray(audioExt)
    ? audioExt.filter((extension): extension is string => typeof extension === 'string')
    : []

export const countSongListTracksOffMainThread = (request: CountWorkerRequest): Promise<number> => {
  const normalizedPath = String(request.scanPath || '').trim()
  const normalizedExtensions = normalizeExtensions(request.audioExt)
  if (!normalizedPath) return Promise.resolve(0)

  const normalizedRequest = {
    scanPath: normalizedPath,
    audioExt: normalizedExtensions
  }
  const key = createRequestKey(normalizedRequest)
  const existing = inFlightByKey.get(key)
  if (existing) return existing

  const task = new Promise<number[]>((resolve, reject) => {
    pendingRequests.push({ request: normalizedRequest, resolve, reject })
    drainCountQueue()
  }).then((counts) => counts[0] ?? 0)
  inFlightByKey.set(key, task)
  void task.then(
    () => inFlightByKey.delete(key),
    () => inFlightByKey.delete(key)
  )
  return task
}

/**
 * 批量统计多个歌单目录的曲目数。单个 worker 顺序遍历，避免为每个歌单启停 worker，
 * 也让渲染层拿到一次完整结果、只重排一次。
 */
export const countSongListTracksBatchOffMainThread = async (request: {
  scanPaths: string[]
  audioExt: string[]
}): Promise<number[]> => {
  const scanPaths = Array.isArray(request.scanPaths)
    ? request.scanPaths.map((scanPath) => String(scanPath || '').trim())
    : []
  if (!scanPaths.length) return []
  const normalizedRequest: BatchCountWorkerRequest = {
    scanPaths,
    audioExt: normalizeExtensions(request.audioExt)
  }
  return new Promise<number[]>((resolve, reject) => {
    pendingRequests.push({ request: normalizedRequest, resolve, reject })
    drainCountQueue()
  })
}
