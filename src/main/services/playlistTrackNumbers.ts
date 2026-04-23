import fs from 'node:fs/promises'
import path from 'node:path'
import store from '../store'
import { getCoreFsDirName } from '../utils'
import { collectFilesWithExtensions } from '../nodeTaskUtils'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { SongCacheEntry } from '../libraryCacheDb/types'
import type { ISongInfo } from '../../types/globals'
import { buildLiteSongInfo, applyLiteDefaults } from './songInfoLite'

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export type PlaylistTrackNumberEnsureResult = {
  changed: boolean
  initialized: boolean
  repaired: boolean
}

const normalizePath = (value: string) => {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const normalizePlaylistTrackNumber = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.floor(numeric)
  if (rounded <= 0) return undefined
  return rounded
}

const compareStableFilePath = (listRoot: string, leftPath: string, rightPath: string) => {
  const leftRelative = path.relative(listRoot, leftPath).replace(/\\/g, '/')
  const rightRelative = path.relative(listRoot, rightPath).replace(/\\/g, '/')
  const relativeCompare = collator.compare(leftRelative, rightRelative)
  if (relativeCompare !== 0) return relativeCompare
  const leftName = path.basename(leftPath)
  const rightName = path.basename(rightPath)
  const nameCompare = collator.compare(leftName, rightName)
  if (nameCompare !== 0) return nameCompare
  return collator.compare(leftPath, rightPath)
}

const compareStableSong = (listRoot: string, left: ISongInfo, right: ISongInfo) =>
  compareStableFilePath(listRoot, left.filePath, right.filePath)

const isSupportedPlaylistTrackNumberListRoot = (listRoot: string) => {
  const dbRoot = String(store.databaseDir || '').trim()
  if (!dbRoot || !listRoot) return false
  const resolvedListRoot = normalizePath(listRoot)
  const coreRoots = [
    path.join(dbRoot, 'library', getCoreFsDirName('FilterLibrary')),
    path.join(dbRoot, 'library', getCoreFsDirName('CuratedLibrary'))
  ].map((item) => normalizePath(item))
  return coreRoots.some(
    (rootPath) =>
      resolvedListRoot === rootPath || resolvedListRoot.startsWith(`${rootPath}${path.sep}`)
  )
}

const hasContinuousTrackNumbers = (songs: ISongInfo[]) => {
  if (songs.length === 0) return true
  const numbers = songs.map((song) => normalizePlaylistTrackNumber(song.playlistTrackNumber))
  if (numbers.some((value) => value === undefined)) return false
  const normalized = numbers as number[]
  const unique = new Set(normalized)
  if (unique.size !== songs.length) return false
  const max = Math.max(...normalized)
  const min = Math.min(...normalized)
  return min === 1 && max === songs.length
}

const buildRepairOrder = (songs: ISongInfo[], listRoot: string) =>
  [...songs].sort((left, right) => {
    const leftNumber = normalizePlaylistTrackNumber(left.playlistTrackNumber)
    const rightNumber = normalizePlaylistTrackNumber(right.playlistTrackNumber)
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    return compareStableSong(listRoot, left, right)
  })

export const ensurePlaylistTrackNumbers = (
  songs: ISongInfo[],
  listRoot: string
): PlaylistTrackNumberEnsureResult => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot) || songs.length === 0) {
    return { changed: false, initialized: false, repaired: false }
  }
  const numberedCount = songs.filter(
    (song) => normalizePlaylistTrackNumber(song.playlistTrackNumber) !== undefined
  ).length
  if (numberedCount === songs.length && hasContinuousTrackNumbers(songs)) {
    return { changed: false, initialized: false, repaired: false }
  }

  const orderedSongs =
    numberedCount <= 0
      ? [...songs].sort((left, right) => compareStableSong(listRoot, left, right))
      : buildRepairOrder(songs, listRoot)

  let changed = false
  orderedSongs.forEach((song, index) => {
    const nextNumber = index + 1
    if (normalizePlaylistTrackNumber(song.playlistTrackNumber) !== nextNumber) {
      changed = true
    }
    song.playlistTrackNumber = nextNumber
  })

  return {
    changed,
    initialized: numberedCount <= 0 && changed,
    repaired: numberedCount > 0 && changed
  }
}

export const sortSongsByPlaylistTrackNumber = (songs: ISongInfo[], listRoot: string) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) return [...songs]
  return [...songs].sort((left, right) => {
    const leftNumber = normalizePlaylistTrackNumber(left.playlistTrackNumber)
    const rightNumber = normalizePlaylistTrackNumber(right.playlistTrackNumber)
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    return compareStableSong(listRoot, left, right)
  })
}

const uniqueExistingFiles = async (listRoot: string) => {
  const files = await collectFilesWithExtensions(listRoot, store.settingConfig.audioExt || [])
  const normalizedByPath = new Map<string, string>()
  for (const filePath of files) {
    const resolved = path.resolve(filePath)
    const key = normalizePath(resolved)
    if (!normalizedByPath.has(key)) {
      normalizedByPath.set(key, resolved)
    }
  }
  return [...normalizedByPath.values()]
}

const resolveExistingOrder = (
  currentFiles: string[],
  cacheMapByNormalizedPath: Map<string, SongCacheEntry>,
  listRoot: string
) =>
  [...currentFiles].sort((leftPath, rightPath) => {
    const leftInfo = cacheMapByNormalizedPath.get(normalizePath(leftPath))?.info
    const rightInfo = cacheMapByNormalizedPath.get(normalizePath(rightPath))?.info
    const leftNumber = normalizePlaylistTrackNumber(leftInfo?.playlistTrackNumber)
    const rightNumber = normalizePlaylistTrackNumber(rightInfo?.playlistTrackNumber)
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    return compareStableFilePath(listRoot, leftPath, rightPath)
  })

