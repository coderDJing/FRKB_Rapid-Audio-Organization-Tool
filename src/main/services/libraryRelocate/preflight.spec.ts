import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { previewLibraryRelocate } from './preflight'
import { LibraryRelocateError } from './types'

const tempRoots: string[] = []

const makeDir = async (name: string): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `frkb-relocate-${name}-`))
  tempRoots.push(root)
  return root
}

const makeLibrary = async (name: string): Promise<string> => {
  const root = await makeDir(name)
  await fs.mkdir(path.join(root, 'library'))
  await fs.writeFile(path.join(root, 'FRKB.database.frkbdb'), '{"type":"frkb_root"}')
  await fs.writeFile(path.join(root, 'FRKB.database.sqlite'), 'x')
  await fs.writeFile(path.join(root, 'library', 'track.wav'), 'audio')
  return root
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true })
    })
  )
})

describe('previewLibraryRelocate', () => {
  it('拒绝把库移动到自己内部或原位置', async () => {
    const source = await makeLibrary('src')
    await expect(
      previewLibraryRelocate({ sourcePath: source, parentPath: source })
    ).rejects.toMatchObject({ code: 'PARENT_IS_LIBRARY' })
    await expect(
      previewLibraryRelocate({ sourcePath: source, parentPath: path.dirname(source) })
    ).rejects.toMatchObject({ code: 'SAME_PATH' })
  })

  it('拒绝已存在的目标目录，续传目标除外', async () => {
    const source = await makeLibrary('src2')
    const parent = await makeDir('parent')
    const dest = path.join(parent, path.basename(source))
    await fs.mkdir(dest)
    await expect(
      previewLibraryRelocate({ sourcePath: source, parentPath: parent })
    ).rejects.toMatchObject({ code: 'DEST_EXISTS' })
    const preview = await previewLibraryRelocate({
      sourcePath: source,
      parentPath: parent,
      resumeDestPath: dest
    })
    expect(preview.destPath).toBe(dest)
    expect(preview.totalFiles).toBeGreaterThan(0)
  })

  it('拒绝所选父目录已经是 FRKB 库', async () => {
    const source = await makeLibrary('src3')
    const other = await makeLibrary('other')
    await expect(
      previewLibraryRelocate({ sourcePath: source, parentPath: other })
    ).rejects.toMatchObject({ code: 'PARENT_IS_LIBRARY' })
  })
})

describe('LibraryRelocateError', () => {
  it('带上错误码', () => {
    const error = new LibraryRelocateError('NESTED_PATH', 'nested')
    expect(error.code).toBe('NESTED_PATH')
  })
})
