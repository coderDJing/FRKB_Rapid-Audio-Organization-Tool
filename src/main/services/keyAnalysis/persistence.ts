import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import type { ISongInfo } from '../../../types/globals'
import type { MixxxWaveformData } from '../../waveformCache'
import {
  isValidBpm,
  isValidKeyText,
  normalizePath,
  type BpmAnalysisResult,
  type DoneEntry,
  type KeyAnalysisJob,
  type KeyAnalysisResult
} from './types'

type KeyAnalysisPersistenceDeps = {
  doneByPath: Map<string, DoneEntry>
  events: EventEmitter
}

export const createKeyAnalysisPersistence = (deps: KeyAnalysisPersistenceDeps) => {
  const ensureSongCacheEntry = async (
    listRoot: string,
    filePath: string,
    payload: { keyText?: string; bpm?: number },
    stat?: { size: number; mtimeMs: number }
  ) => {
    if (!listRoot || !filePath) return
    let fileStat = stat
    if (!fileStat) {
      try {
        const fsStat = await fs.stat(filePath)
        fileStat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
      } catch {
        return
      }
    }
    let entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
    let info: ISongInfo
    if (entry && entry.info) {
      info = { ...entry.info }
    } else {
      info = buildLiteSongInfo(filePath)
    }
    info = applyLiteDefaults(info, filePath)
    const markAnalysisOnly = !entry || Boolean(entry.info?.analysisOnly)
    if (markAnalysisOnly) {
      info.analysisOnly = true
    }
    if (payload.keyText) {
      info.key = payload.keyText
    }
    if (payload.bpm !== undefined) {
      info.bpm = payload.bpm
    }
    await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      info
    })
  }

  const persistKey = async (filePath: string, keyText: string) => {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText,
        bpm: existing?.bpm,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const updated = await LibraryCacheDb.updateSongCacheKey(listRoot, filePath, keyText)
        if (!updated) {
          await ensureSongCacheEntry(
            listRoot,
            filePath,
            { keyText },
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
      }

      const payload: KeyAnalysisResult = { filePath, keyText }
      deps.events.emit('key-updated', payload)
    } catch {
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText,
        bpm: existing?.bpm,
        hasWaveform: existing?.hasWaveform
      })
      const payload: KeyAnalysisResult = { filePath, keyText }
      deps.events.emit('key-updated', payload)
    }
  }

  const persistBpm = async (filePath: string, bpm: number) => {
    const normalizedPath = normalizePath(filePath)
    const normalizedBpm = Number(bpm.toFixed(2))
    try {
      const stat = await fs.stat(filePath)
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const updated = await LibraryCacheDb.updateSongCacheBpm(listRoot, filePath, normalizedBpm)
        if (!updated) {
          await ensureSongCacheEntry(
            listRoot,
            filePath,
            { bpm: normalizedBpm },
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
      }

      const payload: BpmAnalysisResult = { filePath, bpm: normalizedBpm }
      deps.events.emit('bpm-updated', payload)
    } catch {
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        hasWaveform: existing?.hasWaveform
      })
      const payload: BpmAnalysisResult = { filePath, bpm: normalizedBpm }
      deps.events.emit('bpm-updated', payload)
    }
  }

  const persistWaveform = async (filePath: string, waveformData: MixxxWaveformData) => {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        bpm: existing?.bpm,
        hasWaveform: true
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        if (!cached) {
          await ensureSongCacheEntry(
            listRoot,
            filePath,
            {},
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
        await LibraryCacheDb.upsertWaveformCacheEntry(
          listRoot,
          filePath,
          { size: stat.size, mtimeMs: stat.mtimeMs },
          waveformData
        )
      }
    } catch {
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: existing?.bpm,
        hasWaveform: true
      })
    }
  }

  const handleMissingFile = async (filePath: string) => {
    try {
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
      }
    } catch {}
  }

  const prepareJob = async (job: KeyAnalysisJob): Promise<boolean> => {
    const filePath = job.filePath
    let stat: { size: number; mtimeMs: number }
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      await handleMissingFile(job.filePath)
      return false
    }

    let needsKey = true
    let needsBpm = true
    let needsWaveform = true
    const done = deps.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      if (isValidKeyText(done.keyText)) {
        needsKey = false
      }
      if (isValidBpm(done.bpm)) {
        needsBpm = false
      }
      if (done.hasWaveform) {
        needsWaveform = false
      }
      if (!needsKey && !needsBpm && !needsWaveform) {
        job.needsKey = false
        job.needsBpm = false
        job.needsWaveform = false
        return false
      }
    }

    const listRoot = await findSongListRoot(path.dirname(filePath))
    if (listRoot) {
      const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
      if (cached && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1) {
        const cachedKey = (cached.info as any)?.key
        const cachedBpm = (cached.info as any)?.bpm
        const hasKey = isValidKeyText(cachedKey)
        const hasBpm = isValidBpm(cachedBpm)
        if (hasKey || hasBpm) {
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: hasKey ? cachedKey : undefined,
            bpm: hasBpm ? cachedBpm : undefined,
            hasWaveform: done?.hasWaveform
          })
        }
        if (needsKey && hasKey) {
          needsKey = false
        }
        if (needsBpm && hasBpm) {
          needsBpm = false
        }
        const hasWaveform = await LibraryCacheDb.hasWaveformCacheEntry(listRoot, filePath, stat)
        if (hasWaveform) {
          const existingDone = deps.doneByPath.get(job.normalizedPath)
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: existingDone?.keyText,
            bpm: existingDone?.bpm,
            hasWaveform: true
          })
          needsWaveform = false
        }
        if (!needsKey && !needsBpm && !needsWaveform) {
          job.needsKey = false
          job.needsBpm = false
          job.needsWaveform = false
          return false
        }
      }
    } else {
      needsWaveform = false
    }

    job.needsKey = needsKey
    job.needsBpm = needsBpm
    job.needsWaveform = needsWaveform
    return true
  }

  const removeCoverCacheForMissingTrack = async (listRoot: string, filePath: string) => {
    try {
      const removed = await LibraryCacheDb.removeCoverIndexEntry(listRoot, filePath)
      if (removed === undefined || !removed) return
      const remaining = await LibraryCacheDb.countCoverIndexByHash(listRoot, removed.hash)
      if (remaining !== 0) return
      const listRootAbs = LibraryCacheDb.resolveCacheListRootAbs(listRoot) || listRoot
      const coverPath = path.join(
        listRootAbs,
        '.frkb_covers',
        `${removed.hash}${removed.ext || '.jpg'}`
      )
      try {
        await fs.rm(coverPath, { force: true })
      } catch {}
    } catch {}
  }

  return {
    persistKey,
    persistBpm,
    persistWaveform,
    prepareJob,
    removeCoverCacheForMissingTrack
  }
}

export type KeyAnalysisPersistence = ReturnType<typeof createKeyAnalysisPersistence>
