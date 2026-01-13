import path = require('path')
import fs = require('fs-extra')
import { ISongInfo } from '../../types/globals'
import { mapRendererPathToFsPath } from '../utils'
import store from '../store'
import * as LibraryCacheDb from '../libraryCacheDb'
import { findSongListRootByPath, loadLibraryNodes } from '../libraryTreeDb'
import type { LibraryNodeRow } from '../libraryTreeDb'

const normalizePath = (value: string): string => {
  if (!value) return ''
  let normalized = path.resolve(value)
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

async function findSongListRoot(startDir: string): Promise<string | null> {
  if (!startDir) return null
  const rootDir = store.databaseDir
  if (rootDir) {
    const recycleRoot = path.join(rootDir, mapRendererPathToFsPath('library/RecycleBin'))
    const normalizedStart = normalizePath(startDir)
    const normalizedRecycle = normalizePath(recycleRoot)
    if (
      normalizedStart &&
      normalizedRecycle &&
      (normalizedStart === normalizedRecycle ||
        normalizedStart.startsWith(normalizedRecycle + path.sep))
    ) {
      return recycleRoot
    }
  }
  return await findSongListRootByPath(startDir)
}

function normalizeSongInfoForCache(info: ISongInfo): ISongInfo {
  const baseName = path.basename(info.filePath)
  const ext = path.extname(info.filePath)
  const normalizedExt = ext ? ext.slice(1).toUpperCase() : ''
  return {
    ...info,
    fileName: info.fileName && info.fileName.trim() !== '' ? info.fileName : baseName,
    fileFormat:
      info.fileFormat && info.fileFormat.trim() !== ''
        ? info.fileFormat
        : normalizedExt || info.fileFormat
  }
}

function buildNodePathMap(nodes: LibraryNodeRow[], root: LibraryNodeRow): Map<string, string> {
  const childrenMap = new Map<string, LibraryNodeRow[]>()
  for (const row of nodes) {
    if (!row.parentUuid) continue
    const list = childrenMap.get(row.parentUuid)
    if (list) {
      list.push(row)
    } else {
      childrenMap.set(row.parentUuid, [row])
    }
  }
  const pathByUuid = new Map<string, string>()
  pathByUuid.set(root.uuid, root.dirName)
  const queue: LibraryNodeRow[] = [root]
  for (let i = 0; i < queue.length; i += 1) {
    const parent = queue[i]
    const parentPath = pathByUuid.get(parent.uuid)
    if (!parentPath) continue
    const children = childrenMap.get(parent.uuid) || []
    for (const child of children) {
      const childPath = path.join(parentPath, child.dirName)
      if (!pathByUuid.has(child.uuid)) {
        pathByUuid.set(child.uuid, childPath)
        queue.push(child)
      }
    }
  }
  return pathByUuid
}

export async function updateSongCacheEntry(
  filePath: string,
  info: ISongInfo,
  oldFilePath?: string
) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    const stat = await fs.stat(filePath)
    const normalizedInfo = normalizeSongInfoForCache(info)
    await LibraryCacheDb.upsertSongCacheEntry(
      songListRoot,
      filePath,
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: normalizedInfo
      },
      oldFilePath
    )
    if (oldFilePath && oldFilePath !== filePath) {
      const moved = await LibraryCacheDb.moveWaveformCacheEntry(
        songListRoot,
        oldFilePath,
        filePath,
        { size: stat.size, mtimeMs: stat.mtimeMs }
      )
      if (!moved) {
        await LibraryCacheDb.removeWaveformCacheEntry(songListRoot, oldFilePath)
      }
    }
  } catch {}
}

export async function purgeCoverCacheForTrack(filePath: string, oldFilePath?: string) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    const coversDir = path.join(songListRoot, '.frkb_covers')
    const targets = [filePath]
    if (oldFilePath && oldFilePath !== filePath) targets.push(oldFilePath)
    for (const target of targets) {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(songListRoot, target)
      if (removed === undefined) return
      if (!removed) continue
      const remaining = await LibraryCacheDb.countCoverIndexByHash(songListRoot, removed.hash)
      if (remaining === 0) {
        const coverPath = path.join(coversDir, `${removed.hash}${removed.ext || '.jpg'}`)
        try {
          if (await fs.pathExists(coverPath)) await fs.remove(coverPath)
        } catch {}
      }
    }
  } catch {}
}

export async function clearSongListCaches(songListPath: string | null | undefined) {
  try {
    if (!songListPath || typeof songListPath !== 'string') return
    let input = songListPath
    if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
    const mapped = path.isAbsolute(input) ? input : mapRendererPathToFsPath(input)
    const resolvedRoot = path.isAbsolute(mapped) ? mapped : path.join(store.databaseDir, mapped)
    const songsCache = path.join(resolvedRoot, '.songs.cache.json')
    const coversDir = path.join(resolvedRoot, '.frkb_covers')
    await LibraryCacheDb.clearSongCache(resolvedRoot)
    await LibraryCacheDb.clearCoverIndex(resolvedRoot)
    await LibraryCacheDb.clearWaveformCache(resolvedRoot)
    if (await fs.pathExists(songsCache)) {
      await fs.remove(songsCache)
    }
    if (await fs.pathExists(coversDir)) {
      await fs.remove(coversDir)
    }
  } catch {}
}

export async function clearTrackCache(filePath: string) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    await LibraryCacheDb.removeSongCacheEntry(songListRoot, filePath)
    await LibraryCacheDb.removeWaveformCacheEntry(songListRoot, filePath)
    await purgeCoverCacheForTrack(filePath)
  } catch {}
}

export async function pruneOrphanedSongListCaches(
  dbRoot?: string
): Promise<{ songCacheRemoved: number; coverIndexRemoved: number; waveformCacheRemoved: number }> {
  try {
    const rootDir = dbRoot || store.databaseDir
    if (!rootDir) {
      return { songCacheRemoved: 0, coverIndexRemoved: 0, waveformCacheRemoved: 0 }
    }
    const nodes = loadLibraryNodes(rootDir) || []
    if (nodes.length === 0) {
      return await LibraryCacheDb.pruneCachesByRoots(new Set())
    }
    const root = nodes.find((row) => row.parentUuid === null && row.nodeType === 'root')
    if (!root) {
      return await LibraryCacheDb.pruneCachesByRoots(new Set())
    }
    const pathByUuid = buildNodePathMap(nodes, root)
    const keepRoots = new Set<string>()
    for (const row of nodes) {
      if (row.nodeType !== 'songList') continue
      const rel = pathByUuid.get(row.uuid)
      if (!rel) continue
      keepRoots.add(path.join(rootDir, rel))
    }
    keepRoots.add(path.join(rootDir, mapRendererPathToFsPath('library/RecycleBin')))
    return await LibraryCacheDb.pruneCachesByRoots(keepRoots)
  } catch {
    return { songCacheRemoved: 0, coverIndexRemoved: 0, waveformCacheRemoved: 0 }
  }
}

export { findSongListRoot }
