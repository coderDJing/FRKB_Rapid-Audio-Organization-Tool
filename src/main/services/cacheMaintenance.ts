import path = require('path')
import fs = require('fs-extra')
import { ISongInfo } from '../../types/globals'
import { mapRendererPathToFsPath, operateHiddenFile } from '../utils'
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

    // Preserve existing bpm and key if not provided in new info
    // These are computed by audio analysis and should not be lost during metadata updates
    const lookupPath = oldFilePath || filePath
    const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, lookupPath)
    if (existingEntry?.info) {
      if (normalizedInfo.bpm === undefined && existingEntry.info.bpm !== undefined) {
        normalizedInfo.bpm = existingEntry.info.bpm
      }
      if (normalizedInfo.key === undefined && existingEntry.info.key !== undefined) {
        normalizedInfo.key = existingEntry.info.key
      }
    }

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

    // Update waveform cache stat to match new file stat after metadata update
    // This prevents cache invalidation when FFmpeg rewrites the file
    await LibraryCacheDb.updateWaveformCacheStat(songListRoot, filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })

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

export async function transferTrackCaches(params: {
  fromRoot: string | null
  toRoot: string | null
  fromPath: string
  toPath: string
}): Promise<void> {
  const { fromRoot, toRoot, fromPath, toPath } = params
  if (!fromRoot || !toRoot || !fromPath || !toPath) return
  if (
    normalizePath(fromRoot) === normalizePath(toRoot) &&
    normalizePath(fromPath) === normalizePath(toPath)
  ) {
    return
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(toPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return
  }

  try {
    const cacheEntry = await LibraryCacheDb.loadSongCacheEntry(fromRoot, fromPath)
    if (cacheEntry && stat) {
      const nextInfo = { ...cacheEntry.info, filePath: toPath }
      const updated = await LibraryCacheDb.upsertSongCacheEntry(toRoot, toPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: nextInfo
      })
      if (updated) {
        await LibraryCacheDb.removeSongCacheEntry(fromRoot, fromPath)
      }
    }
  } catch {}

  if (!stat) return
  try {
    const waveform = await LibraryCacheDb.loadWaveformCacheData(fromRoot, fromPath, stat)
    if (waveform) {
      const updated = await LibraryCacheDb.upsertWaveformCacheEntry(toRoot, toPath, stat, waveform)
      if (updated) {
        await LibraryCacheDb.removeWaveformCacheEntry(fromRoot, fromPath)
      }
    }
  } catch {}

  try {
    const cover = await LibraryCacheDb.loadCoverIndexEntry(fromRoot, fromPath)
    if (!cover) return
    const ext = cover.ext || '.jpg'
    const fromCoversDir = path.join(fromRoot, '.frkb_covers')
    const toCoversDir = path.join(toRoot, '.frkb_covers')
    const fromCoverPath = path.join(fromCoversDir, `${cover.hash}${ext}`)
    const toCoverPath = path.join(toCoversDir, `${cover.hash}${ext}`)
    if (normalizePath(fromCoverPath) !== normalizePath(toCoverPath)) {
      await fs.ensureDir(toCoversDir)
      await operateHiddenFile(toCoversDir, async () => {})
      try {
        if ((await fs.pathExists(fromCoverPath)) && !(await fs.pathExists(toCoverPath))) {
          await fs.copy(fromCoverPath, toCoverPath)
          await operateHiddenFile(toCoverPath, async () => {})
        }
      } catch {}
    }
    const saved = await LibraryCacheDb.upsertCoverIndexEntry(toRoot, toPath, cover.hash, ext)
    if (saved) {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(fromRoot, fromPath)
      if (removed) {
        const remaining = await LibraryCacheDb.countCoverIndexByHash(fromRoot, removed.hash)
        if (remaining === 0) {
          const staleCoverPath = path.join(fromCoversDir, `${removed.hash}${removed.ext || '.jpg'}`)
          try {
            if (await fs.pathExists(staleCoverPath)) {
              await fs.remove(staleCoverPath)
            }
          } catch {}
        }
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
