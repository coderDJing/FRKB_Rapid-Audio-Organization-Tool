import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../libraryCacheDb/pathResolvers'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import { hasCurrentSongStructureAnalysis } from '../../shared/songStructure'
import {
  normalizeBeatGridAlgorithmVersion,
  shouldAcceptBeatGridCacheVersion
} from './beatGridAlgorithmVersion'

type SharedGridInfo = Partial<ISongInfo> & {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatGridSource?: unknown
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
}

export type SharedSongGridDefinition = {
  filePath: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
  timeBasisOffsetMs?: number
  beatGridSource?: 'manual' | 'analysis'
  beatGridAlgorithmVersion?: number
}

type SharedSongGridInternalDefinition = SharedSongGridDefinition & {
  beatThisWindowCount?: number
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

const normalizeBeatGridSource = (value: unknown): 'manual' | 'analysis' | undefined =>
  value === 'manual' || value === 'analysis' ? value : undefined

const normalizeBeatThisWindowCount = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

const toPublicSharedGridDefinition = (
  value: SharedSongGridInternalDefinition
): SharedSongGridDefinition => {
  const publicDefinition: SharedSongGridDefinition = { ...value }
  delete (publicDefinition as SharedSongGridInternalDefinition).beatThisWindowCount
  return publicDefinition
}

const hasSharedGridValue = (
  value: SharedSongGridInternalDefinition | null
): value is SharedSongGridInternalDefinition =>
  !!value &&
  (value.bpm !== undefined ||
    value.firstBeatMs !== undefined ||
    value.barBeatOffset !== undefined ||
    value.timeBasisOffsetMs !== undefined ||
    value.beatThisWindowCount !== undefined ||
    value.beatGridAlgorithmVersion !== undefined)

const differsWhenNextValueIsPresent = <T>(
  current: unknown,
  next: unknown,
  normalize: (value: unknown) => T | undefined
) => {
  const nextValue = normalize(next)
  if (nextValue === undefined) return false
  return normalize(current) !== nextValue
}

export const shouldKeepManualSharedSongGridDefinition = (
  current: SharedSongGridDefinition | null | undefined,
  next: SharedSongGridDefinition | null | undefined
) => {
  if (current?.beatGridSource !== 'manual' || !next) return false
  if (!shouldAcceptBeatGridCacheVersion(current)) return false
  if (next.beatGridSource === 'analysis') return true
  return (
    differsWhenNextValueIsPresent(current.bpm, next.bpm, normalizeBpm) ||
    differsWhenNextValueIsPresent(current.firstBeatMs, next.firstBeatMs, normalizeFirstBeatMs) ||
    differsWhenNextValueIsPresent(
      current.barBeatOffset,
      next.barBeatOffset,
      normalizeBarBeatOffset
    ) ||
    differsWhenNextValueIsPresent(
      current.timeBasisOffsetMs,
      next.timeBasisOffsetMs,
      normalizeTimeBasisOffsetMs
    )
  )
}

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
): SharedSongGridInternalDefinition | null => {
  if (!info) return null
  const bpm = normalizeBpm(info.bpm)
  const firstBeatMs = normalizeFirstBeatMs(info.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(info.barBeatOffset)
  const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(info.timeBasisOffsetMs)
  const beatGridSource = normalizeBeatGridSource(info.beatGridSource)
  const beatThisWindowCount = normalizeBeatThisWindowCount(info.beatThisWindowCount)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion)
  if (
    bpm === undefined &&
    firstBeatMs === undefined &&
    barBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    beatThisWindowCount === undefined &&
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
    beatGridSource,
    beatThisWindowCount,
    beatGridAlgorithmVersion
  }
}

const mergeSharedGridDefinition = (
  base: SharedSongGridInternalDefinition | null,
  next: SharedSongGridInternalDefinition | null
): SharedSongGridInternalDefinition | null => {
  if (!base) return next
  if (!next) return base
  return {
    filePath: base.filePath || next.filePath,
    bpm: next.bpm ?? base.bpm,
    firstBeatMs: next.firstBeatMs ?? base.firstBeatMs,
    barBeatOffset: next.barBeatOffset ?? base.barBeatOffset,
    timeBasisOffsetMs: next.timeBasisOffsetMs ?? base.timeBasisOffsetMs,
    beatGridSource: next.beatGridSource ?? base.beatGridSource,
    beatThisWindowCount: next.beatThisWindowCount ?? base.beatThisWindowCount,
    beatGridAlgorithmVersion: next.beatGridAlgorithmVersion ?? base.beatGridAlgorithmVersion
  }
}

export async function loadSharedSongGridDefinition(
  filePath: string
): Promise<SharedSongGridDefinition | null> {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return null

  let resolved: SharedSongGridInternalDefinition | null = null
  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (songListRoot) {
    const entry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
    resolved = mergeSharedGridDefinition(
      resolved,
      extractSharedGridFromInfo(normalizedPath, entry?.info || null)
    )
  } else {
    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const fsStat = await fs.stat(normalizedPath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {}
    const entry = await LibraryCacheDb.loadExternalAnalysisCacheEntryByFilePath(
      normalizedPath,
      stat
    )
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

  if (!hasSharedGridValue(resolved) || !shouldAcceptBeatGridCacheVersion(resolved)) {
    return null
  }
  return toPublicSharedGridDefinition(resolved)
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
  const beatGridSource = normalizeBeatGridSource(input?.beatGridSource)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
    input?.beatGridAlgorithmVersion
  )
  if (
    bpm === undefined &&
    firstBeatMs === undefined &&
    barBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    beatGridAlgorithmVersion === undefined
  ) {
    return null
  }

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!songListRoot) {
    const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(normalizedPath)
    if (!externalContext) {
      return {
        filePath: normalizedPath,
        bpm,
        firstBeatMs,
        barBeatOffset,
        timeBasisOffsetMs,
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
    const existingEntry = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, stat)
    const nextInfo = existingEntry?.info
      ? { ...existingEntry.info }
      : buildLiteSongInfo(normalizedPath)
    const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)
    if (bpm !== undefined) normalizedInfo.bpm = bpm
    if (firstBeatMs !== undefined) normalizedInfo.firstBeatMs = firstBeatMs
    if (barBeatOffset !== undefined) normalizedInfo.barBeatOffset = barBeatOffset
    if (timeBasisOffsetMs !== undefined) normalizedInfo.timeBasisOffsetMs = timeBasisOffsetMs
    if (beatGridSource !== undefined) normalizedInfo.beatGridSource = beatGridSource
    if (beatGridAlgorithmVersion !== undefined) {
      normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
    }
    stripBeatThisDebugInfo(normalizedInfo)
    if (!hasCurrentSongStructureAnalysis(normalizedInfo)) {
      delete normalizedInfo.songStructure
    }
    normalizedInfo.analysisOnly = true
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, normalizedInfo)
    return extractSharedGridFromInfo(normalizedPath, normalizedInfo)
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
  if (beatGridSource !== undefined) {
    normalizedInfo.beatGridSource = beatGridSource
  }
  if (beatGridAlgorithmVersion !== undefined) {
    normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
  }
  stripBeatThisDebugInfo(normalizedInfo)
  if (!hasCurrentSongStructureAnalysis(normalizedInfo)) {
    delete normalizedInfo.songStructure
  }

  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return extractSharedGridFromInfo(normalizedPath, normalizedInfo)
}