const buildEntryForFile = async (
  filePath: string,
  entry: SongCacheEntry | undefined,
  playlistTrackNumber: number
): Promise<[string, SongCacheEntry] | null> => {
  try {
    const stat = await fs.stat(filePath)
    const nextInfo = entry?.info
      ? applyLiteDefaults({ ...entry.info }, filePath)
      : buildLiteSongInfo(filePath)
    nextInfo.filePath = filePath
    nextInfo.playlistTrackNumber = playlistTrackNumber
    return [
      filePath,
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: nextInfo
      }
    ]
  } catch {
    return null
  }
}

const persistSongListTrackNumberOrder = async (listRoot: string, finalOrder: string[]) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = new Map(
    [...cacheMap.entries()].map(([filePath, entry]) => [normalizePath(filePath), entry] as const)
  )
  const nextEntries = new Map<string, SongCacheEntry>()
  for (let index = 0; index < finalOrder.length; index += 1) {
    const filePath = finalOrder[index]
    const resolved = await buildEntryForFile(
      filePath,
      cacheMapByNormalizedPath.get(normalizePath(filePath)),
      index + 1
    )
    if (!resolved) continue
    nextEntries.set(resolved[0], resolved[1])
  }
  const updated = await LibraryCacheDb.replaceSongCache(listRoot, nextEntries)
  return { updated, total: nextEntries.size }
}

export const setSongListTrackNumbersByOrder = async (params: {
  listRoot: string
  orderedFilePaths: string[]
}) => {
  const { listRoot, orderedFilePaths } = params
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const currentFileMap = new Map(
    currentFiles.map((filePath) => [normalizePath(filePath), filePath])
  )
  const orderedUnique: string[] = []
  const seen = new Set<string>()
  for (const item of orderedFilePaths || []) {
    const filePath = currentFileMap.get(normalizePath(item))
    if (!filePath) continue
    const key = normalizePath(filePath)
    if (seen.has(key)) continue
    seen.add(key)
    orderedUnique.push(filePath)
  }
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = new Map(
    [...cacheMap.entries()].map(([filePath, entry]) => [normalizePath(filePath), entry] as const)
  )
  const existingOrder = resolveExistingOrder(currentFiles, cacheMapByNormalizedPath, listRoot)
  const remaining = existingOrder.filter((filePath) => !seen.has(normalizePath(filePath)))
  const finalOrder = [...orderedUnique, ...remaining]
  const persisted = await persistSongListTrackNumberOrder(listRoot, finalOrder)
  const persistedCache =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const persistedCacheByNormalizedPath = new Map(
    [...persistedCache.entries()].map(
      ([filePath, entry]) => [normalizePath(filePath), entry] as const
    )
  )
  const persistedSample = finalOrder.slice(0, 5).map((filePath, index) => {
    const entry = persistedCacheByNormalizedPath.get(normalizePath(filePath))
    return {
      expectedNumber: index + 1,
      persistedNumber: normalizePlaylistTrackNumber(entry?.info?.playlistTrackNumber) || null,
      filePath
    }
  })
  const mismatch = persistedSample.find((item) => item.expectedNumber !== item.persistedNumber)
  if (mismatch) {
    throw new Error('真实序号写入后校验失败')
  }
  return persisted
}

export const appendSongListTrackNumbers = async (params: {
  listRoot: string
  appendedFilePaths: string[]
}) => {
  const { listRoot, appendedFilePaths } = params
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const currentFileMap = new Map(
    currentFiles.map((filePath) => [normalizePath(filePath), filePath])
  )
  const appendedUnique: string[] = []
  const appendedSet = new Set<string>()
  for (const item of appendedFilePaths || []) {
    const filePath = currentFileMap.get(normalizePath(item))
    if (!filePath) continue
    const key = normalizePath(filePath)
    if (appendedSet.has(key)) continue
    appendedSet.add(key)
    appendedUnique.push(filePath)
  }
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = new Map(
    [...cacheMap.entries()].map(([filePath, entry]) => [normalizePath(filePath), entry] as const)
  )
  const remainingExisting = resolveExistingOrder(
    currentFiles.filter((filePath) => !appendedSet.has(normalizePath(filePath))),
    cacheMapByNormalizedPath,
    listRoot
  )
  return await persistSongListTrackNumberOrder(listRoot, [...remainingExisting, ...appendedUnique])
}

export const compactSongListTrackNumbers = async (listRoot: string) => {
  if (!isSupportedPlaylistTrackNumberListRoot(listRoot)) {
    return { updated: false, total: 0 }
  }
  const currentFiles = await uniqueExistingFiles(listRoot)
  const cacheMap =
    (await LibraryCacheDb.loadSongCache(listRoot)) || new Map<string, SongCacheEntry>()
  const cacheMapByNormalizedPath = new Map(
    [...cacheMap.entries()].map(([filePath, entry]) => [normalizePath(filePath), entry] as const)
  )
  const existingOrder = resolveExistingOrder(currentFiles, cacheMapByNormalizedPath, listRoot)
  return await persistSongListTrackNumberOrder(listRoot, existingOrder)
}

export { isSupportedPlaylistTrackNumberListRoot }
