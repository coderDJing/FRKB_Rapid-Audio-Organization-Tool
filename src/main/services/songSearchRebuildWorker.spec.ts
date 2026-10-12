import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { SqliteDatabase } from '../libraryDb'

const workerFile = vi.hoisted(() => ({ path: '' }))

vi.mock('../workerPath', () => ({
  resolveMainWorkerPath: () => workerFile.path
}))

import {
  readSongSearchPageOffMainThread,
  readSongSearchPageResilient,
  releaseSongSearchRebuildConnection,
  resetSongSearchRebuildWorkerForTests
} from './songSearchRebuildWorker'

const roots: string[] = []

afterEach(async () => {
  await resetSongSearchRebuildWorkerForTests()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const writeWorker = async (source: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-search-worker-'))
  roots.push(root)
  const file = path.join(root, 'worker.js')
  await fs.writeFile(file, source)
  workerFile.path = file
  return root
}

const createSongCacheDatabase = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-search-db-'))
  roots.push(root)
  const db = new Database(path.join(root, 'cache.sqlite'))
  db.exec(`CREATE TABLE song_cache (
    list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT
  )`)
  db.prepare(
    'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
  ).run('library/list', 'track.mp3', 1, 1, JSON.stringify({ title: 'FromDb' }))
  return db as unknown as SqliteDatabase
}

describe('song search rebuild worker', () => {
  it('同一次重建复用只读连接，结束后关掉', async () => {
    const root = await writeWorker(`
      const { parentPort } = require('node:worker_threads')
      const fs = require('node:fs')
      let openedFor = ''
      parentPort.on('message', (request) => {
        if (request.close) {
          fs.appendFileSync(process.env.FRKB_SEARCH_WORKER_LOG, 'close\\n')
          openedFor = ''
          parentPort.postMessage({ id: request.id, rows: [] })
          return
        }
        if (openedFor !== request.databasePath) {
          openedFor = request.databasePath
          fs.appendFileSync(process.env.FRKB_SEARCH_WORKER_LOG, 'open\\n')
        }
        parentPort.postMessage({ id: request.id, rows: [] })
      })
    `)
    const logPath = path.join(root, 'worker.log')
    await fs.writeFile(logPath, '')
    process.env.FRKB_SEARCH_WORKER_LOG = logPath
    const db = await createSongCacheDatabase()
    await readSongSearchPageOffMainThread(db, 0, 10)
    await readSongSearchPageOffMainThread(db, 10, 10)
    await releaseSongSearchRebuildConnection()
    db.close()
    const log = await fs.readFile(logPath, 'utf8')
    expect(log).toBe('open\nclose\n')
  })

  it('worker 失败后改回主线程读取，并且同一次重建不再重试 worker', async () => {
    await writeWorker(`
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', (request) => {
        parentPort.postMessage({ id: request.id, error: 'worker failed' })
      })
    `)
    const db = await createSongCacheDatabase()
    const mode = { useInProcess: false, loggedFailure: false }
    const first = await readSongSearchPageResilient(db, 0, 10, mode)
    expect(first[0]?.title).toBe('FromDb')
    expect(mode).toEqual({ useInProcess: true, loggedFailure: true })
    const second = await readSongSearchPageResilient(db, 0, 10, mode)
    expect(second[0]?.title).toBe('FromDb')
    db.close()
  })

  it('内存库直接在当前连接读取', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE song_cache (
      list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT
    )`)
    db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    ).run('library/list', 'memory.mp3', 1, 1, '{"title":"Memory"}')
    const rows = await readSongSearchPageOffMainThread(db as unknown as SqliteDatabase, 0, 10)
    expect(rows[0]?.title).toBe('Memory')
    db.close()
  })
})
