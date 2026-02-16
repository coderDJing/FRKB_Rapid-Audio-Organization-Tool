import path from 'node:path'
import { findSongListRoot } from './cacheMaintenance'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeFilePathsInUse } from '../mixtapeDb'

const normalizeUniquePaths = (values: unknown[]): string[] => {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

export async function cleanupMixtapeWaveformCache(filePaths: string[]): Promise<void> {
  const normalizedPaths = normalizeUniquePaths(filePaths)
  if (normalizedPaths.length === 0) return
  const inUse = new Set(listMixtapeFilePathsInUse(normalizedPaths))
  const unused = normalizedPaths.filter((filePath) => !inUse.has(filePath))
  if (unused.length === 0) return

  for (const filePath of unused) {
    try {
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!listRoot) continue
      await LibraryCacheDb.removeMixtapeWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
      await LibraryCacheDb.removeMixtapeWaveformHiresCacheEntry(listRoot, filePath)
    } catch {}
  }
}
