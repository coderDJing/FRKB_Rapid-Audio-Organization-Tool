import { Worker, isMainThread } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'
import type { SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import { readSongSearchPage } from './songSearchPageRead'
import type { ProjectedSongSearchRow } from './songSearchProjection'

type PendingRead = {
  resolve: (rows: ProjectedSongSearchRow[]) => void
  reject: (error: Error) => void
}

type SearchWorkerRequest = {
  id: number
  databasePath?: string
  afterRowId?: number
  limit?: number
  close?: boolean
}

let worker: Worker | null = null
let sequence = 0
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<number, PendingRead>()

const clearIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

const ensureWorker = (): Worker => {
  if (worker) return worker
  const current = new Worker(resolveMainWorkerPath(__dirname, 'songSearchRebuildWorker.js'))
  worker = current
  const fail = (error: Error) => {
    if (worker !== current) return
    worker = null
    clearIdleTimer()
    for (const read of pending.values()) read.reject(error)
    pending.clear()
    void current.terminate()
  }
  current.on('error', fail)
  current.on('exit', (code) => fail(new Error(`song search rebuild worker exited (${code})`)))
  current.on(
    'message',
    (response: { id: number; rows?: ProjectedSongSearchRow[]; error?: string }) => {
      const read = pending.get(response.id)
      if (!read) return
      pending.delete(response.id)
      if (response.error) read.reject(new Error(response.error))
      else if (response.rows) read.resolve(response.rows)
      else read.reject(new Error('song search rebuild worker returned no rows'))
      if (pending.size === 0) {
        idleTimer = setTimeout(() => {
          if (worker !== current) return
          worker = null
          idleTimer = null
          void current.terminate()
        }, 30_000)
        idleTimer.unref()
        current.unref()
      }
    }
  )
  return current
}

export type SongSearchReadMode = {
  useInProcess: boolean
  loggedFailure: boolean
}

const postWorker = (request: SearchWorkerRequest): Promise<ProjectedSongSearchRow[]> => {
  const current = ensureWorker()
  clearIdleTimer()
  current.ref()
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    try {
      current.postMessage(request)
    } catch (error) {
      pending.delete(request.id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export const readSongSearchPageOffMainThread = (
  db: SqliteDatabase,
  afterRowId: number,
  limit: number
): Promise<ProjectedSongSearchRow[]> => {
  if (!isMainThread || db.inTransaction || db.memory) {
    return Promise.resolve(readSongSearchPage(db, afterRowId, limit))
  }
  const id = ++sequence
  return postWorker({ id, databasePath: db.name, afterRowId, limit })
}

export const releaseSongSearchRebuildConnection = (): Promise<void> => {
  if (!isMainThread || !worker) return Promise.resolve()
  const id = ++sequence
  return postWorker({ id, close: true }).then(() => undefined)
}

export const resetSongSearchRebuildWorkerForTests = async (): Promise<void> => {
  const current = worker
  worker = null
  clearIdleTimer()
  for (const read of pending.values()) read.reject(new Error('song search rebuild worker reset'))
  pending.clear()
  if (current) await current.terminate()
}

/** worker 失败后，同一次重建改回当前连接，避免每一页都再失败一次。 */
export const readSongSearchPageResilient = async (
  db: SqliteDatabase,
  afterRowId: number,
  limit: number,
  mode: SongSearchReadMode
): Promise<ProjectedSongSearchRow[]> => {
  if (mode.useInProcess || !isMainThread || db.inTransaction || db.memory) {
    return readSongSearchPage(db, afterRowId, limit)
  }
  try {
    return await readSongSearchPageOffMainThread(db, afterRowId, limit)
  } catch (error) {
    if (!mode.loggedFailure) {
      mode.loggedFailure = true
      log.error('[song-search] off-thread rebuild failed', error)
    }
    mode.useInProcess = true
    return readSongSearchPage(db, afterRowId, limit)
  }
}
