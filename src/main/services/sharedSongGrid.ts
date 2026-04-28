import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import {
  normalizeBeatGridAnalyzerProvider,
  normalizeBeatGridAlgorithmVersion,
  shouldAcceptBeatGridCacheVersion
} from './beatGridAlgorithmVersion'

type SharedGridInfo = Partial<ISongInfo> & {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatThisWindowCount?: unknown
  beatGridAnalyzerProvider?: unknown
  beatGridAlgorithmVersion?: unknown
}

export type SharedSongGridDefinition = {
  filePath: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
  timeBasisOffsetMs?: number
  beatThisWindowCount?: number
  beatGridAnalyzerProvider?: 'beatthis' | 'classic'
  beatGridAlgorithmVersion?: number
}

export const isCompleteSharedSongGridDefinition = (
  value: SharedSongGridDefinition | null | undefined
): value is SharedSongGridDefinition =>
  !!value &&
  value.bpm !== undefined &&
  value.firstBeatMs !== undefined &&
  value.barBeatOffset !== undefined &&
  shouldAcceptBeatGridCacheVersion(value)

const normalizeBpm = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Number(numeric.toFixed(6))
}

const normalizeFirstBeatMs = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return Number(numeric.toFixed(3))
}

const normalizeBarBeatOffset = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.round(numeric)
  return ((rounded % 32) + 32) % 32
}

const normalizeTimeBasisOffsetMs = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  return Number(numeric.toFixed(3))
}

const normalizeBeatThisWindowCount = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

const hasSharedGridValue = (
  value: SharedSongGridDefinition | null
): value is SharedSongGridDefinition =>
  !!value &&
  (value.bpm !== undefined ||
    value.firstBeatMs !== undefined ||
    value.barBeatOffset !== undefined ||
    value.timeBasisOffsetMs !== undefined ||
    value.beatThisWindowCount !== undefined ||
    value.beatGridAnalyzerProvider !== undefined ||
    value.beatGridAlgorithmVersion !== undefined)

const parseInfoJson = (value: unknown): SharedGridInfo | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SharedGridInfo)
      : null
  } catch {
    return null
  }
}

const extractSharedGridFromInfo = (
  filePath: string,
  info: SharedGridInfo | null | undefined
): SharedSongGridDefinition | null => {
  if (!info) return null
  const bpm = normalizeBpm(info.bpm)
  const firstBeatMs = normalizeFirstBeatMs(info.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(info.barBeatOffset)
  const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(info.timeBasisOffsetMs)
  const beatThisWindowCount = normalizeBeatThisWindowCount(info.beatThisWindowCount)
  const beatGridAnalyzerProvider = normalizeBeatGridAnalyzerProvider(info.beatGridAnalyzerProvider)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion)
  if (
    bpm === undefined &&
    firstBeatMs === undefined &&
    barBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    beatThisWindowCount === undefined &&
    beatGridAnalyzerProvider === undefined &&
    beatGridAlgorithmVersion === undefined
  ) {
    return null
  }
  return {
    filePath,
    bpm,
    firstBeatMs,
    barBeatOffset,
    timeBasisOffsetMs,
    beatThisWindowCount,
    beatGridAnalyzerProvider,
    beatGridAlgorithmVersion
  }
}

const mergeSharedGridDefinition = (
  base: SharedSongGridDefinition | null,
  next: SharedSongGridDefinition | null
): SharedSongGridDefinition | null => {
  if (!base) return next
  if (!next) return base
  return {
    filePath: base.filePath || next.filePath,
    bpm: next.bpm ?? base.bpm,
    firstBeatMs: next.firstBeatMs ?? base.firstBeatMs,
    barBeatOffset: next.barBeatOffset ?? base.barBeatOffset,
    timeBasisOffsetMs: next.timeBasisOffsetMs ?? base.timeBasisOffsetMs,
    beatThisWindowCount: next.beatThisWindowCount ?? base.beatThisWindowCount,
    beatGridAnalyzerProvider: next.beatGridAnalyzerProvider ?? base.beatGridAnalyzerProvider,
    beatGridAlgorithmVersion: next.beatGridAlgorithmVersion ?? base.beatGridAlgorithmVersion
  }
}

