import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import type { ISongInfo } from '../../../types/globals'
import type { MixxxWaveformData } from '../../waveformCache'
import type { UnifiedDisplayWaveformDetailData } from '../../../shared/unifiedDisplayWaveform'
import {
  persistSharedSongGridDefinition,
  shouldKeepManualSharedSongGridDefinition
} from '../sharedSongGrid'
import { emitSongGridUpdated } from '../songGridEvents'
import { getBeatThisRuntimeAvailabilitySnapshot } from '../../workers/beatThisRuntime'
import {
  resolveAudioFirstBeatTimelineMs,
  resolveAudioTimeBasisOffsetMsForFile
} from '../audioTimeBasisOffset'
import {
  CURRENT_BEAT_GRID_ALGORITHM_VERSION,
  normalizeBeatGridAlgorithmVersion,
  shouldAcceptBeatGridCacheVersion
} from '../beatGridAlgorithmVersion'
import {
  CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
  normalizeKeyAnalysisAlgorithmVersion,
  shouldAcceptKeyAnalysisCacheVersion
} from '../keyAnalysisAlgorithmVersion'
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

  const buildPrepareDetails = (params: {
    listRootResolved: boolean
    externalCacheResolved?: boolean
    doneEntryHit: boolean
    songCacheHit: boolean
    waveformCacheHit: boolean
    needsKey: boolean
    needsBpm: boolean
    needsWaveform: boolean
  }) => ({
    listRootResolved: params.listRootResolved,
    externalCacheResolved: params.externalCacheResolved === true,
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
      keyAnalysisAlgorithmVersion?: number
      bpm?: number
      firstBeatMs?: number
      barBeatOffset?: number
      timeBasisOffsetMs?: number
      beatGridAlgorithmVersion?: number | null
      beatGridSource?: ISongInfo['beatGridSource']
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
    stripBeatThisDebugInfo(info)
    const markAnalysisOnly = !entry || Boolean(entry.info?.analysisOnly)
    if (markAnalysisOnly) {
      info.analysisOnly = true
    }
    if (payload.keyText) {
      info.key = payload.keyText
    }
    if (payload.keyAnalysisAlgorithmVersion !== undefined) {
      info.keyAnalysisAlgorithmVersion = payload.keyAnalysisAlgorithmVersion
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
    if (Object.prototype.hasOwnProperty.call(payload, 'beatGridAlgorithmVersion')) {
      if (payload.beatGridAlgorithmVersion === null) {
        delete info.beatGridAlgorithmVersion
      } else {
        info.beatGridAlgorithmVersion = payload.beatGridAlgorithmVersion
      }
    }
    if (payload.beatGridSource !== undefined) {
      info.beatGridSource = payload.beatGridSource
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
        keyAnalysisAlgorithmVersion: CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const updated = await LibraryCacheDb.updateSongCacheKey(
          listRoot,
          filePath,
          keyText,
          CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION
        )
        if (!updated) {
          await ensureSongCacheEntry(
            listRoot,
            filePath,
            {
              keyText,
              keyAnalysisAlgorithmVersion: CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION
            },
            { size: stat.size, mtimeMs: stat.mtimeMs }
          )
        }
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
            externalContext,
            stat,
            stripBeatThisDebugInfo({
              ...(cached?.info || buildLiteSongInfo(filePath)),
              filePath,
              key: keyText,
              keyAnalysisAlgorithmVersion: CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
              analysisOnly: true
            })
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
        keyAnalysisAlgorithmVersion: CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
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
    }
  ) => {
    const normalizedPath = normalizePath(filePath)
    const normalizedBpm = Number(bpm.toFixed(6))
    const normalizedInputFirstBeatMs = isValidFirstBeatMs(firstBeatMs)
      ? Number(firstBeatMs.toFixed(3))
      : undefined
    const normalizedBarBeatOffset = normalizeBarBeatOffset(barBeatOffset)
    const normalizedBeatGridAlgorithmVersion = CURRENT_BEAT_GRID_ALGORITHM_VERSION
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
      const listRoot = await findSongListRoot(path.dirname(filePath))
      const externalContext = listRoot
        ? null
        : LibraryCacheDb.resolveExternalAnalysisContext(filePath)
      const existingSongCacheEntry = listRoot
        ? await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        : externalContext
          ? await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
              size: stat.size,
              mtimeMs: stat.mtimeMs
            })
          : null
      const existingSharedGrid = existingSongCacheEntry?.info
      if (
        existingSharedGrid &&
        shouldKeepManualSharedSongGridDefinition(existingSharedGrid, {
          filePath,
          bpm: normalizedBpm,
          firstBeatMs: normalizedFirstBeatMs,
          barBeatOffset: normalizedBarBeatOffset,
          timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
          beatGridSource: 'analysis'
        })
      ) {
        const existing = deps.doneByPath.get(normalizedPath)
        deps.doneByPath.set(normalizedPath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          keyText: existing?.keyText,
          keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
          bpm: existingSharedGrid.bpm ?? normalizedBpm,
          firstBeatMs:
            existingSharedGrid.firstBeatMs ?? existing?.firstBeatMs ?? normalizedFirstBeatMs,
          barBeatOffset:
            existingSharedGrid.barBeatOffset ?? existing?.barBeatOffset ?? normalizedBarBeatOffset,
          timeBasisOffsetMs:
            existingSharedGrid.timeBasisOffsetMs ??
            existing?.timeBasisOffsetMs ??
            normalizedTimeBasisOffsetMs,
          beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
          hasWaveform: existing?.hasWaveform
        })
        const nextInfo = applyLiteDefaults(
          existingSongCacheEntry?.info
            ? { ...existingSongCacheEntry.info }
            : buildLiteSongInfo(filePath),
          filePath
        )
        nextInfo.beatGridSource = 'manual'
        stripBeatThisDebugInfo(nextInfo)
        nextInfo.beatGridAlgorithmVersion = normalizedBeatGridAlgorithmVersion
        if (listRoot) {
          await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            info: nextInfo
          })
        } else if (externalContext) {
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, nextInfo)
        }
        deps.events.emit('bpm-updated', {
          filePath,
          bpm: existingSharedGrid.bpm ?? normalizedBpm,
          firstBeatMs: existingSharedGrid.firstBeatMs,
          barBeatOffset: existingSharedGrid.barBeatOffset,
          timeBasisOffsetMs: existingSharedGrid.timeBasisOffsetMs,
          beatGridAlgorithmVersion:
            existingSharedGrid.beatGridAlgorithmVersion ?? normalizedBeatGridAlgorithmVersion
        })
        return
      }
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs ?? existing?.firstBeatMs,
        barBeatOffset: normalizedBarBeatOffset ?? existing?.barBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs ?? existing?.timeBasisOffsetMs,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })

      const sharedGrid = listRoot
        ? await persistSharedSongGridDefinition({
            filePath,
            bpm: normalizedBpm,
            firstBeatMs: normalizedFirstBeatMs,
            barBeatOffset: normalizedBarBeatOffset,
            timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
            beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
            beatGridSource: 'analysis'
          })
        : null
      if (sharedGrid) {
        emitSongGridUpdated(sharedGrid)
      }

      if (listRoot) {
        await ensureSongCacheEntry(
          listRoot,
          filePath,
          {
            bpm: normalizedBpm,
            firstBeatMs: normalizedFirstBeatMs,
            barBeatOffset: normalizedBarBeatOffset,
            timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
            beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
            beatGridSource: 'analysis'
          },
          { size: stat.size, mtimeMs: stat.mtimeMs }
        )
      } else if (externalContext) {
        const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        await LibraryCacheDb.upsertExternalAnalysisCacheEntry(
          externalContext,
          stat,
          stripBeatThisDebugInfo({
            ...(cached?.info || buildLiteSongInfo(filePath)),
            filePath,
            bpm: normalizedBpm,
            firstBeatMs: normalizedFirstBeatMs,
            barBeatOffset: normalizedBarBeatOffset,
            timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
            beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
            beatGridSource: 'analysis',
            analysisOnly: true
          })
        )
      }

      const payload: BpmAnalysisResult = {
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
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
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs ?? existing?.firstBeatMs,
        barBeatOffset: normalizedBarBeatOffset ?? existing?.barBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs ?? existing?.timeBasisOffsetMs,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        hasWaveform: existing?.hasWaveform
      })
      const payload: BpmAnalysisResult = {
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion
      }
      emitSongGridUpdated({
        filePath,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs,
        barBeatOffset: normalizedBarBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        beatGridSource: 'analysis'
      })
      deps.events.emit('bpm-updated', payload)
      log.error('[闲时分析] persistBpm 失败，已写入内存兜底', {
        filePath,
        bpm: normalizedBpm,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const persistWaveform = async (
    filePath: string,
    waveformData: MixxxWaveformData,
    unifiedDisplayWaveformData?: UnifiedDisplayWaveformDetailData | null
  ) => {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      const existing = deps.doneByPath.get(normalizedPath)
      const listRoot = await findSongListRoot(path.dirname(filePath))
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        hasWaveform: listRoot ? Boolean(unifiedDisplayWaveformData) : true
      })

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
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        if (unifiedDisplayWaveformData) {
          await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            unifiedDisplayWaveformData
          )
          await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        } else {
          await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
        }
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          if (!cached) {
            await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, {
              ...buildLiteSongInfo(filePath),
              filePath,
              analysisOnly: true
            })
          }
          await LibraryCacheDb.upsertExternalAnalysisWaveformCacheEntry(
            externalContext,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            waveformData
          )
        }
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
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        bpm: existing?.bpm,
        firstBeatMs: existing?.firstBeatMs,
        barBeatOffset: existing?.barBeatOffset,
        timeBasisOffsetMs: existing?.timeBasisOffsetMs,
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
        await LibraryCacheDb.removeCompactVisualWaveformCacheEntry(listRoot, filePath)
        await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          await LibraryCacheDb.removeExternalAnalysisCacheEntry(externalContext)
        }
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
    let externalCacheResolved = false
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
        externalCacheResolved,
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
    const done = deps.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      doneEntryHit = true
      const hasDoneBpm = isValidBpm(done.bpm)
      const hasDoneFirstBeatMs = isValidFirstBeatMs(done.firstBeatMs)
      const hasDoneBarBeatOffset = isValidBarBeatOffset(done.barBeatOffset)
      const hasDoneCurrentKeyAlgorithm = shouldAcceptKeyAnalysisCacheVersion(done)
      const hasDoneCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(done)
      if (isValidKeyText(done.keyText) && hasDoneCurrentKeyAlgorithm) {
        needsKey = false
      }
      if (
        hasDoneBpm &&
        hasDoneFirstBeatMs &&
        hasDoneBarBeatOffset &&
        hasDoneCurrentBeatGridAlgorithm
      ) {
        needsBpm = false
      }
      if (!needsKey && !needsBpm && !needsWaveform) {
        job.needsKey = false
        job.needsBpm = false
        job.needsWaveform = false
        job.prepareReason = 'skip-done-cache-complete'
        job.prepareDetails = buildPrepareDetails({
          listRootResolved,
          externalCacheResolved,
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
        const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
          cached.info?.beatGridAlgorithmVersion
        )
        const cachedKeyAnalysisAlgorithmVersion = normalizeKeyAnalysisAlgorithmVersion(
          cached.info?.keyAnalysisAlgorithmVersion
        )
        const hasCurrentKeyAnalysisAlgorithm = shouldAcceptKeyAnalysisCacheVersion(cached.info)
        const hasKey = isValidKeyText(cachedKey) && hasCurrentKeyAnalysisAlgorithm
        const hasBpm = isValidBpm(cachedBpm)
        const hasFirstBeatMs = isValidFirstBeatMs(cachedFirstBeatMs)
        const hasBarBeatOffset = isValidBarBeatOffset(cachedBarBeatOffset)
        const hasCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(cached.info)
        const hasCompleteCurrentGrid =
          hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm
        if (hasKey || hasCompleteCurrentGrid) {
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: hasKey ? cachedKey : undefined,
            keyAnalysisAlgorithmVersion: hasKey ? cachedKeyAnalysisAlgorithmVersion : undefined,
            bpm: hasCompleteCurrentGrid ? cachedBpm : undefined,
            firstBeatMs: hasCompleteCurrentGrid ? cachedFirstBeatMs : undefined,
            barBeatOffset: hasCompleteCurrentGrid
              ? normalizeBarBeatOffset(cachedBarBeatOffset)
              : undefined,
            timeBasisOffsetMs: hasCompleteCurrentGrid
              ? normalizeTimeBasisOffsetMs(cached.info?.timeBasisOffsetMs)
              : undefined,
            beatGridAlgorithmVersion: hasCompleteCurrentGrid
              ? cachedBeatGridAlgorithmVersion
              : undefined,
            hasWaveform: false
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
          hasCurrentBeatGridAlgorithm
        ) {
          needsBpm = false
        }
        const hasWaveform = await LibraryCacheDb.hasUnifiedDisplayWaveformCacheEntryByMeta(
          listRoot,
          filePath,
          stat.size,
          stat.mtimeMs
        )
        if (hasWaveform) {
          waveformCacheHit = true
          const existingDone = deps.doneByPath.get(job.normalizedPath)
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: existingDone?.keyText,
            keyAnalysisAlgorithmVersion: existingDone?.keyAnalysisAlgorithmVersion,
            bpm: existingDone?.bpm,
            firstBeatMs: existingDone?.firstBeatMs,
            barBeatOffset: existingDone?.barBeatOffset,
            timeBasisOffsetMs: existingDone?.timeBasisOffsetMs,
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
            externalCacheResolved,
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
      const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
      if (externalContext) {
        externalCacheResolved = true
        const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, stat)
        if (cached) {
          songCacheHit = true
          const cachedKey = cached.info?.key
          const cachedBpm = cached.info?.bpm
          const cachedFirstBeatMs = cached.info?.firstBeatMs
          const cachedBarBeatOffset = cached.info?.barBeatOffset
          const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
            cached.info?.beatGridAlgorithmVersion
          )
          const cachedKeyAnalysisAlgorithmVersion = normalizeKeyAnalysisAlgorithmVersion(
            cached.info?.keyAnalysisAlgorithmVersion
          )
          const hasCurrentKeyAnalysisAlgorithm = shouldAcceptKeyAnalysisCacheVersion(cached.info)
          const hasKey = isValidKeyText(cachedKey) && hasCurrentKeyAnalysisAlgorithm
          const hasBpm = isValidBpm(cachedBpm)
          const hasFirstBeatMs = isValidFirstBeatMs(cachedFirstBeatMs)
          const hasBarBeatOffset = isValidBarBeatOffset(cachedBarBeatOffset)
          const hasCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(cached.info)
          const hasCompleteCurrentGrid =
            hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm
          if (hasKey || hasCompleteCurrentGrid || cached.hasWaveform) {
            deps.doneByPath.set(job.normalizedPath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              keyText: hasKey ? cachedKey : undefined,
              keyAnalysisAlgorithmVersion: hasKey ? cachedKeyAnalysisAlgorithmVersion : undefined,
              bpm: hasCompleteCurrentGrid ? cachedBpm : undefined,
              firstBeatMs: hasCompleteCurrentGrid ? cachedFirstBeatMs : undefined,
              barBeatOffset: hasCompleteCurrentGrid
                ? normalizeBarBeatOffset(cachedBarBeatOffset)
                : undefined,
              timeBasisOffsetMs: hasCompleteCurrentGrid
                ? normalizeTimeBasisOffsetMs(cached.info?.timeBasisOffsetMs)
                : undefined,
              beatGridAlgorithmVersion: hasCompleteCurrentGrid
                ? cachedBeatGridAlgorithmVersion
                : undefined,
              hasWaveform: cached.hasWaveform
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
            hasCurrentBeatGridAlgorithm
          ) {
            needsBpm = false
          }
          if (cached.hasWaveform) {
            waveformCacheHit = true
            needsWaveform = false
          }
          if (!needsKey && !needsBpm && !needsWaveform) {
            job.needsKey = false
            job.needsBpm = false
            job.needsWaveform = false
            job.prepareReason = 'skip-external-cache-complete'
            job.prepareDetails = buildPrepareDetails({
              listRootResolved,
              externalCacheResolved,
              doneEntryHit,
              songCacheHit,
              waveformCacheHit,
              needsKey,
              needsBpm,
              needsWaveform
            })
            deps.events.emit('analysis-stage-update', {
              filePath: job.filePath,
              stage: 'job-done',
              needsKey: false,
              needsBpm: false,
              needsWaveform: false
            })
            return false
          }
        }
      } else {
        needsWaveform = false
      }
    }

    if (job.waveformOnly) {
      needsKey = false
      needsBpm = false
    }

    if (!needsKey && !needsBpm && !needsWaveform) {
      job.needsKey = false
      job.needsBpm = false
      job.needsWaveform = false
      job.prepareReason = job.waveformOnly
        ? 'skip-waveform-cache-complete'
        : 'skip-special-grid-complete'
      job.prepareDetails = buildPrepareDetails({
        listRootResolved,
        externalCacheResolved,
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
    const beatThisRuntimeAvailable = getBeatThisRuntimeAvailabilitySnapshot()
    if (needsBpm && beatThisRuntimeAvailable === false) {
      needsBpm = false
    }

    job.needsKey = needsKey
    job.needsBpm = needsBpm
    job.needsWaveform = needsWaveform
    job.prepareReason = 'ready-analysis'
    job.prepareDetails = buildPrepareDetails({
      listRootResolved,
      externalCacheResolved,
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
