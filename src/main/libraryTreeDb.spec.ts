import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { closeLibraryDb } from './libraryDb'
import { loadLibraryNodes, syncLibraryTreeFromDisk } from './libraryTreeDb'

const temporaryDirectories: string[] = []

const coreDirNames = {
  FilterLibrary: 'FilterLibrary',
  CuratedLibrary: 'CuratedLibrary',
  SetLibrary: 'SetLibrary',
  MixtapeLibrary: 'MixtapeLibrary',
  RecordingLibrary: 'RecordingLibrary',
  RecycleBin: 'RecycleBin'
}

afterEach(async () => {
  closeLibraryDb()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('library tree disk sync', () => {
  it('inserts a new parent before moving an existing child below it', async () => {
    const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-library-tree-'))
    temporaryDirectories.push(dbRoot)
    const filterLibraryPath = path.join(dbRoot, 'library', coreDirNames.FilterLibrary)
    const existingChildPath = path.join(filterLibraryPath, 'existing-child')
    await fs.mkdir(existingChildPath, { recursive: true })

    await syncLibraryTreeFromDisk(dbRoot, { coreDirNames })
    const existingChild = (loadLibraryNodes(dbRoot) || []).find(
      (node) => node.dirName === 'existing-child'
    )
    expect(existingChild).toBeTruthy()

    const newParentPath = path.join(filterLibraryPath, 'new-parent')
    await fs.mkdir(newParentPath, { recursive: true })
    await fs.rename(existingChildPath, path.join(newParentPath, 'existing-child'))

    await expect(syncLibraryTreeFromDisk(dbRoot, { coreDirNames })).resolves.toMatchObject({
      added: 1,
      updated: 1
    })

    const nodes = loadLibraryNodes(dbRoot) || []
    const newParent = nodes.find((node) => node.dirName === 'new-parent')
    const movedChild = nodes.find((node) => node.uuid === existingChild?.uuid)
    expect(newParent).toBeTruthy()
    expect(movedChild?.parentUuid).toBe(newParent?.uuid)
  })
})
