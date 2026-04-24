import { Worker } from 'node:worker_threads'
import type { scanSongList } from './scanSongs'
import { resolveMainWorkerPath } from '../workerPath'

type ScanSongListResult = Awaited<ReturnType<typeof scanSongList>>

type WorkerRequest = {
  scanPath: string | string[]
  audioExt: string[]
  songListUUID: string
  databaseDir: string
}

type WorkerResponse = {
  result?: ScanSongListResult
  error?: string
}

export const scanSongListOffMainThread = (request: WorkerRequest): Promise<ScanSongListResult> =>
  new Promise((resolve, reject) => {
    const workerPath = resolveMainWorkerPath(__dirname, 'songListScanWorker.js')
    const worker = new Worker(workerPath)

    let settled = false
    const cleanup = () => {
      worker.removeAllListeners()
    }
    const finishResolve = (value: ScanSongListResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    worker.once('message', (payload: WorkerResponse) => {
      if (payload?.error) {
        finishReject(new Error(payload.error))
        return
      }
      if (!payload?.result) {
        finishReject(new Error('scanSongList worker returned empty result'))
        return
      }
      finishResolve(payload.result)
    })

    worker.once('error', (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error || 'unknown error')))
    })

    worker.once('exit', (code) => {
      if (settled) return
      finishReject(new Error(`scanSongList worker exited: ${String(code ?? '')}`))
    })

    worker.postMessage(request)
  })
