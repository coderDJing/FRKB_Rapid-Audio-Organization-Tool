import { parentPort } from 'node:worker_threads'
import { readSongSearchPage } from '../services/songSearchPageRead'
import type { SqliteDatabase } from '../libraryDb'

type SearchPageRequest = {
  id: number
  databasePath?: string
  afterRowId?: number
  limit?: number
  close?: boolean
}

let db: SqliteDatabase | null = null
let dbPath = ''

const closeDatabase = () => {
  db?.close()
  db = null
  dbPath = ''
}

const openDatabase = (databasePath: string): SqliteDatabase => {
  if (db && dbPath === databasePath) return db
  closeDatabase()
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const next = new Database(databasePath, { readonly: true, fileMustExist: true })
  next.pragma('query_only = ON')
  next.pragma('busy_timeout = 4000')
  db = next
  dbPath = databasePath
  return next
}

parentPort?.on('message', (request: SearchPageRequest) => {
  try {
    if (request.close) {
      closeDatabase()
      parentPort?.postMessage({ id: request.id, rows: [] })
      return
    }
    const databasePath = String(request.databasePath || '')
    const rows = readSongSearchPage(
      openDatabase(databasePath),
      Number(request.afterRowId) || 0,
      Number(request.limit) || 1
    )
    parentPort?.postMessage({ id: request.id, rows })
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
