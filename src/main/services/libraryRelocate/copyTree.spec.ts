import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { copyLibraryTree, verifyLibraryTree } from './copyTree'
import { collectLibraryInventory } from './inventory'

const tempRoots: string[] = []

const makeDir = async (name: string): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `frkb-relocate-copy-${name}-`))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true })
    })
  )
})

describe('copyLibraryTree', () => {
  it('复制后文件数和体积与源库一致，续传会跳过已完整文件', async () => {
    const source = await makeDir('src')
    await fs.mkdir(path.join(source, 'library', 'nested'), { recursive: true })
    await fs.writeFile(path.join(source, 'FRKB.database.frkbdb'), 'manifest')
    await fs.writeFile(path.join(source, 'library', 'nested', 'a.wav'), 'aaaa')
    await fs.writeFile(path.join(source, 'library', 'nested', 'b.wav'), 'bbbbbbbb')
    const dest = path.join(await makeDir('dest-root'), 'Lib')

    const first = await copyLibraryTree({ sourcePath: source, destPath: dest })
    expect(first.copiedFiles).toBe(3)
    await verifyLibraryTree({ sourcePath: source, destPath: dest })

    const before = await collectLibraryInventory(dest)
    const second = await copyLibraryTree({ sourcePath: source, destPath: dest })
    const after = await collectLibraryInventory(dest)
    expect(second.copiedFiles).toBe(3)
    expect(after.totalBytes).toBe(before.totalBytes)
  })
})
