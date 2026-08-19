import fs from 'fs-extra'
import { statfs } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { MANIFEST_FILE_NAME } from '../../databaseManifest'
import { LIBRARY_RELOCATE_DEST_MARKER, LIBRARY_RELOCATE_MERGE_MARKERS } from './types'
import { isPathInside, pathsEqual } from './paths'
import type { LibraryInventory, LibraryInventoryFile } from './types'

const SQLITE_FILE_NAME = 'FRKB.database.sqlite'
const IGNORED_NAMES = new Set([
  LIBRARY_RELOCATE_DEST_MARKER,
  `${LIBRARY_RELOCATE_DEST_MARKER}.tmp`,
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store'
])

export const isIgnoredRelocateName = (name: string): boolean => IGNORED_NAMES.has(name)

export const isFrkbLibraryRoot = async (dirPath: string): Promise<boolean> => {
  const root = String(dirPath || '').trim()
  if (!root) return false
  try {
    if (await fs.pathExists(path.join(root, MANIFEST_FILE_NAME))) return true
    const hasSqlite = await fs.pathExists(path.join(root, SQLITE_FILE_NAME))
    const libraryStat = await fs.stat(path.join(root, 'library')).catch(() => null)
    return hasSqlite && !!libraryStat?.isDirectory()
  } catch {
    return false
  }
}

export const findLibraryRootUpwards = async (startDir: string): Promise<string | null> => {
  let current = path.resolve(String(startDir || '').trim())
  for (let i = 0; i < 40; i += 1) {
    if (await isFrkbLibraryRoot(current)) return current
    const parent = path.dirname(current)
    if (!parent || pathsEqual(parent, current)) break
    current = parent
  }
  return null
}

export const hasIncompleteLibraryMergeWork = async (libraryRoot: string): Promise<boolean> => {
  for (const marker of LIBRARY_RELOCATE_MERGE_MARKERS) {
    if (await fs.pathExists(path.join(libraryRoot, marker))) return true
  }
  return false
}

export const collectLibraryInventory = async (root: string): Promise<LibraryInventory> => {
  const files: LibraryInventoryFile[] = []
  let totalBytes = 0

  const walk = async (dirPath: string): Promise<void> => {
    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (isIgnoredRelocateName(entry.name)) continue
      const absPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await walk(absPath)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fs.stat(absPath)
        if (!stat.isFile()) continue
        files.push({
          relativePath: path.relative(root, absPath),
          absPath,
          size: stat.size
        })
        totalBytes += stat.size
      } catch {}
    }
  }

  await walk(root)
  return { files, totalBytes }
}

export const getAvailableBytes = async (targetDir: string): Promise<number | null> => {
  try {
    const stats = await statfs(targetDir)
    const available = Number(stats.bavail) * Number(stats.bsize)
    return Number.isFinite(available) && available >= 0 ? available : null
  } catch {
    return null
  }
}

export const isSameVolume = async (sourcePath: string, parentPath: string): Promise<boolean> => {
  try {
    const sourceStat = await fs.stat(sourcePath)
    const parentStat = await fs.stat(parentPath)
    if (sourceStat.dev !== parentStat.dev) return false
    return pathsEqual(path.parse(sourcePath).root, path.parse(parentPath).root)
  } catch {
    return false
  }
}

export const assertNotNestedRelocate = (
  sourcePath: string,
  destPath: string,
  parentPath: string
) => {
  if (pathsEqual(sourcePath, destPath) || pathsEqual(sourcePath, parentPath)) {
    return 'SAME_PATH' as const
  }
  if (isPathInside(destPath, sourcePath) || isPathInside(parentPath, sourcePath)) {
    return 'NESTED_PATH' as const
  }
  if (isPathInside(sourcePath, destPath)) {
    return 'NESTED_PATH' as const
  }
  return null
}
