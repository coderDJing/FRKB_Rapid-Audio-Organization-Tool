import fs from 'fs-extra'
import path from 'node:path'
import { LibraryRelocateError, type LibraryInventoryFile } from './types'
import { LIBRARY_RELOCATE_DEST_MARKER } from './types'
import { toRelativePathKey } from './paths'
import { collectLibraryInventory, isIgnoredRelocateName } from './inventory'

const COPY_RETRY_LIMIT = 3
const COPY_RETRY_DELAY_MS = 200

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new LibraryRelocateError('CANCELED', '已取消移动音乐库')
  }
}

const copyFileWithRetry = async (source: string, dest: string, signal?: AbortSignal) => {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= COPY_RETRY_LIMIT; attempt += 1) {
    throwIfAborted(signal)
    try {
      await fs.ensureDir(path.dirname(dest))
      await fs.copyFile(source, dest)
      return
    } catch (error) {
      lastError = error
      if (attempt < COPY_RETRY_LIMIT) await wait(COPY_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'copy failed'))
}

export const writeRelocateDestMarker = async (params: {
  destPath: string
  sourcePath: string
}): Promise<void> => {
  await fs.ensureDir(params.destPath)
  await fs.outputJson(path.join(params.destPath, LIBRARY_RELOCATE_DEST_MARKER), {
    sourcePath: params.sourcePath,
    destPath: params.destPath,
    updatedAt: new Date().toISOString()
  })
}

export const removeRelocateDestMarker = async (destPath: string): Promise<void> => {
  try {
    await fs.remove(path.join(destPath, LIBRARY_RELOCATE_DEST_MARKER))
  } catch {}
}

export const copyLibraryTree = async (params: {
  sourcePath: string
  destPath: string
  files?: LibraryInventoryFile[]
  signal?: AbortSignal
  onProgress?: (copiedBytes: number, copiedFiles: number, currentPath: string) => void
}): Promise<{
  copiedBytes: number
  copiedFiles: number
  totalBytes: number
  totalFiles: number
}> => {
  const files = params.files || (await collectLibraryInventory(params.sourcePath)).files
  let copiedBytes = 0
  let copiedFiles = 0
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  await writeRelocateDestMarker({ destPath: params.destPath, sourcePath: params.sourcePath })

  for (const file of files) {
    throwIfAborted(params.signal)
    const destFile = path.join(params.destPath, file.relativePath)
    let skip = false
    try {
      const destStat = await fs.stat(destFile)
      if (destStat.isFile() && destStat.size === file.size) skip = true
    } catch {
      skip = false
    }
    if (!skip) {
      try {
        await fs.remove(destFile)
      } catch {}
      await copyFileWithRetry(file.absPath, destFile, params.signal)
    }
    copiedBytes += file.size
    copiedFiles += 1
    params.onProgress?.(copiedBytes, copiedFiles, file.relativePath)
  }

  return { copiedBytes, copiedFiles, totalBytes, totalFiles: files.length }
}

export const verifyLibraryTree = async (params: {
  sourcePath: string
  destPath: string
}): Promise<void> => {
  const source = await collectLibraryInventory(params.sourcePath)
  const dest = await collectLibraryInventory(params.destPath)
  if (source.files.length !== dest.files.length || source.totalBytes !== dest.totalBytes) {
    throw new LibraryRelocateError('VERIFY_FAILED', '复制结果与源库文件数或体积不一致', {
      sourceFiles: source.files.length,
      destFiles: dest.files.length,
      sourceBytes: source.totalBytes,
      destBytes: dest.totalBytes
    })
  }
  const destByKey = new Map(
    dest.files.map((file) => [toRelativePathKey(params.destPath, file.absPath), file])
  )
  for (const file of source.files) {
    const key = toRelativePathKey(params.sourcePath, file.absPath)
    const matched = destByKey.get(key)
    if (!matched || matched.size !== file.size) {
      throw new LibraryRelocateError('VERIFY_FAILED', `文件校验失败：${file.relativePath}`)
    }
  }
}

export const renameLibraryRoot = async (params: {
  sourcePath: string
  destPath: string
  signal?: AbortSignal
}): Promise<void> => {
  throwIfAborted(params.signal)
  await fs.ensureDir(path.dirname(params.destPath))
  if (await fs.pathExists(params.destPath)) {
    throw new LibraryRelocateError('DEST_EXISTS', `目标目录已存在：${params.destPath}`)
  }
  try {
    await fs.rename(params.sourcePath, params.destPath)
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : ''
    if (code === 'EXDEV') {
      throw error
    }
    throw new LibraryRelocateError(
      'COPY_FAILED',
      error instanceof Error ? error.message : '无法移动音乐库目录'
    )
  }
}

export const removeRelocateDirectory = async (dirPath: string): Promise<void> => {
  if (!dirPath) return
  await fs.remove(dirPath)
}

export { isIgnoredRelocateName }
