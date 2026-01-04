import path = require('path')
import fs = require('fs-extra')
import { ISongInfo } from '../../types/globals'
import { mapRendererPathToFsPath } from '../utils'
import store from '../store'
import * as LibraryCacheDb from '../libraryCacheDb'
import { findSongListRootByPath } from '../libraryTreeDb'

async function findSongListRoot(startDir: string): Promise<string | null> {
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
    await purgeCoverCacheForTrack(filePath)
  } catch {}
}

export { findSongListRoot }
