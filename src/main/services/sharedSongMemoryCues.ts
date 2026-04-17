import fs from 'node:fs/promises'
import path from 'node:path'
import type { ISongInfo, ISongMemoryCue } from '../../types/globals'
import * as LibraryCacheDb from '../libraryCacheDb'
import { listMixtapeItemsByFilePath } from '../mixtapeDb'
import { findSongListRoot } from './cacheMaintenance'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'
import { normalizeSongMemoryCues } from '../../shared/memoryCues'

type SharedMemoryCueInfo = Partial<ISongInfo> & {
  memoryCues?: unknown
}

export type SharedSongMemoryCueDefinition = {
  filePath: string
  memoryCues: ISongMemoryCue[]
}

const parseInfoJson = (value: unknown): SharedMemoryCueInfo | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SharedMemoryCueInfo)
      : null
  } catch {
    return null
  }
}

const extractSharedMemoryCuesFromInfo = (
  filePath: string,
  info: SharedMemoryCueInfo | null | undefined
): SharedSongMemoryCueDefinition | null => {
  if (!info) return null
  const memoryCues = normalizeSongMemoryCues(info.memoryCues)
  if (!memoryCues.length) return null
  return {
    filePath,
    memoryCues
  }
}

const mergeSharedMemoryCueDefinition = (
  base: SharedSongMemoryCueDefinition | null,
  next: SharedSongMemoryCueDefinition | null
) => {
  if (!base) return next
  if (!next || next.memoryCues.length === 0) return base
  return next
}

export async function loadSharedSongMemoryCueDefinition(
  filePath: string
): Promise<SharedSongMemoryCueDefinition | null> {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return null

  let resolved: SharedSongMemoryCueDefinition | null = null
  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (songListRoot) {
    const entry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
    resolved = mergeSharedMemoryCueDefinition(
      resolved,
      extractSharedMemoryCuesFromInfo(normalizedPath, entry?.info || null)
    )
  }

  const mixtapeItems = listMixtapeItemsByFilePath(normalizedPath)
  for (const item of mixtapeItems) {
    resolved = mergeSharedMemoryCueDefinition(
      resolved,
      extractSharedMemoryCuesFromInfo(normalizedPath, parseInfoJson(item.infoJson))
    )
    if (resolved?.memoryCues.length) break
  }

  return resolved?.memoryCues.length ? resolved : null
}

export async function persistSharedSongMemoryCueDefinition(
  input: SharedSongMemoryCueDefinition
): Promise<SharedSongMemoryCueDefinition | null> {
  const normalizedPath = typeof input?.filePath === 'string' ? input.filePath.trim() : ''
  const memoryCues = normalizeSongMemoryCues(input?.memoryCues)
  if (!normalizedPath) return null

  const songListRoot = await findSongListRoot(path.dirname(normalizedPath))
  if (!songListRoot) {
    return {
      filePath: normalizedPath,
      memoryCues
    }
  }

  let stat: { size: number; mtimeMs: number } | null = null
  try {
    const fsStat = await fs.stat(normalizedPath)
    stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
  } catch {
    return loadSharedSongMemoryCueDefinition(normalizedPath)
  }

  const existingEntry = await LibraryCacheDb.loadSongCacheEntry(songListRoot, normalizedPath)
  const nextInfo = existingEntry?.info
    ? { ...existingEntry.info }
    : buildLiteSongInfo(normalizedPath)
  const normalizedInfo = applyLiteDefaults(nextInfo, normalizedPath)
  normalizedInfo.memoryCues = memoryCues

  await LibraryCacheDb.upsertSongCacheEntry(songListRoot, normalizedPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    info: normalizedInfo
  })

  return {
    filePath: normalizedPath,
    memoryCues
  }
}
