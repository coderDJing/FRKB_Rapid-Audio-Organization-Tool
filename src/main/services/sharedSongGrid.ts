import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import type { SongBeatGridMap } from '../../shared/songBeatGridMap'
import * as LibraryCacheDb from '../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../libraryCacheDb/pathResolvers'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import { hasUsableSongStructureAnalysis } from '../../shared/songStructure'
import { normalizeBeatGridAlgorithmVersion } from './beatGridAlgorithmVersion'
import {
  normalizeSongBeatGridMap,
  projectSongBeatGridMapToFixedGrid
} from '../../shared/songBeatGridMap'
import { shouldAcceptSharedSongGridCache } from './sharedSongGridCachePolicy'

type SharedGridInfo = Partial<ISongInfo> & {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatGridSource?: unknown
  beatGridMap?: unknown
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
  beatGridMap?: SongBeatGridMap | null
  beatGridAlgorithmVersion?: number
}

type SharedSongGridInternalDefinition = SharedSongGridDefinition & {
  beatThisWindowCount?: number
}

export const isCompleteSharedSongGridDefinition = (
  value: SharedSongGridDefinition | null | undefined
): value is SharedSongGridDefinition =>
  !!value &&
  ((value.bpm !== undefined &&
    value.firstBeatMs !== undefined &&
    value.barBeatOffset !== undefined) ||
    normalizeSongBeatGridMap(value.beatGridMap) !== null)

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
    value.beatGridMap !== undefined ||
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
  if (normalizeSongBeatGridMap(current.beatGridMap) && next.beatGridSource === 'analysis') {
    return true
  }
  if (!isCompleteSharedSongGridDefinition(current)) return false
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
  const beatGridMap = normalizeSongBeatGridMap(info.beatGridMap)
  const beatGridProjection = projectSongBeatGridMapToFixedGrid(beatGridMap)
  const beatThisWindowCount = normalizeBeatThisWindowCount(info.beatThisWindowCount)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(info.beatGridAlgorithmVersion)
  if (
    bpm === undefined &&
    firstBeatMs === undefined &&
    barBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    !beatGridMap &&
    beatThisWindowCount === undefined &&
    beatGridAlgorithmVersion === undefined
  ) {
    return null
  }
  return {
    filePath,
    bpm: beatGridProjection?.bpm ?? bpm,
    firstBeatMs: beatGridProjection?.firstBeatMs ?? firstBeatMs,
    barBeatOffset: beatGridProjection?.barBeatOffset ?? barBeatOffset,
    timeBasisOffsetMs,
    beatGridSource: beatGridMap ? 'manual' : beatGridSource,
    beatGridMap: beatGridMap ?? undefined,
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
    beatGridMap: next.beatGridMap ?? base.beatGridMap,
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

  if (!hasSharedGridValue(resolved) || !shouldAcceptSharedSongGridCache(resolved)) {
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
  input: SharedSongGridDefinition,
  options: { shouldPersist?: () => boolean } = {}
): Promise<SharedSongGridDefinition | null> {
  const shouldPersist = () => options.shouldPersist?.() !== false
  const normalizedPath = typeof input?.filePath === 'string' ? input.filePath.trim() : ''
  if (!normalizedPath || !shouldPersist()) return null

  const hasBeatGridMapInput = Object.prototype.hasOwnProperty.call(input, 'beatGridMap')
  const beatGridMap = normalizeSongBeatGridMap(input?.beatGridMap)
  const beatGridProjection = projectSongBeatGridMapToFixedGrid(input?.beatGridMap)
  const shouldClearBeatGridMap =
    !beatGridMap && (hasBeatGridMapInput || input?.beatGridSource === 'analysis')
  const bpm = normalizeBpm(input?.bpm)
  const firstBeatMs = normalizeFirstBeatMs(input?.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(input?.barBeatOffset)
  const timeBasisOffsetMs = normalizeTimeBasisOffsetMs(input?.timeBasisOffsetMs)
  const beatGridSource =
    beatGridMap || (hasBeatGridMapInput && beatGridProjection)
      ? 'manual'
      : normalizeBeatGridSource(input?.beatGridSource)
  const beatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
    input?.beatGridAlgorithmVersion
  )
  const nextBpm = beatGridProjection?.bpm ?? bpm
  const nextFirstBeatMs = beatGridProjection?.firstBeatMs ?? firstBeatMs
  const nextBarBeatOffset = beatGridProjection?.barBeatOffset ?? barBeatOffset
  if (
    nextBpm === undefined &&
    nextFirstBeatMs === undefined &&
    nextBarBeatOffset === undefined &&
    timeBasisOffsetMs === undefined &&
    beatGridAlgorithmVersion === undefined &&
    !beatGridMap &&
    !shouldClearBeatGridMap
  ) {
    return null
  }

  const buildPersistResult = (
    info: SharedGridInfo,
    forceClearedBeatGridMap: boolean
  ): SharedSongGridDefinition | null => {
    const extracted = extractSharedGridFromInfo(normalizedPath, info)
    if (!extracted) return null
    if (beatGridMap) {
      return { ...toPublicSharedGridDefinition(extracted), beatGridMap }
    }
    if (forceClearedBeatGridMap) {
      return { ...toPublicSharedGridDefinition(extracted), beatGridMap: null }
    }
    return toPublicSharedGridDefinition(extracted)
  }

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!shouldPersist()) return null
  if (!songListRoot) {
    const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(normalizedPath)
    if (!externalContext) {
      return {
        filePath: normalizedPath,
        bpm: nextBpm,
        firstBeatMs: nextFirstBeatMs,
        barBeatOffset: nextBarBeatOffset,
        timeBasisOffsetMs,
        beatGridSource,
        beatGridMap: beatGridMap ?? (shouldClearBeatGridMap ? null : undefined),
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
    if (!shouldPersist()) return null
    const nextInfo = existingEntry?.info
      ? { ...existingEntry.info }
      : buildLiteSongInfo(normalizedPath)
    const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)
    if (nextBpm !== undefined) normalizedInfo.bpm = nextBpm
    if (nextFirstBeatMs !== undefined) normalizedInfo.firstBeatMs = nextFirstBeatMs
    if (nextBarBeatOffset !== undefined) normalizedInfo.barBeatOffset = nextBarBeatOffset
    if (timeBasisOffsetMs !== undefined) normalizedInfo.timeBasisOffsetMs = timeBasisOffsetMs
    if (beatGridSource !== undefined) normalizedInfo.beatGridSource = beatGridSource
    if (beatGridMap) {
      normalizedInfo.beatGridMap = beatGridMap
    } else if (shouldClearBeatGridMap) {
      delete normalizedInfo.beatGridMap
    }
    if (beatGridAlgorithmVersion !== undefined) {
      normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
    }
    stripBeatThisDebugInfo(normalizedInfo)
    if (!hasUsableSongStructureAnalysis(normalizedInfo)) {
      delete normalizedInfo.songStructure
    }
    normalizedInfo.analysisOnly = true
    if (!shouldPersist()) return null
    await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, normalizedInfo)
    return buildPersistResult(normalizedInfo, shouldClearBeatGridMap)
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(normalizedPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return loadSharedSongGridDefinition(normalizedPath)
  }

  const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
  if (!shouldPersist()) return null
  const nextInfo = existingEntry?.info
    ? { ...existingEntry.info }
    : buildLiteSongInfo(normalizedPath)
  const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)

  if (nextBpm !== undefined) {
    normalizedInfo.bpm = nextBpm
  }
  if (nextFirstBeatMs !== undefined) {
    normalizedInfo.firstBeatMs = nextFirstBeatMs
  }
  if (nextBarBeatOffset !== undefined) {
    normalizedInfo.barBeatOffset = nextBarBeatOffset
  }
  if (timeBasisOffsetMs !== undefined) {
    normalizedInfo.timeBasisOffsetMs = timeBasisOffsetMs
  }
  if (beatGridSource !== undefined) {
    normalizedInfo.beatGridSource = beatGridSource
  }
  if (beatGridMap) {
    normalizedInfo.beatGridMap = beatGridMap
  } else if (shouldClearBeatGridMap) {
    delete normalizedInfo.beatGridMap
  }
  if (beatGridAlgorithmVersion !== undefined) {
    normalizedInfo.beatGridAlgorithmVersion = beatGridAlgorithmVersion
  }
  stripBeatThisDebugInfo(normalizedInfo)
  if (!hasUsableSongStructureAnalysis(normalizedInfo)) {
    delete normalizedInfo.songStructure
  }

  if (!shouldPersist()) return null
  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return buildPersistResult(normalizedInfo, shouldClearBeatGridMap)
}
