import path = require('path')
import fs = require('fs-extra')
import { collectFilesWithExtensions, operateHiddenFile, runWithConcurrency } from '../utils'
import { ISongInfo } from '../../types/globals'

// 扫描歌单目录，带 .songs.cache.json 缓存
export async function scanSongList(
  scanPath: string,
  audioExt: string[],
  songListUUID: string
): Promise<{
  scanData: ISongInfo[]
  songListUUID: string
  perf: {
    listFilesMs: number
    cacheCheckMs: number
    parseMetadataMs: number
    totalMs: number
    filesCount: number
    successCount: number
    failedCount: number
    cacheHits: number
    parsedCount: number
  }
}> {
  const perfAllStart = Date.now()
  const perfListStart = Date.now()
  const mm = await import('music-metadata')
  let songInfoArr: ISongInfo[] = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, audioExt)
  const perfListEnd = Date.now()

  // 缓存结构
  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const cacheFile = path.join(scanPath, '.songs.cache.json')
  let cacheMap = new Map<string, CacheEntry>()
  try {
    if (await fs.pathExists(cacheFile)) {
      const json = await fs.readJSON(cacheFile)
      if (json && typeof json === 'object') {
        const entries = (json.entries || {}) as Record<string, CacheEntry>
        for (const [k, v] of Object.entries(entries)) {
          if (v && typeof v.size === 'number' && typeof v.mtimeMs === 'number' && v.info) {
            cacheMap.set(k, v)
          }
        }
      }
    }
  } catch {}

  const perfCacheCheckStart = Date.now()
  const filesStatList: Array<{ file: string; size: number; mtimeMs: number }> = []
  for (const file of songFileUrls) {
    try {
      const st = await fs.stat(file)
      filesStatList.push({ file, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // ignore stat error
    }
  }
  const cachedInfos: ISongInfo[] = []
  const filesToParse: string[] = []
  for (const it of filesStatList) {
    const c = cacheMap.get(it.file)
    if (c && c.size === it.size && Math.abs(c.mtimeMs - it.mtimeMs) < 1) {
      cachedInfos.push(c.info)
    } else {
      filesToParse.push(it.file)
    }
  }
  const perfCacheCheckEnd = Date.now()

  function convertSecondsToMinutesSeconds(seconds: number) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')
    return `${minutesStr}:${secondsStr}`
  }

  const perfParseStart = Date.now()
  const tasks: Array<() => Promise<any>> = filesToParse.map((url) => async () => {
    try {
      const metadata = await mm.parseFile(url)
      const title =
        metadata.common?.title && metadata.common.title.trim() !== ''
          ? metadata.common.title
          : path.basename(url)
      return {
        filePath: url,
        cover: null,
        title,
        artist: metadata.common?.artist,
        album: metadata.common?.album,
        duration: convertSecondsToMinutesSeconds(
          metadata.format.duration === undefined ? 0 : Math.round(metadata.format.duration)
        ),
        genre: metadata.common?.genre?.[0],
        label: metadata.common?.label?.[0],
        bitrate: metadata.format?.bitrate,
        container: metadata.format?.container
      } as ISongInfo
    } catch (_e) {
      return new Error('parse-failed')
    }
  })
  const { results, success, failed } = await runWithConcurrency(tasks, { concurrency: 8 })
  const parsedInfos: ISongInfo[] = results.filter((r) => r && !(r instanceof Error))
  songInfoArr = [...cachedInfos, ...parsedInfos]
  const perfParseEnd = Date.now()

  // 回写缓存
  try {
    const newEntries: Record<string, CacheEntry> = {}
    const infoMap = new Map<string, ISongInfo>()
    for (const info of songInfoArr) infoMap.set(info.filePath, info)
    for (const st of filesStatList) {
      const info = infoMap.get(st.file)
      if (info) newEntries[st.file] = { size: st.size, mtimeMs: st.mtimeMs, info }
    }
    await fs.writeJSON(cacheFile, { entries: newEntries })
    await operateHiddenFile(cacheFile, async () => {})
  } catch {}

  const perfAllEnd = Date.now()
  return {
    scanData: songInfoArr,
    songListUUID,
    perf: {
      listFilesMs: perfListEnd - perfListStart,
      cacheCheckMs: perfCacheCheckEnd - perfCacheCheckStart,
      parseMetadataMs: perfParseEnd - perfParseStart,
      totalMs: perfAllEnd - perfAllStart,
      filesCount: songFileUrls.length,
      successCount: success,
      failedCount: failed,
      cacheHits: cachedInfos.length,
      parsedCount: parsedInfos.length
    }
  }
}

export default {
  scanSongList
}
