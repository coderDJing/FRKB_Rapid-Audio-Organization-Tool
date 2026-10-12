import { Worker, isMainThread } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../workerPath'
import {
  readSongCacheRows,
  readSongCacheTrackFieldRows,
  type SongCacheDbRow,
  type SongCacheTrackFieldRow
} from '../libraryCacheDb/songCacheRead'
import type { SqliteDatabase } from '../libraryDb'

type CacheReadMode = 'rows' | 'track-fields'

type PendingRead = {
  resolve: (rows: unknown[][]) => void
  reject: (error: Error) => void
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
  const current = new Worker(resolveMainWorkerPath(__dirname, 'songCacheReadWorker.js'))
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
  current.on('exit', (code) => fail(new Error(`song cache read worker exited (${code})`)))
  current.on('message', (response: { id: number; rows?: SongCacheDbRow[][]; error?: string }) => {
    const read = pending.get(response.id)
    if (!read) return
    pending.delete(response.id)
    if (response.error) read.reject(new Error(response.error))
    else if (response.rows) read.resolve(response.rows)
    else read.reject(new Error('song cache read worker returned no rows'))
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
  })
  return current
}

const readSongCacheOffMainThreadWithMode = <T>(
  db: SqliteDatabase,
  roots: string[],
  mode: CacheReadMode
): Promise<T[][]> => {
  // 已在扫描 worker 内时直接读；事务内必须使用原连接，才能看见尚未提交的写入。
  if (!isMainThread || db.inTransaction || db.memory) {
    const rows =
      mode === 'track-fields'
        ? readSongCacheTrackFieldRows(db, roots)
        : readSongCacheRows(db, roots)
    return Promise.resolve(rows as T[][])
  }
  const current = ensureWorker()
  clearIdleTimer()
  current.ref()
  const id = ++sequence
  return new Promise<T[][]>((resolve, reject) => {
    pending.set(id, {
      resolve: (rows) => resolve(rows as T[][]),
      reject
    })
    try {
      current.postMessage({ id, databasePath: db.name, roots, mode })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export const readSongCacheOffMainThread = (
  db: SqliteDatabase,
  roots: string[]
): Promise<SongCacheDbRow[][]> =>
  readSongCacheOffMainThreadWithMode<SongCacheDbRow>(db, roots, 'rows')

export const readSongCacheTrackFieldsOffMainThread = (
  db: SqliteDatabase,
  roots: string[]
): Promise<SongCacheTrackFieldRow[][]> =>
  readSongCacheOffMainThreadWithMode<SongCacheTrackFieldRow>(db, roots, 'track-fields')
