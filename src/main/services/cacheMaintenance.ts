import path = require('path')
import fs = require('fs-extra')
import { ISongInfo } from '../../types/globals'
import { operateHiddenFile, mapRendererPathToFsPath } from '../utils'
import store from '../store'

async function findSongListRoot(startDir: string): Promise<string | null> {
  try {
    let current = startDir
    const parsed = path.parse(startDir)
    const boundary = parsed.root || current
    while (current) {
      const descPath = path.join(current, '.description.json')
      try {
        const desc = await fs.readJSON(descPath)
        if (desc && desc.type === 'songList') return current
      } catch {}
      if (current === boundary) break
      const parent = path.dirname(current)
      if (!parent || parent === current) break
      current = parent
    }
  } catch {}
  return null
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
    const cachePath = path.join(songListRoot, '.songs.cache.json')
    if (!(await fs.pathExists(cachePath))) return
    const stat = await fs.stat(filePath)
    const cacheJson = await fs.readJSON(cachePath).catch(() => ({ entries: Object.create(null) }))
    const entries =
      cacheJson &&
      typeof cacheJson === 'object' &&
      cacheJson.entries &&
      typeof cacheJson.entries === 'object'
        ? cacheJson.entries
        : Object.create(null)
    if (oldFilePath && oldFilePath !== filePath) {
      delete entries[oldFilePath]
    }
    entries[filePath] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      info: normalizeSongInfoForCache(info)
    }
    await fs.writeJSON(cachePath, { entries })
    await operateHiddenFile(cachePath, async () => {})
  } catch {}
}

export async function purgeCoverCacheForTrack(filePath: string, oldFilePath?: string) {
  try {
    const songListRoot = await findSongListRoot(path.dirname(filePath))
    if (!songListRoot) return
    const coversDir = path.join(songListRoot, '.frkb_covers')
    const indexPath = path.join(coversDir, '.index.json')
    if (!(await fs.pathExists(indexPath))) return
    const idx = await fs
      .readJSON(indexPath)
      .catch(() => ({ fileToHash: {}, hashToFiles: {}, hashToExt: {} }))
    const ensureArray = (value: any) => (Array.isArray(value) ? value : [])
    const targets = [filePath]
    if (oldFilePath && oldFilePath !== filePath) targets.push(oldFilePath)
    let changed = false
    for (const target of targets) {
      const hash = idx?.fileToHash?.[target]
      if (!hash) continue
      delete idx.fileToHash[target]
      const filesArr = ensureArray(idx.hashToFiles?.[hash])
      const filtered = filesArr.filter((p: string) => p !== target)
      if (filtered.length > 0) {
        idx.hashToFiles[hash] = filtered
      } else {
        const ext = idx.hashToExt?.[hash] || '.jpg'
        const coverPath = path.join(coversDir, `${hash}${ext}`)
        try {
          if (await fs.pathExists(coverPath)) await fs.remove(coverPath)
        } catch {}
        delete idx.hashToFiles[hash]
        if (idx.hashToExt) delete idx.hashToExt[hash]
      }
      changed = true
    }
    if (changed) {
      await fs.writeJSON(indexPath, {
        fileToHash: idx.fileToHash || {},
        hashToFiles: idx.hashToFiles || {},
        hashToExt: idx.hashToExt || {}
      })
      await operateHiddenFile(indexPath, async () => {})
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
    const cachePath = path.join(songListRoot, '.songs.cache.json')
    try {
      if (await fs.pathExists(cachePath)) {
        const json = await fs.readJSON(cachePath)
        if (json && typeof json === 'object' && json.entries) {
          if (json.entries[filePath]) {
            delete json.entries[filePath]
            await fs.writeJSON(cachePath, json)
            await operateHiddenFile(cachePath, async () => {})
          }
        }
      }
    } catch {}
    await purgeCoverCacheForTrack(filePath)
  } catch {}
}

export { findSongListRoot }
