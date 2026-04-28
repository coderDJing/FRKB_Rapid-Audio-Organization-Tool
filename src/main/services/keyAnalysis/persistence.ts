import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { app } from 'electron'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import type { ISongInfo } from '../../../types/globals'
import type { MixxxWaveformData } from '../../waveformCache'
import { persistSharedSongGridDefinition } from '../sharedSongGrid'
import { emitSongGridUpdated } from '../songGridEvents'
import { isRcVersion } from '../../../shared/windowScreenshotFeature'
import { getBeatThisRuntimeAvailabilitySnapshot } from '../../workers/beatThisRuntime'
import {
  resolveAudioFirstBeatTimelineMs,
  resolveAudioTimeBasisOffsetMsForFile
} from '../audioTimeBasisOffset'
import {
  getCurrentBeatGridAlgorithmVersion,
  normalizeBeatGridAnalyzerProvider,
  normalizeBeatGridAlgorithmVersion,
  resolveConfiguredBeatGridAnalyzerProvider,
  shouldAcceptBeatGridCacheVersion
} from '../beatGridAlgorithmVersion'
import {
  isValidBpm,
  isValidBarBeatOffset,
  isValidFirstBeatMs,
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
  type ErrorLike = {
    code?: unknown
    message?: unknown
  }

  const isMissingFileError = (error: unknown) => {
    const err = (error && typeof error === 'object' ? error : null) as ErrorLike | null
    const code = String(err?.code || '')
      .trim()
      .toUpperCase()
    const message = String(err?.message || '').trim()
    return code === 'ENOENT' || /ENOENT|no such file or directory/i.test(message)
  }

  const normalizeBarBeatOffset = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return undefined
    const rounded = Math.round(numeric)
    return ((rounded % 32) + 32) % 32
  }

  const normalizeTimeBasisOffsetMs = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) return undefined
    return Number(numeric.toFixed(3))
  }

  const normalizeBeatThisEstimatedDrift128Ms = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) return undefined
    return Number(numeric.toFixed(3))
  }

  const normalizeBeatThisWindowCount = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined
    return Math.max(1, Math.floor(numeric))
  }

  const shouldBackfillBeatThisDebugMetrics = () => {
    if (process.env.NODE_ENV === 'development') return true
    try {
      return isRcVersion(app.getVersion())
    } catch {
      return false
    }
  }

  const buildPrepareDetails = (params: {
    listRootResolved: boolean
    doneEntryHit: boolean
    songCacheHit: boolean
    waveformCacheHit: boolean
    needsKey: boolean
    needsBpm: boolean
    needsWaveform: boolean
  }) => ({
    listRootResolved: params.listRootResolved,
    doneEntryHit: params.doneEntryHit,
    songCacheHit: params.songCacheHit,
    waveformCacheHit: params.waveformCacheHit,
    needsKey: params.needsKey,
    needsBpm: params.needsBpm,
    needsWaveform: params.needsWaveform
  })

  const ensureSongCacheEntry = async (
    listRoot: string,
    filePath: string,
    payload: {
      keyText?: string
      bpm?: number
      firstBeatMs?: number
      barBeatOffset?: number
      timeBasisOffsetMs?: number
      beatThisEstimatedDrift128Ms?: number | null
      beatThisWindowCount?: number | null
      beatGridAnalyzerProvider?: 'beatthis' | 'classic' | null
      beatGridAlgorithmVersion?: number | null
    },
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
    if (payload.firstBeatMs !== undefined) {
      info.firstBeatMs = payload.firstBeatMs
    }
    if (payload.barBeatOffset !== undefined) {
      info.barBeatOffset = payload.barBeatOffset
    }
    if (payload.timeBasisOffsetMs !== undefined) {
      info.timeBasisOffsetMs = payload.timeBasisOffsetMs
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'beatThisEstimatedDrift128Ms')) {
      if (payload.beatThisEstimatedDrift128Ms === null) {
        delete info.beatThisEstimatedDrift128Ms
      } else {
        info.beatThisEstimatedDrift128Ms = payload.beatThisEstimatedDrift128Ms
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'beatThisWindowCount')) {
      if (payload.beatThisWindowCount === null) {
        delete info.beatThisWindowCount
      } else {
        info.beatThisWindowCount = payload.beatThisWindowCount
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'beatGridAnalyzerProvider')) {
      if (payload.beatGridAnalyzerProvider === null) {
        delete info.beatGridAnalyzerProvider
      } else {
        info.beatGridAnalyzerProvider = payload.beatGridAnalyzerProvider
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'beatGridAlgorithmVersion')) {
      if (payload.beatGridAlgorithmVersion === null) {
        delete info.beatGridAlgorithmVersion
      } else {
        info.beatGridAlgorithmVersion = payload.beatGridAlgorithmVersion
      }
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
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: existing?.beatGridAnalyzerProvider,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
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
    } catch (error) {
      if (isMissingFileError(error)) {
        await cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: existing?.beatGridAnalyzerProvider,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })
      const payload: KeyAnalysisResult = { filePath, keyText }
      deps.events.emit('key-updated', payload)
      log.error('[闲时分析] persistKey 失败，已写入内存兜底', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const persistBpm = async (
    filePath: string,
    bpm: number,
    firstBeatMs?: number,
    barBeatOffset?: number,
    timeBasisOffsetMs?: number,
    options?: {
      firstBeatCoordinate?: 'audio' | 'timeline'
      beatThisEstimatedDrift128Ms?: number
      beatThisWindowCount?: number
      beatGridAnalyzerProvider?: 'beatthis' | 'classic'
    }
  ) => {
    const normalizedPath = normalizePath(filePath)
    const normalizedBpm = Number(bpm.toFixed(6))
    const normalizedInputFirstBeatMs = isValidFirstBeatMs(firstBeatMs)
      ? Number(firstBeatMs.toFixed(3))
      : undefined
    const normalizedBarBeatOffset = normalizeBarBeatOffset(barBeatOffset)
    const normalizedBeatThisEstimatedDrift128Ms = normalizeBeatThisEstimatedDrift128Ms(
      options?.beatThisEstimatedDrift128Ms
    )
    const normalizedBeatThisWindowCount = normalizeBeatThisWindowCount(options?.beatThisWindowCount)
    const normalizedBeatGridAnalyzerProvider =
      normalizeBeatGridAnalyzerProvider(options?.beatGridAnalyzerProvider) ??
      resolveConfiguredBeatGridAnalyzerProvider()
    const normalizedBeatGridAlgorithmVersion = getCurrentBeatGridAlgorithmVersion(
      normalizedBeatGridAnalyzerProvider
    )
    const firstBeatCoordinate = options?.firstBeatCoordinate || 'timeline'
    let normalizedTimeBasisOffsetMs = normalizeTimeBasisOffsetMs(timeBasisOffsetMs)
    let normalizedFirstBeatMs = normalizedInputFirstBeatMs
    try {
      const stat = await fs.stat(filePath)
      if (firstBeatCoordinate === 'audio' && normalizedInputFirstBeatMs !== undefined) {
        if (normalizedTimeBasisOffsetMs === undefined) {
          normalizedTimeBasisOffsetMs = normalizeTimeBasisOffsetMs(
            await resolveAudioTimeBasisOffsetMsForFile(filePath)
          )
        }
        normalizedFirstBeatMs = resolveAudioFirstBeatTimelineMs(
          normalizedInputFirstBeatMs,
          normalizedTimeBasisOffsetMs ?? 0
        )
      }
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs ?? existing?.firstBeatMs,
        barBeatOffset: normalizedBarBeatOffset ?? existing?.barBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs ?? existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms:
          normalizedBeatThisEstimatedDrift128Ms ?? existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: normalizedBeatThisWindowCount ?? existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })

      const sharedGrid = await persistSharedSongGridDefinition({
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatThisWindowCount: normalizedBeatThisWindowCount,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
      })
      if (sharedGrid) {
        emitSongGridUpdated(sharedGrid)
      }

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await ensureSongCacheEntry(
          listRoot,
          filePath,
          {
            bpm: normalizedBpm,
            firstBeatMs: normalizedFirstBeatMs,
            barBeatOffset: normalizedBarBeatOffset,
            timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
            beatThisEstimatedDrift128Ms: normalizedBeatThisEstimatedDrift128Ms ?? null,
            beatThisWindowCount: normalizedBeatThisWindowCount ?? null,
            beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
            beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
          },
          { size: stat.size, mtimeMs: stat.mtimeMs }
        )
      }

      const payload: BpmAnalysisResult = {
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: normalizedBeatThisEstimatedDrift128Ms ?? null,
        beatThisWindowCount: normalizedBeatThisWindowCount ?? null,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
      }
      deps.events.emit('bpm-updated', payload)
    } catch (error) {
      if (isMissingFileError(error)) {
        await cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs ?? existing?.firstBeatMs,
        barBeatOffset: normalizedBarBeatOffset ?? existing?.barBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs ?? existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms:
          normalizedBeatThisEstimatedDrift128Ms ?? existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: normalizedBeatThisWindowCount ?? existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })
      const payload: BpmAnalysisResult = {
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: normalizedBeatThisEstimatedDrift128Ms ?? null,
        beatThisWindowCount: normalizedBeatThisWindowCount ?? null,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
      }
      emitSongGridUpdated({
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatThisWindowCount: normalizedBeatThisWindowCount,
        beatGridAnalyzerProvider: normalizedBeatGridAnalyzerProvider,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
      })
      deps.events.emit('bpm-updated', payload)
      log.error('[闲时分析] persistBpm 失败，已写入内存兜底', {
        filePath,
        bpm: normalizedBpm,
        error: error instanceof Error ? error.message : String(error)
      })
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
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: existing?.beatGridAnalyzerProvider,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
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
    } catch (error) {
      if (isMissingFileError(error)) {
        await cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: 0,
        mtimeMs: 0,
        keyText: existing?.keyText,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatThisEstimatedDrift128Ms: existing?.beatThisEstimatedDrift128Ms,
        beatThisWindowCount: existing?.beatThisWindowCount,
        beatGridAnalyzerProvider: existing?.beatGridAnalyzerProvider,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        hasWaveform: true
      })
      log.error('[闲时分析] persistWaveform 失败，已写入内存兜底', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
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

  const cleanupMissingPersistTarget = async (normalizedPath: string, filePath: string) => {
    deps.doneByPath.delete(normalizedPath)
    await handleMissingFile(filePath)
  }

  const prepareJob = async (job: KeyAnalysisJob): Promise<boolean> => {
    const filePath = job.filePath
    let stat: { size: number; mtimeMs: number }
    let listRootResolved = false
    let doneEntryHit = false
    let songCacheHit = false
    let waveformCacheHit = false
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      job.prepareReason = 'skip-missing-file'
      job.prepareDetails = buildPrepareDetails({
        listRootResolved,
        doneEntryHit,
        songCacheHit,
        waveformCacheHit,
        needsKey: false,
        needsBpm: false,
        needsWaveform: false
      })
      await handleMissingFile(job.filePath)
      return false
    }
    job.fileSize = stat.size
    job.fileMtimeMs = stat.mtimeMs

    let needsKey = true
    let needsBpm = true
    let needsWaveform = true
    const currentBeatGridAnalyzerProvider = resolveConfiguredBeatGridAnalyzerProvider()
    const requireBeatThisDebugMetrics =
      currentBeatGridAnalyzerProvider === 'beatthis' && shouldBackfillBeatThisDebugMetrics()
    const done = deps.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      doneEntryHit = true
      const hasDoneBpm = isValidBpm(done.bpm)
      const hasDoneFirstBeatMs = isValidFirstBeatMs(done.firstBeatMs)
      const hasDoneBarBeatOffset = isValidBarBeatOffset(done.barBeatOffset)
      const hasDoneBeatThisWindowCount =
        normalizeBeatThisWindowCount(done.beatThisWindowCount) !== undefined
      const hasDoneCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(done)
      if (isValidKeyText(done.keyText)) {
        needsKey = false
      }
      if (
        hasDoneBpm &&
        hasDoneFirstBeatMs &&
        hasDoneBarBeatOffset &&
        hasDoneCurrentBeatGridAlgorithm &&
        (!requireBeatThisDebugMetrics || hasDoneBeatThisWindowCount)
      ) {
        needsBpm = false
      }
      if (done.hasWaveform) {
        needsWaveform = false
      }
      if (!needsKey && !needsBpm && !needsWaveform) {
        job.needsKey = false
        job.needsBpm = false
        job.needsWaveform = false
        job.prepareReason = 'skip-done-cache-complete'
        job.prepareDetails = buildPrepareDetails({
          listRootResolved,
          doneEntryHit,
          songCacheHit,
          waveformCacheHit,
          needsKey,
          needsBpm,
          needsWaveform
        })
        return false
      }
    }

    const listRoot = await findSongListRoot(path.dirname(filePath))
    if (listRoot) {
      listRootResolved = true
      const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
      if (cached && cached.size === stat.size && Math.abs(cached.mtimeMs - stat.mtimeMs) < 1) {
        songCacheHit = true
        const cachedKey = cached.info?.key
        const cachedBpm = cached.info?.bpm
        const cachedFirstBeatMs = cached.info?.firstBeatMs
        const cachedBarBeatOffset = cached.info?.barBeatOffset
        const cachedBeatThisEstimatedDrift128Ms = normalizeBeatThisEstimatedDrift128Ms(
          cached.info?.beatThisEstimatedDrift128Ms
        )
        const cachedBeatThisWindowCount = normalizeBeatThisWindowCount(
          cached.info?.beatThisWindowCount
        )
        const cachedBeatGridAnalyzerProvider = normalizeBeatGridAnalyzerProvider(
          cached.info?.beatGridAnalyzerProvider
        )
        const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
          cached.info?.beatGridAlgorithmVersion
        )
        const hasKey = isValidKeyText(cachedKey)
        const hasBpm = isValidBpm(cachedBpm)
        const hasFirstBeatMs = isValidFirstBeatMs(cachedFirstBeatMs)
        const hasBarBeatOffset = isValidBarBeatOffset(cachedBarBeatOffset)
        const hasBeatThisWindowCount = cachedBeatThisWindowCount !== undefined
        const hasCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(cached.info)
        if (hasKey || hasBpm || hasFirstBeatMs || hasBarBeatOffset) {
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: hasKey ? cachedKey : undefined,
            bpm: hasBpm ? cachedBpm : undefined,
            firstBeatMs: hasFirstBeatMs ? cachedFirstBeatMs : undefined,
            barBeatOffset: hasBarBeatOffset
              ? normalizeBarBeatOffset(cachedBarBeatOffset)
              : undefined,
            timeBasisOffsetMs: normalizeTimeBasisOffsetMs(cached.info?.timeBasisOffsetMs),
            beatThisEstimatedDrift128Ms: cachedBeatThisEstimatedDrift128Ms,
            beatThisWindowCount: cachedBeatThisWindowCount,
            beatGridAnalyzerProvider: cachedBeatGridAnalyzerProvider,
            beatGridAlgorithmVersion: cachedBeatGridAlgorithmVersion,
            hasWaveform: done?.hasWaveform
          })
        }
        if (needsKey && hasKey) {
          needsKey = false
        }
        if (
          needsBpm &&
          hasBpm &&
          hasFirstBeatMs &&
          hasBarBeatOffset &&
          hasCurrentBeatGridAlgorithm &&
          (!requireBeatThisDebugMetrics || hasBeatThisWindowCount)
        ) {
          needsBpm = false
        }
        const hasWaveform = await LibraryCacheDb.hasWaveformCacheEntry(listRoot, filePath, stat)
        if (hasWaveform) {
          waveformCacheHit = true
          const existingDone = deps.doneByPath.get(job.normalizedPath)
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: existingDone?.keyText,
            bpm: existingDone?.bpm,
            firstBeatMs: existingDone?.firstBeatMs,
            barBeatOffset: existingDone?.barBeatOffset,
            timeBasisOffsetMs: existingDone?.timeBasisOffsetMs,
            beatThisEstimatedDrift128Ms: existingDone?.beatThisEstimatedDrift128Ms,
            beatThisWindowCount: existingDone?.beatThisWindowCount,
            beatGridAnalyzerProvider: existingDone?.beatGridAnalyzerProvider,
            beatGridAlgorithmVersion: existingDone?.beatGridAlgorithmVersion,
            hasWaveform: true
          })
          needsWaveform = false
        }
        if (!needsKey && !needsBpm && !needsWaveform) {
          job.needsKey = false
          job.needsBpm = false
          job.needsWaveform = false
          job.prepareReason = 'skip-db-cache-complete'
          job.prepareDetails = buildPrepareDetails({
            listRootResolved,
            doneEntryHit,
            songCacheHit,
            waveformCacheHit,
            needsKey,
            needsBpm,
            needsWaveform
          })
          return false
        }
      }
    } else {
      needsWaveform = false
    }

    if (!needsKey && !needsBpm && !needsWaveform) {
      job.needsKey = false
      job.needsBpm = false
      job.needsWaveform = false
      job.prepareReason = 'skip-special-grid-complete'
      job.prepareDetails = buildPrepareDetails({
        listRootResolved,
        doneEntryHit,
        songCacheHit,
        waveformCacheHit,
        needsKey,
        needsBpm,
        needsWaveform
      })
      return false
    }

    // 这里绝不能在主线程里现探 Beat This runtime。
    // 同步 Python 探针会把打开歌单卡成未响应。
    if (needsBpm && currentBeatGridAnalyzerProvider === 'beatthis') {
      const beatThisRuntimeAvailable = getBeatThisRuntimeAvailabilitySnapshot()
      if (beatThisRuntimeAvailable === false) {
        needsBpm = false
      }
    }

    job.needsKey = needsKey
    job.needsBpm = needsBpm
    job.needsWaveform = needsWaveform
    job.prepareReason = 'ready-analysis'
    job.prepareDetails = buildPrepareDetails({
      listRootResolved,
      doneEntryHit,
      songCacheHit,
      waveformCacheHit,
      needsKey,
      needsBpm,
      needsWaveform
    })
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
