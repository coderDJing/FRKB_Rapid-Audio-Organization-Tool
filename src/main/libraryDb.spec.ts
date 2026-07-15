import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertExistingDatabaseSchemaSupported,
  closeLibraryDb,
  DatabaseSchemaVersionError,
  getLibraryDbPath,
  initLibraryDb,
  MAX_SUPPORTED_DATABASE_SCHEMA_VERSION
} from './libraryDb'

const temporaryRoots: string[] = []

const createTemporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-db-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  closeLibraryDb()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('library database initialization', () => {
  it('does not recreate a deleted library root while probing the saved path', async () => {
    const parent = await createTemporaryRoot()
    const deletedLibraryRoot = path.join(parent, 'deleted-library')

    expect(initLibraryDb(deletedLibraryRoot)).toBeNull()
    await expect(fs.access(deletedLibraryRoot)).rejects.toThrow()
  })

  it('does not create SQLite when the library directory is missing', async () => {
    const root = await createTemporaryRoot()

    expect(initLibraryDb(root)).toBeNull()
    await expect(fs.access(getLibraryDbPath(root))).rejects.toThrow()
  })

  it('rejects a database created by a newer FRKB before opening it for writes', async () => {
    const root = await createTemporaryRoot()
    await fs.mkdir(path.join(root, 'library'))
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const databasePath = getLibraryDbPath(root)
    const instance = new Database(databasePath)
    instance.pragma(`user_version = ${MAX_SUPPORTED_DATABASE_SCHEMA_VERSION + 1}`)
    instance.close()

    expect(() => assertExistingDatabaseSchemaSupported(databasePath)).toThrow(
      DatabaseSchemaVersionError
    )
    expect(() => initLibraryDb(root)).toThrow(DatabaseSchemaVersionError)
  })
})
