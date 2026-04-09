import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'

export type SharedSongGridDefinition = {
  filePath: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
}

export const isCompleteSharedSongGridDefinition = (
  value: SharedSongGridDefinition | null | undefined
): value is SharedSongGridDefinition =>
  !!value &&
  value.bpm !== undefined &&
  value.firstBeatMs !== undefined &&
  value.barBeatOffset !== undefined

const normalizeBpm = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Number(numeric.toFixed(6))
}

const normalizeFirstBeatMs = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return undefined
  return Number(numeric.toFixed(3))
}

const normalizeBarBeatOffset = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.round(numeric)
  return ((rounded % 32) + 32) % 32
}

const hasSharedGridValue = (
  value: SharedSongGridDefinition | null
): value is SharedSongGridDefinition =>
  !!value &&
  (value.bpm !== undefined || value.firstBeatMs !== undefined || value.barBeatOffset !== undefined)

const parseInfoJson = (value: unknown): Record<string, any> | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const extractSharedGridFromInfo = (
  filePath: string,
  info: Partial<ISongInfo> | Record<string, any> | null | undefined
): SharedSongGridDefinition | null => {
  if (!info) return null
  const bpm = normalizeBpm((info as any).bpm)
  const firstBeatMs = normalizeFirstBeatMs((info as any).firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset((info as any).barBeatOffset)
  if (bpm === undefined && firstBeatMs === undefined && barBeatOffset === undefined) {
    return null
  }
  return {
    filePath,
    bpm,
    firstBeatMs,
    barBeatOffset
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
    barBeatOffset: next.barBeatOffset ?? base.barBeatOffset
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

  return hasSharedGridValue(resolved) ? resolved : null
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
  if (bpm === undefined && firstBeatMs === undefined && barBeatOffset === undefined) {
    return null
  }

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!songListRoot) {
    return {
      filePath: normalizedPath,
      bpm,
      firstBeatMs,
      barBeatOffset
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

  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return extractSharedGridFromInfo(normalizedPath, normalizedInfo)
}
