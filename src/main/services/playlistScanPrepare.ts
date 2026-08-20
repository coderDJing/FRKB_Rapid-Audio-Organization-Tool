import path from 'node:path'
import fs from 'fs-extra'
import { collectFilesWithExtensions, runWithConcurrency } from '../nodeTaskUtils'
import { SUPPORTED_AUDIO_FORMATS } from '../../shared/audioFormats'

export type PlaylistFileStat = {
  file: string
  key: string
  size: number
  mtimeMs: number
}

/** 打开/扫描歌单时的 stat 并发上限，避免机械盘被打满。 */
export const PLAYLIST_STAT_CONCURRENCY = 8

export const normalizePlaylistPathKey = (value: string): string => {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const cleanupConversionTempFiles = async (dir: string, cleanedDirs: Set<string>) => {
  if (cleanedDirs.has(dir)) return
  cleanedDirs.add(dir)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (!name.startsWith('.') || !name.includes('.tmp.')) continue
      const matched = SUPPORTED_AUDIO_FORMATS.find((fmt) => name.toLowerCase().endsWith(`.${fmt}`))
      if (!matched) continue
      const fullPath = path.join(dir, name)
      try {
        await fs.remove(fullPath)
      } catch {}
    }
  } catch {}
}

export async function listPlaylistAudioFiles(
  scanPath: string | string[],
  audioExt: string[]
): Promise<string[]> {
  const songFileUrls: string[] = []
  const cleanedDirs = new Set<string>()
  const pathsToScan = Array.isArray(scanPath) ? scanPath : [scanPath]
  for (const filePath of pathsToScan) {
    const stats = await fs.stat(filePath)
    if (stats.isFile()) {
      await cleanupConversionTempFiles(path.dirname(filePath), cleanedDirs)
      const ext = path.extname(filePath).toLowerCase()
      if (audioExt.includes(ext)) {
        songFileUrls.push(filePath)
      }
    } else if (stats.isDirectory()) {
      await cleanupConversionTempFiles(filePath, cleanedDirs)
      const files = await collectFilesWithExtensions(filePath, audioExt)
      songFileUrls.push(...files)
    }
  }
  return songFileUrls
}

export async function statPlaylistAudioFiles(songFileUrls: string[]): Promise<PlaylistFileStat[]> {
  if (songFileUrls.length === 0) return []
  const tasks = songFileUrls.map((file) => async () => {
    const st = await fs.stat(file)
    return {
      file,
      key: normalizePlaylistPathKey(file),
      size: st.size,
      mtimeMs: st.mtimeMs
    } satisfies PlaylistFileStat
  })
  const { results } = await runWithConcurrency(tasks, { concurrency: PLAYLIST_STAT_CONCURRENCY })
  const filesStatList: PlaylistFileStat[] = []
  for (const item of results) {
    if (!item || item instanceof Error) continue
    filesStatList.push(item)
  }
  return filesStatList
}

export async function resolvePlaylistCacheRoot(scanPath: string | string[]): Promise<string> {
  const cacheBase =
    typeof scanPath === 'string' ? scanPath : Array.isArray(scanPath) ? (scanPath[0] ?? '') : ''
  if (!cacheBase) return ''
  try {
    if ((await fs.pathExists(cacheBase)) && (await fs.stat(cacheBase)).isDirectory()) {
      return cacheBase
    }
  } catch {}
  return ''
}
