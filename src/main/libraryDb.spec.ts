import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb, getLibraryDbPath, initLibraryDb } from './libraryDb'

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
})
