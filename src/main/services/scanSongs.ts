import path = require('path')
import fs = require('fs-extra')
import { collectFilesWithExtensions, operateHiddenFile, runWithConcurrency } from '../utils'
import { ISongInfo } from '../../types/globals'
import { SUPPORTED_AUDIO_FORMATS } from '../../shared/audioFormats'

// 扫描歌单目录，带 .songs.cache.json 缓存
export async function scanSongList(
  scanPath: string | string[],
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
  let songFileUrls: string[] = []
  const cleanedDirs = new Set<string>()

  const cleanupConversionTempFiles = async (dir: string) => {
    if (cleanedDirs.has(dir)) return
    cleanedDirs.add(dir)
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const name = entry.name
        // 只处理我们生成的隐藏临时文件：以 '.' 开头，包含 '.tmp.'，且以支持的格式结尾
        if (!name.startsWith('.') || !name.includes('.tmp.')) continue
        const matched = SUPPORTED_AUDIO_FORMATS.find((fmt) =>
          name.toLowerCase().endsWith(`.${fmt}`)
        )
        if (!matched) continue
        const fullPath = path.join(dir, name)
        try {
          await fs.remove(fullPath)
        } catch {}
      }
    } catch {}
  }

  // 处理混合的文件和文件夹路径
  const pathsToScan = Array.isArray(scanPath) ? scanPath : [scanPath]
  for (const filePath of pathsToScan) {
    const stats = await fs.stat(filePath)
    if (stats.isFile()) {
      // 单个文件
      await cleanupConversionTempFiles(path.dirname(filePath))
      const ext = path.extname(filePath).toLowerCase()
      if (audioExt.includes(ext)) {
        songFileUrls.push(filePath)
      }
    } else if (stats.isDirectory()) {
      // 文件夹
      await cleanupConversionTempFiles(filePath)
      const files = await collectFilesWithExtensions(filePath, audioExt)
      songFileUrls = songFileUrls.concat(files)
    }
  }
  const perfListEnd = Date.now()

  // 缓存结构
  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const cacheBase =
    typeof scanPath === 'string' ? scanPath : Array.isArray(scanPath) ? (scanPath[0] ?? '') : ''
  const cacheFile =
    cacheBase && (await fs.pathExists(cacheBase)) && (await fs.stat(cacheBase)).isDirectory()
      ? path.join(cacheBase, '.songs.cache.json')
      : ''
  let cacheMap = new Map<string, CacheEntry>()
  if (cacheFile) {
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
  }

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
      cachedInfos.push(enrichSongInfo(c.info))
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

  function computeFileMeta(
    filePath: string,
    container?: string | null
  ): { fileName: string; fileFormat: string } {
    const baseName = path.basename(filePath)
    const ext = path.extname(filePath)
    const normalizedExt = ext ? ext.slice(1).toUpperCase() : ''
    const fallbackFormat =
      typeof container === 'string' && container.trim() !== '' ? container.trim().toUpperCase() : ''
    return {
      fileName: baseName,
      fileFormat: normalizedExt || fallbackFormat
    }
  }

  function enrichSongInfo(info: ISongInfo): ISongInfo {
    const meta = computeFileMeta(info.filePath, info.container)
    const fileName =
      typeof info.fileName === 'string' && info.fileName.trim() !== ''
        ? info.fileName
        : meta.fileName
    const fileFormat =
      typeof info.fileFormat === 'string' && info.fileFormat.trim() !== ''
        ? info.fileFormat.trim().toUpperCase()
        : meta.fileFormat
    return {
      ...info,
      fileName,
      fileFormat
    }
  }

  const perfParseStart = Date.now()
  const FALLBACK_ONLY_EXTS = new Set(['.ac3', '.dts', '.tak', '.tta'])

  const tasks: Array<() => Promise<any>> = filesToParse.map((url) => async () => {
    const extLower = path.extname(url).toLowerCase()
    if (FALLBACK_ONLY_EXTS.has(extLower)) {
      const meta = computeFileMeta(url, extLower.slice(1))
      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title: meta.fileName,
        artist: undefined,
        album: undefined,
        duration: '',
        genre: undefined,
        label: undefined,
        bitrate: undefined,
        container: meta.fileFormat
      } as ISongInfo
    }
    try {
      const metadata = await mm.parseFile(url)
      const meta = computeFileMeta(url, metadata.format?.container)
      const title =
        metadata.common?.title && metadata.common.title.trim() !== ''
          ? metadata.common.title
          : meta.fileName
      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
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
    } catch (error) {
      const meta = computeFileMeta(url, undefined)
      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title: meta.fileName,
        artist: undefined,
        album: undefined,
        duration: '',
        genre: undefined,
        label: undefined,
        bitrate: undefined,
        container: meta.fileFormat
      } as ISongInfo
    }
  })
  const { results, success, failed } = await runWithConcurrency(tasks, { concurrency: 8 })
  const parsedInfos: ISongInfo[] = results
    .filter((r) => r && !(r instanceof Error))
    .map((info) => enrichSongInfo(info as ISongInfo))
  songInfoArr = [...cachedInfos, ...parsedInfos]
  const perfParseEnd = Date.now()

  // 回写缓存
  if (cacheFile) {
    try {
      const newEntries: Record<string, CacheEntry> = {}
      const infoMap = new Map<string, ISongInfo>()
      for (const info of songInfoArr) infoMap.set(info.filePath, enrichSongInfo(info))
      for (const st of filesStatList) {
        const info = infoMap.get(st.file)
        if (info) {
          newEntries[st.file] = {
            size: st.size,
            mtimeMs: st.mtimeMs,
            info: enrichSongInfo(info)
          }
        }
      }
      await fs.writeJSON(cacheFile, { entries: newEntries })
      await operateHiddenFile(cacheFile, async () => {})
    } catch {}
  }

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
