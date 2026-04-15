import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongHotCue, ISongInfo } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import { normalizeSongHotCues } from '../../shared/hotCues'

type SharedHotCueInfo = Partial<ISongInfo> & {
  hotCues?: unknown
}

export type SharedSongHotCueDefinition = {
  filePath: string
  hotCues: ISongHotCue[]
}

const parseInfoJson = (value: unknown): SharedHotCueInfo | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SharedHotCueInfo)
      : null
  } catch {
    return null
  }
}

const extractSharedHotCuesFromInfo = (
  filePath: string,
  info: SharedHotCueInfo | null | undefined
): SharedSongHotCueDefinition | null => {
  if (!info) return null
  const hotCues = normalizeSongHotCues(info.hotCues)
  if (!hotCues.length) return null
  return {
    filePath,
    hotCues
  }
}

const mergeSharedHotCueDefinition = (
  base: SharedSongHotCueDefinition | null,
  next: SharedSongHotCueDefinition | null
) => {
  if (!base) return next
  if (!next || next.hotCues.length === 0) return base
  return next
}

export async function loadSharedSongHotCueDefinition(
  filePath: string
): Promise<SharedSongHotCueDefinition | null> {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return null

  let resolved: SharedSongHotCueDefinition | null = null
  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (songListRoot) {
    const entry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
    resolved = mergeSharedHotCueDefinition(
      resolved,
      extractSharedHotCuesFromInfo(normalizedPath, entry?.info || null)
    )
  }

  const mixtapeItems = listMixtapeItemsByFilePath(normalizedPath)
  for (const item of mixtapeItems) {
    resolved = mergeSharedHotCueDefinition(
      resolved,
      extractSharedHotCuesFromInfo(normalizedPath, parseInfoJson(item.infoJson))
    )
    if (resolved?.hotCues.length) break
  }

  return resolved?.hotCues.length ? resolved : null
}

export async function persistSharedSongHotCueDefinition(
  input: SharedSongHotCueDefinition
): Promise<SharedSongHotCueDefinition | null> {
  const normalizedPath = typeof input?.filePath === 'string' ? input.filePath.trim() : ''
  const hotCues = normalizeSongHotCues(input?.hotCues)
  if (!normalizedPath) return null

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!songListRoot) {
    return {
      filePath: normalizedPath,
      hotCues
    }
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(normalizedPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return loadSharedSongHotCueDefinition(normalizedPath)
  }

  const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
  const nextInfo = existingEntry?.info
    ? { ...existingEntry.info }
    : buildLiteSongInfo(normalizedPath)
  const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)
  normalizedInfo.hotCues = hotCues

  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return {
    filePath: normalizedPath,
    hotCues
  }
}