export async function loadSharedSongGridDefinition(
  filePath: string
): Promise<SharedSongGridDefinition | null> {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return null

  let resolved: SharedSongGridDefinition | null = null
  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (songListRoot) {
    const entry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
    resolved = mergeSharedGridDefinition(
      resolved,
      extractSharedGridFromInfo(normalizedPath, entry?.info || null)
    )
  }

  const mixtapeItems = listMixtapeItemsByFilePath(normalizedPath)
  for (const item of mixtapeItems) {
    resolved = mergeSharedGridDefinition(
      resolved,
      extractSharedGridFromInfo(normalizedPath, parseInfoJson(item.infoJson))
    )
    if (
      resolved?.bpm !== undefined &&
      resolved.firstBeatMs !== undefined &&
      resolved.barBeatOffset !== undefined
    ) {
      break
    }
  }

  return hasSharedGridValue(resolved) && shouldAcceptBeatGridCacheVersion(resolved)
    ? resolved
    : null
}

export async function loadSharedSongGridDefinitions(filePaths: string[]) {
  const resultMap = new Map<string, SharedSongGridDefinition>()
  const uniquePaths = Array.from(
    new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .filter((filePath) => typeof filePath === 'string')
        .map((filePath) => filePath.trim())
        .filter(Boolean)
    )
  )
  if (uniquePaths.length === 0) return resultMap

  const results = await Promise.all(
    uniquePaths.map(
      async (filePath) => [filePath, await loadSharedSongGridDefinition(filePath)] as const
    )
  )
  for (const [filePath, value] of results) {
    if (!isCompleteSharedSongGridDefinition(value)) continue
    resultMap.set(filePath, value)
  }
  return resultMap
}

export async function persistSharedSongGridDefinition(
  input: SharedSongGridDefinition
): Promise<SharedSongGridDefinition | null> {
  const normalizedPath = typeof input?.filePath === 'string' ? input.filePath.trim() : ''
  if (!normalizedPath) return null

  const bpm = normalizeBpm(input?.bpm)
  const firstBeatMs = normalizeFirstBeatMs(input?.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(input?.barBeatOffset)
  const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(input?.timeBasisOffsetMs)
  const beatThisWindowCount = normalizeBeatThisWindowCount(input?.beatThisWindowCount)
  const beatGridAnalyzerProvider = normalizeBeatGridAnalyzerProvider(
    input?.beatGridAnalyzerProvider
  )
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
    input?.beatGridAlgorithmVersion
  )
  if (
    bpm === undefined &&
    firstBeatMs === undefined &&
    barBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    beatThisWindowCount === undefined &&
    beatGridAnalyzerProvider === undefined &&
    beatGridAlgorithmVersion === undefined
  ) {
    return null
  }

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!songListRoot) {
    return {
      filePath: normalizedPath,
      bpm,
      firstBeatMs,
      barBeatOffset,
      timeBasisOffsetMs,
      beatThisWindowCount,
      beatGridAnalyzerProvider,
      beatGridAlgorithmVersion
    }
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(normalizedPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return loadSharedSongGridDefinition(normalizedPath)
  }

  const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
  const nextInfo = existingEntry?.info
    ? { ...existingEntry.info }
    : buildLiteSongInfo(normalizedPath)
  const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)

  if (bpm !== undefined) {
    normalizedInfo.bpm = bpm
  }
  if (firstBeatMs !== undefined) {
    normalizedInfo.firstBeatMs = firstBeatMs
  }
  if (barBeatOffset !== undefined) {
    normalizedInfo.barBeatOffset = barBeatOffset
  }
  if (timeBasisOffsetMs !== undefined) {
    normalizedInfo.timeBasisOffsetMs = timeBasisOffsetMs
  }
  if (beatThisWindowCount !== undefined) {
    normalizedInfo.beatThisWindowCount = beatThisWindowCount
  }
  if (beatGridAnalyzerProvider !== undefined) {
    normalizedInfo.beatGridAnalyzerProvider = beatGridAnalyzerProvider
  }
  if (beatGridAlgorithmVersion !== undefined) {
    normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
  }

  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return extractSharedGridFromInfo(normalizedPath, normalizedInfo)
}
