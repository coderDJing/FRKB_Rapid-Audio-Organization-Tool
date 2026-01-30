import path = require('path')
import fs = require('fs-extra')
import { collectFilesWithExtensions, runWithConcurrency } from '../utils'
import { ISongInfo } from '../../types/globals'
import { SUPPORTED_AUDIO_FORMATS } from '../../shared/audioFormats'
import { readWavRiffInfoWindows } from './wavRiffInfo'
import * as LibraryCacheDb from '../libraryCacheDb'
import { enqueueKeyAnalysisList } from './keyAnalysisQueue'
import { sweepSongListCovers } from './covers'

// 扫描歌单目录，带 SQLite 缓存
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

  const normalizePathKey = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  // 缓存结构
  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const cacheBase =
    typeof scanPath === 'string' ? scanPath : Array.isArray(scanPath) ? (scanPath[0] ?? '') : ''
  const cacheRoot =
    cacheBase && (await fs.pathExists(cacheBase)) && (await fs.stat(cacheBase)).isDirectory()
      ? cacheBase
      : ''
  let cacheMap = new Map<string, CacheEntry>()
  let cacheFromDb = false
  if (cacheRoot) {
    const dbCache = await LibraryCacheDb.loadSongCache(cacheRoot)
    if (dbCache) {
      if (process.platform === 'win32') {
        const normalizedMap = new Map<string, CacheEntry>()
        for (const [filePath, entry] of dbCache) {
          normalizedMap.set(normalizePathKey(filePath), entry)
        }
        cacheMap = normalizedMap
      } else {
        cacheMap = dbCache
      }
      cacheFromDb = true
    }
  }

  const perfCacheCheckStart = Date.now()
  const filesStatList: Array<{ file: string; key: string; size: number; mtimeMs: number }> = []
  for (const file of songFileUrls) {
    try {
      const st = await fs.stat(file)
      filesStatList.push({ file, key: normalizePathKey(file), size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // ignore stat error
    }
  }
  const cachedInfos: ISongInfo[] = []
  const filesToParse: string[] = []
  const analysisOnlyByPath = new Map<string, { key?: string; bpm?: number }>()
  const isAnalysisOnly = (info?: ISongInfo | null): boolean => Boolean(info?.analysisOnly)
  for (const it of filesStatList) {
    const c = cacheMap.get(it.key)
    if (c && c.size === it.size && Math.abs(c.mtimeMs - it.mtimeMs) < 1) {
      if (isAnalysisOnly(c.info)) {
        analysisOnlyByPath.set(it.key, { key: c.info.key, bpm: c.info.bpm })
        filesToParse.push(it.file)
      } else {
        cachedInfos.push(enrichSongInfo({ ...c.info, filePath: it.file }))
      }
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

  const hasKey = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
  const hasBpm = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value > 0

  if (cacheFromDb && cacheRoot && cacheMap.size > 0 && filesStatList.length > 0) {
    for (const st of filesStatList) {
      const entry = cacheMap.get(st.key)
      if (!entry || !entry.info) continue
      const missingKeyBpm = !hasKey(entry.info.key) || !hasBpm(entry.info.bpm)
      if (!missingKeyBpm) continue
      const refreshed = await LibraryCacheDb.loadSongCacheEntry(cacheRoot, st.file)
      if (refreshed?.info) {
        cacheMap.set(st.key, refreshed)
        if (refreshed.info.analysisOnly) {
          analysisOnlyByPath.set(st.key, { key: refreshed.info.key, bpm: refreshed.info.bpm })
        }
      }
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
      let title =
        metadata.common?.title && metadata.common.title.trim() !== ''
          ? metadata.common.title
          : meta.fileName
      let artist = metadata.common?.artist
      let album = metadata.common?.album
      let genre = metadata.common?.genre?.[0]

      // Windows + WAV：用 LIST/INFO 覆盖明显异常的 common 值（如 '0!0!0!' 或夹杂 \x00）
      if (process.platform === 'win32' && extLower === '.wav') {
        try {
          const info = await readWavRiffInfoWindows(url)
          if (info) {
            const containsNull = (s: string | undefined) =>
              typeof s === 'string' && s.includes('\x00')
            const asciiOnly = (s: string | undefined) =>
              typeof s === 'string' && /^[\x00-\x7F]+$/.test(s)
            const prefer = (primary?: string, fallback?: string) => {
              const p = typeof primary === 'string' ? primary.trim() : ''
              const f = typeof fallback === 'string' ? fallback.trim() : ''
              if (f && (!p || containsNull(primary) || asciiOnly(p))) return f
              return p || f
            }
            title = prefer(title, info.title) || meta.fileName
            artist = prefer(artist, info.artist)
            album = prefer(album, info.album)
            genre = genre && !containsNull(genre) ? genre : info.genre || genre
          }
        } catch {}
      }

      return {
        filePath: url,
        fileName: meta.fileName,
        fileFormat: meta.fileFormat,
        cover: null,
        title,
        artist,
        album,
        duration: convertSecondsToMinutesSeconds(
          metadata.format.duration === undefined ? 0 : Math.round(metadata.format.duration)
        ),
        genre,
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
  if (analysisOnlyByPath.size > 0) {
    for (const info of parsedInfos) {
      const cached = analysisOnlyByPath.get(normalizePathKey(info.filePath))
      if (!cached) continue
      if (!hasKey(info.key) && hasKey(cached.key)) {
        info.key = cached.key as string
      }
      if (!hasBpm(info.bpm) && hasBpm(cached.bpm)) {
        info.bpm = cached.bpm as number
      }
    }
  }
  songInfoArr = [...cachedInfos, ...parsedInfos]

  // Windows 下 WAV：对缓存与新解析的结果做一次统一修正，避免列表残留 '0!0!0!' 或含 \x00 的值
  if (process.platform === 'win32') {
    const refined = await Promise.all(
      songInfoArr.map(async (info) => {
        try {
          if (path.extname(info.filePath).toLowerCase() !== '.wav') return info
          const suspicious = (s?: string) =>
            typeof s === 'string' && (s.includes('\x00') || s === '0!0!0!')
          const needFix =
            suspicious(info.title) ||
            suspicious(info.artist) ||
            suspicious(info.album) ||
            suspicious(info.genre)
          if (!needFix) return info
          const ri = await readWavRiffInfoWindows(info.filePath).catch(() => null)
          if (!ri) return info
          const pick = (primary?: string, fallback?: string) => {
            const p = typeof primary === 'string' ? primary.trim() : ''
            const f = typeof fallback === 'string' ? fallback.trim() : ''
            if (!p || suspicious(p)) return f || p
            return p
          }
          return {
            ...info,
            title: pick(info.title, ri.title) || info.title,
            artist: pick(info.artist, ri.artist) || info.artist,
            album: pick(info.album, ri.album) || info.album,
            genre: pick(info.genre, ri.genre) || info.genre
          }
        } catch {
          return info
        }
      })
    )
    songInfoArr = refined
  }
  const perfParseEnd = Date.now()

  // 回写缓存
  if (cacheRoot) {
    try {
      const infoMap = new Map<string, ISongInfo>()
      for (const info of songInfoArr) {
        infoMap.set(normalizePathKey(info.filePath), enrichSongInfo(info))
      }
      const newEntriesMap = new Map<string, CacheEntry>()
      for (const st of filesStatList) {
        const info = infoMap.get(st.key)
        if (!info) continue
        const nextInfo = { ...info }
        const cached = cacheMap.get(st.key)
        if (cached?.info) {
          if (!hasKey(nextInfo.key) && hasKey(cached.info.key)) {
            nextInfo.key = cached.info.key as string
          }
          if (!hasBpm(nextInfo.bpm) && hasBpm(cached.info.bpm)) {
            nextInfo.bpm = cached.info.bpm as number
          }
          if (nextInfo.analysisOnly === undefined && cached.info.analysisOnly) {
            nextInfo.analysisOnly = true
          }
        }
        newEntriesMap.set(st.file, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          info: enrichSongInfo(nextInfo)
        })
      }
      if (cacheFromDb) {
        await LibraryCacheDb.replaceSongCache(cacheRoot, newEntriesMap)
      }
    } catch {}
  }

  if (cacheRoot && songInfoArr.length > 0) {
    const pendingKeys = songInfoArr
      .filter((info) => !hasKey(info.key) || !hasBpm(info.bpm))
      .map((info) => info.filePath)
      .filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0)
    if (pendingKeys.length > 0) {
      enqueueKeyAnalysisList(pendingKeys, 'low')
    }
  }

  // 扫描完成后自动清理孤立的封面文件
  if (cacheRoot) {
    const currentFilePaths = songInfoArr.map((info) => info.filePath)
    // 异步执行封面清理，不阻塞返回结果
    sweepSongListCovers(cacheRoot, currentFilePaths).catch(() => {})
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
