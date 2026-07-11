import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import type { ISongInfo } from '../../../types/globals'
import { hasUsableSongEnergyAnalysis, normalizeSongEnergyScore } from '../../../shared/songEnergy'
import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis,
  type SongStructureAnalysis
} from '../../../shared/songStructure'
import {
  hasUsableKeyAnalysis,
  resolveUsableSongBeatGrid
} from '../../../shared/songAnalysisCompleteness'
import {
  persistSharedSongGridDefinition,
  shouldKeepManualSharedSongGridDefinition
} from '../sharedSongGrid'
import { emitSongGridUpdated } from '../songGridEvents'
import { normalizeSongBeatGridMap } from '../../../shared/songBeatGridMap'
import { getBeatThisRuntimeAvailabilitySnapshot } from '../../workers/beatThisRuntime'
import {
  resolveAudioFirstBeatTimelineMs,
  resolveAudioTimeBasisOffsetMsForFile
} from '../audioTimeBasisOffset'
import {
  BEAT_GRID_STATUS_NO_BPM,
  CURRENT_BEAT_GRID_ALGORITHM_VERSION,
  normalizeBeatGridAlgorithmVersion
} from '../beatGridAlgorithmVersion'
import {
  CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION,
  normalizeKeyAnalysisAlgorithmVersion
} from '../keyAnalysisAlgorithmVersion'
import {
  isValidBpm,
  isValidBarBeatOffset,
  isValidFirstBeatMs,
  normalizePath,
  type BpmAnalysisResult,
  type DoneEntry,
  type KeyAnalysisJob,
  type KeyAnalysisResult
} from './types'
import { createPersistEnergy } from './energyPersistence'
import { createPersistSongStructure } from './structurePersistence'
import { createPersistWaveform } from './waveformPersistence'
import { removeCoverCacheForMissingTrack } from './coverCacheCleanup'
import { ensureSongCacheEntry } from './songCacheEntryPersistence'

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

  const clearBeatGridFields = (info: ISongInfo) => {
    delete info.bpm
    delete info.firstBeatMs
    delete info.barBeatOffset
    delete info.timeBasisOffsetMs
    delete info.beatGridSource
    delete info.beatGridStatus
    delete info.beatGridMap
    delete info.beatGridAlgorithmVersion
    delete info.songStructure
  }

  const applyNoBpmBeatGridResult = (info: ISongInfo) => {
    clearBeatGridFields(info)
    info.beatGridStatus = BEAT_GRID_STATUS_NO_BPM
    info.beatGridAlgorithmVersion = CURRENT_BEAT_GRID_ALGORITHM_VERSION
  }

  const buildPrepareDetails = (params: {
    listRootResolved: boolean
    externalCacheResolved?: boolean
    doneEntryHit: boolean
    songCacheHit: boolean
    waveformCacheHit: boolean
    energyCacheHit: boolean
    needsKey: boolean
    needsBpm: boolean
    needsWaveform: boolean
    needsEnergy: boolean
    needsStructure: boolean
  }) => ({
    ...params,
    externalCacheResolved: params.externalCacheResolved === true
  })

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
        beatGridStatus: existing?.beatGridStatus,
        beatGridMap: existing?.beatGridMap,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: existing?.songStructure,
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
        beatGridStatus: existing?.beatGridStatus,
        beatGridMap: existing?.beatGridMap,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: existing?.songStructure,
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
      shouldPersist?: () => boolean
    }
  ) => {
    const shouldPersist = () => options?.shouldPersist?.() !== false
    if (!shouldPersist()) return
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
      if (!shouldPersist()) return
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
        if (!shouldPersist()) return
      }
      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!shouldPersist()) return
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
      if (!shouldPersist()) return
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
        if (!shouldPersist()) return
        const existing = deps.doneByPath.get(normalizedPath)
        const existingBeatGridMap = normalizeSongBeatGridMap(existingSharedGrid.beatGridMap)
        const nextDoneEntry: DoneEntry = {
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
          beatGridMap: existingBeatGridMap ?? existing?.beatGridMap,
          energyScore: existing?.energyScore,
          energyAlgorithmVersion: existing?.energyAlgorithmVersion,
          songStructure: existing?.songStructure,
          hasWaveform: existing?.hasWaveform
        }
        const nextInfo = applyLiteDefaults(
          existingSongCacheEntry?.info
            ? { ...existingSongCacheEntry.info }
            : buildLiteSongInfo(filePath),
          filePath
        )
        delete nextInfo.beatGridStatus
        nextInfo.beatGridSource = 'manual'
        stripBeatThisDebugInfo(nextInfo)
        nextInfo.beatGridAlgorithmVersion = normalizedBeatGridAlgorithmVersion
        if (!hasUsableSongStructureAnalysis(nextInfo)) {
          delete nextInfo.songStructure
        }
        if (listRoot) {
          if (!shouldPersist()) return
          await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            info: nextInfo
          })
        } else if (externalContext) {
          if (!shouldPersist()) return
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, nextInfo)
        }
        if (!shouldPersist()) return
        deps.doneByPath.set(normalizedPath, nextDoneEntry)
        deps.events.emit('bpm-updated', {
          filePath,
          bpm: existingSharedGrid.bpm ?? normalizedBpm,
          firstBeatMs: existingSharedGrid.firstBeatMs,
          barBeatOffset: existingSharedGrid.barBeatOffset,
          timeBasisOffsetMs: existingSharedGrid.timeBasisOffsetMs,
          beatGridAlgorithmVersion:
            existingSharedGrid.beatGridAlgorithmVersion ?? normalizedBeatGridAlgorithmVersion,
          beatGridMap: existingBeatGridMap ?? undefined
        })
        return
      }
      if (!shouldPersist()) return
      const existing = deps.doneByPath.get(normalizedPath)
      const nextDoneEntry: DoneEntry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        bpm: normalizedBpm,
        firstBeatMs: normalizedFirstBeatMs ?? existing?.firstBeatMs,
        barBeatOffset: normalizedBarBeatOffset ?? existing?.barBeatOffset,
        timeBasisOffsetMs: normalizedTimeBasisOffsetMs ?? existing?.timeBasisOffsetMs,
        beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: existing?.songStructure,
        hasWaveform: existing?.hasWaveform
      }

      const sharedGrid = listRoot
        ? await persistSharedSongGridDefinition(
            {
              filePath,
              bpm: normalizedBpm,
              firstBeatMs: normalizedFirstBeatMs,
              barBeatOffset: normalizedBarBeatOffset,
              timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
              beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
              beatGridSource: 'analysis'
            },
            { shouldPersist }
          )
        : null
      if (!shouldPersist()) return
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
          { size: stat.size, mtimeMs: stat.mtimeMs },
          { shouldPersist }
        )
      } else if (externalContext) {
        const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        if (!shouldPersist()) return
        const nextInfo: ISongInfo = stripBeatThisDebugInfo({
          ...(cached?.info || buildLiteSongInfo(filePath)),
          filePath,
          bpm: normalizedBpm,
          firstBeatMs: normalizedFirstBeatMs,
          barBeatOffset: normalizedBarBeatOffset,
          timeBasisOffsetMs: normalizedTimeBasisOffsetMs,
          beatGridAlgorithmVersion: normalizedBeatGridAlgorithmVersion,
          beatGridSource: 'analysis' as const,
          analysisOnly: true
        })
        delete nextInfo.beatGridStatus
        if (!hasUsableSongStructureAnalysis(nextInfo)) {
          delete nextInfo.songStructure
        }
        if (!shouldPersist()) return
        await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, nextInfo)
      }

      if (!shouldPersist()) return
      deps.doneByPath.set(normalizedPath, nextDoneEntry)
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
      if (!shouldPersist()) return
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
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: undefined,
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

  const persistNoBpm = async (
    filePath: string,
    options: { shouldPersist?: () => boolean } = {}
  ) => {
    const shouldPersist = () => options.shouldPersist?.() !== false
    if (!shouldPersist()) return
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
      if (!shouldPersist()) return

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (!shouldPersist()) return
      if (listRoot) {
        const entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        if (!shouldPersist()) return
        if (
          shouldKeepManualSharedSongGridDefinition(entry?.info, {
            filePath,
            beatGridSource: 'analysis'
          })
        ) {
          return
        }
        const info = applyLiteDefaults(
          entry?.info ? { ...entry.info } : buildLiteSongInfo(filePath),
          filePath
        )
        stripBeatThisDebugInfo(info)
        if (!entry || Boolean(entry.info?.analysisOnly)) {
          info.analysisOnly = true
        }
        applyNoBpmBeatGridResult(info)
        if (!shouldPersist()) return
        await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          info
        })
      } else {
        const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
        if (externalContext) {
          const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
            size: stat.size,
            mtimeMs: stat.mtimeMs
          })
          if (!shouldPersist()) return
          if (
            shouldKeepManualSharedSongGridDefinition(cached?.info, {
              filePath,
              beatGridSource: 'analysis'
            })
          ) {
            return
          }
          const info = applyLiteDefaults(
            cached?.info ? { ...cached.info, filePath } : buildLiteSongInfo(filePath),
            filePath
          )
          stripBeatThisDebugInfo(info)
          info.analysisOnly = true
          applyNoBpmBeatGridResult(info)
          if (!shouldPersist()) return
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, info)
        }
      }

      if (!shouldPersist()) return
      const existing = deps.doneByPath.get(normalizedPath)
      deps.doneByPath.set(normalizedPath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keyText: existing?.keyText,
        keyAnalysisAlgorithmVersion: existing?.keyAnalysisAlgorithmVersion,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: existing?.songStructure,
        hasWaveform: existing?.hasWaveform
      })
      const payload: BpmAnalysisResult = {
        filePath,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM
      }
      deps.events.emit('bpm-updated', payload)
    } catch (error) {
      if (!shouldPersist()) return
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
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: undefined,
        hasWaveform: existing?.hasWaveform
      })
      deps.events.emit('bpm-updated', {
        filePath,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM
      } satisfies BpmAnalysisResult)
      log.error('[闲时分析] persistNoBpm 失败，已写入内存记录', {
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
        await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
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

  const persistEnergy = createPersistEnergy({
    doneByPath: deps.doneByPath,
    events: deps.events,
    ensureSongCacheEntry,
    cleanupMissingPersistTarget,
    isMissingFileError
  })

  const persistSongStructure = createPersistSongStructure({
    doneByPath: deps.doneByPath,
    events: deps.events,
    ensureSongCacheEntry,
    cleanupMissingPersistTarget,
    isMissingFileError
  })

  const persistWaveform = createPersistWaveform({
    doneByPath: deps.doneByPath,
    ensureSongCacheEntry,
    cleanupMissingPersistTarget,
    isMissingFileError
  })

  const prepareJob = async (job: KeyAnalysisJob): Promise<boolean> => {
    const filePath = job.filePath
    const forceAnalysis = job.forceAnalysis === true
    job.cachedUnifiedDisplayWaveformData = undefined
    let stat: { size: number; mtimeMs: number }
    let listRootResolved = false
    let externalCacheResolved = false
    let doneEntryHit = false
    let songCacheHit = false
    let waveformCacheHit = false
    let energyCacheHit = false
    let needsKey = false
    let needsBpm = false
    let needsWaveform = false
    let needsEnergy = false
    let needsStructure = false
    const buildCurrentPrepareDetails = () =>
      buildPrepareDetails({
        listRootResolved,
        externalCacheResolved,
        doneEntryHit,
        songCacheHit,
        waveformCacheHit,
        energyCacheHit,
        needsKey,
        needsBpm,
        needsWaveform,
        needsEnergy,
        needsStructure
      })
    const applyJobNeeds = () => {
      if (!needsStructure) {
        job.cachedUnifiedDisplayWaveformData = undefined
      }
      Object.assign(job, { needsKey, needsBpm, needsWaveform, needsEnergy, needsStructure })
    }
    const resolveUsableEnergy = (
      info: { energyScore?: unknown; energyAlgorithmVersion?: unknown } | null | undefined
    ) => {
      if (!hasUsableSongEnergyAnalysis(info)) return null
      const energyScore = normalizeSongEnergyScore(info?.energyScore)
      if (energyScore === undefined) return null
      const version = Number(info?.energyAlgorithmVersion)
      return {
        energyScore,
        energyAlgorithmVersion:
          Number.isFinite(version) && version > 0 ? Math.floor(version) : undefined
      }
    }
    const resolveUsableStructure = (
      info:
        | {
            songStructure?: unknown
            bpm?: unknown
            firstBeatMs?: unknown
            barBeatOffset?: unknown
            beatGridMap?: unknown
          }
        | null
        | undefined
    ) =>
      hasUsableSongStructureAnalysis(info)
        ? normalizeSongStructureAnalysis(info?.songStructure)
        : undefined
    const hasCachedStructureGrid = () =>
      Boolean(job.cachedBeatGridMap) ||
      (isValidBpm(job.cachedBpm) &&
        isValidFirstBeatMs(job.cachedFirstBeatMs) &&
        isValidBarBeatOffset(job.cachedBarBeatOffset))
    try {
      const fsStat = await fs.stat(filePath)
      stat = { size: fsStat.size, mtimeMs: fsStat.mtimeMs }
    } catch {
      job.prepareReason = 'skip-missing-file'
      applyJobNeeds()
      job.prepareDetails = buildCurrentPrepareDetails()
      await handleMissingFile(job.filePath)
      return false
    }
    job.fileSize = stat.size
    job.fileMtimeMs = stat.mtimeMs

    needsKey = true
    needsBpm = true
    needsWaveform = true
    needsEnergy = true
    needsStructure = job.includeStructure !== false
    const done = deps.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      doneEntryHit = true
      const doneGrid = resolveUsableSongBeatGrid(done)
      const hasDoneNoBpm = doneGrid.kind === 'no-bpm'
      const hasDoneCompleteGrid = doneGrid.kind === 'dynamic' || doneGrid.kind === 'fixed'
      const doneStructure = hasDoneCompleteGrid ? resolveUsableStructure(done) : undefined
      if (!forceAnalysis && hasUsableKeyAnalysis({ key: done.keyText })) {
        needsKey = false
      }
      if (hasDoneCompleteGrid) {
        job.cachedBpm = doneGrid.bpm
        job.cachedFirstBeatMs = doneGrid.firstBeatMs
        job.cachedBarBeatOffset = doneGrid.barBeatOffset
        job.cachedBeatGridMap = doneGrid.kind === 'dynamic' ? doneGrid.beatGridMap : undefined
        if (!forceAnalysis) needsBpm = false
      } else if (!forceAnalysis && hasDoneNoBpm) {
        needsBpm = false
      }
      if (!forceAnalysis && (hasDoneNoBpm || doneStructure)) {
        needsStructure = false
      }
      if (!forceAnalysis && done.hasWaveform) {
        needsWaveform = false
      }
      if (!forceAnalysis && hasUsableSongEnergyAnalysis(done)) {
        energyCacheHit = true
        needsEnergy = false
      }
      if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy && !needsStructure) {
        applyJobNeeds()
        job.prepareReason = 'skip-done-cache-complete'
        job.prepareDetails = buildCurrentPrepareDetails()
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
        const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
          cached.info?.beatGridAlgorithmVersion
        )
        const cachedKeyAnalysisAlgorithmVersion = normalizeKeyAnalysisAlgorithmVersion(
          cached.info?.keyAnalysisAlgorithmVersion
        )
        const hasKey = hasUsableKeyAnalysis(cached.info)
        const cachedGrid = resolveUsableSongBeatGrid(cached.info)
        const hasNoBpm = cachedGrid.kind === 'no-bpm'
        const hasCompleteGrid = cachedGrid.kind === 'dynamic' || cachedGrid.kind === 'fixed'
        const cachedEnergy = resolveUsableEnergy(cached.info)
        const cachedStructure = hasCompleteGrid ? resolveUsableStructure(cached.info) : undefined
        if (!forceAnalysis && cachedEnergy) {
          energyCacheHit = true
          needsEnergy = false
        }
        if (!forceAnalysis && (hasNoBpm || cachedStructure)) {
          needsStructure = false
        }
        if (hasKey || hasCompleteGrid || hasNoBpm || cachedEnergy || cachedStructure) {
          deps.doneByPath.set(job.normalizedPath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            keyText: hasKey ? cachedKey : undefined,
            keyAnalysisAlgorithmVersion: hasKey ? cachedKeyAnalysisAlgorithmVersion : undefined,
            bpm: hasCompleteGrid ? cachedGrid.bpm : undefined,
            firstBeatMs: hasCompleteGrid ? cachedGrid.firstBeatMs : undefined,
            barBeatOffset: hasCompleteGrid
              ? normalizeBarBeatOffset(cachedGrid.barBeatOffset)
              : undefined,
            timeBasisOffsetMs: hasCompleteGrid
              ? normalizeTimeBasisOffsetMs(cached.info?.timeBasisOffsetMs)
              : undefined,
            beatGridAlgorithmVersion: hasCompleteGrid
              ? cachedBeatGridAlgorithmVersion
              : hasNoBpm
                ? cachedBeatGridAlgorithmVersion
                : undefined,
            beatGridStatus: hasNoBpm ? BEAT_GRID_STATUS_NO_BPM : undefined,
            beatGridMap: cachedGrid.kind === 'dynamic' ? cachedGrid.beatGridMap : undefined,
            energyScore: cachedEnergy?.energyScore,
            energyAlgorithmVersion: cachedEnergy?.energyAlgorithmVersion,
            songStructure: cachedStructure,
            hasWaveform: false
          })
        }
        if (!forceAnalysis && needsKey && hasKey) {
          needsKey = false
        }
        if (hasCompleteGrid) {
          job.cachedBpm = cachedGrid.bpm
          job.cachedFirstBeatMs = cachedGrid.firstBeatMs
          job.cachedBarBeatOffset = cachedGrid.barBeatOffset
          job.cachedBeatGridMap = cachedGrid.kind === 'dynamic' ? cachedGrid.beatGridMap : undefined
          if (!forceAnalysis) needsBpm = false
        } else if (!forceAnalysis && needsBpm && hasNoBpm) {
          needsBpm = false
        }
        const hasWaveform = await LibraryCacheDb.hasWaveformSurfaceCacheEntryByMeta(
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
            beatGridStatus: existingDone?.beatGridStatus,
            beatGridMap: existingDone?.beatGridMap,
            energyScore: existingDone?.energyScore,
            energyAlgorithmVersion: existingDone?.energyAlgorithmVersion,
            songStructure: existingDone?.songStructure,
            hasWaveform: true
          })
          if (!forceAnalysis) needsWaveform = false
          if (!forceAnalysis && (needsEnergy || (needsStructure && hasCompleteGrid))) {
            const cachedUnifiedWaveform = await LibraryCacheDb.loadUnifiedDisplayWaveformCacheData(
              listRoot,
              filePath,
              stat
            )
            if (cachedUnifiedWaveform) {
              job.cachedUnifiedDisplayWaveformData = cachedUnifiedWaveform
            }
          }
        }
        if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy && !needsStructure) {
          applyJobNeeds()
          job.prepareReason = 'skip-db-cache-complete'
          job.prepareDetails = buildCurrentPrepareDetails()
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
          const cachedBeatGridAlgorithmVersion = normalizeBeatGridAlgorithmVersion(
            cached.info?.beatGridAlgorithmVersion
          )
          const cachedKeyAnalysisAlgorithmVersion = normalizeKeyAnalysisAlgorithmVersion(
            cached.info?.keyAnalysisAlgorithmVersion
          )
          const hasKey = hasUsableKeyAnalysis(cached.info)
          const cachedGrid = resolveUsableSongBeatGrid(cached.info)
          const hasNoBpm = cachedGrid.kind === 'no-bpm'
          const hasCompleteGrid = cachedGrid.kind === 'dynamic' || cachedGrid.kind === 'fixed'
          const cachedEnergy = resolveUsableEnergy(cached.info)
          const cachedStructure = hasCompleteGrid ? resolveUsableStructure(cached.info) : undefined
          if (!forceAnalysis && cachedEnergy) {
            energyCacheHit = true
            needsEnergy = false
          }
          if (!forceAnalysis && (hasNoBpm || cachedStructure)) {
            needsStructure = false
          }
          if (
            hasKey ||
            hasCompleteGrid ||
            hasNoBpm ||
            cached.hasWaveform ||
            cachedEnergy ||
            cachedStructure
          ) {
            deps.doneByPath.set(job.normalizedPath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              keyText: hasKey ? cachedKey : undefined,
              keyAnalysisAlgorithmVersion: hasKey ? cachedKeyAnalysisAlgorithmVersion : undefined,
              bpm: hasCompleteGrid ? cachedGrid.bpm : undefined,
              firstBeatMs: hasCompleteGrid ? cachedGrid.firstBeatMs : undefined,
              barBeatOffset: hasCompleteGrid
                ? normalizeBarBeatOffset(cachedGrid.barBeatOffset)
                : undefined,
              timeBasisOffsetMs: hasCompleteGrid
                ? normalizeTimeBasisOffsetMs(cached.info?.timeBasisOffsetMs)
                : undefined,
              beatGridAlgorithmVersion: hasCompleteGrid
                ? cachedBeatGridAlgorithmVersion
                : hasNoBpm
                  ? cachedBeatGridAlgorithmVersion
                  : undefined,
              beatGridStatus: hasNoBpm ? BEAT_GRID_STATUS_NO_BPM : undefined,
              beatGridMap: cachedGrid.kind === 'dynamic' ? cachedGrid.beatGridMap : undefined,
              energyScore: cachedEnergy?.energyScore,
              energyAlgorithmVersion: cachedEnergy?.energyAlgorithmVersion,
              songStructure: cachedStructure,
              hasWaveform: cached.hasWaveform
            })
          }
          if (!forceAnalysis && needsKey && hasKey) {
            needsKey = false
          }
          if (hasCompleteGrid) {
            job.cachedBpm = cachedGrid.bpm
            job.cachedFirstBeatMs = cachedGrid.firstBeatMs
            job.cachedBarBeatOffset = cachedGrid.barBeatOffset
            job.cachedBeatGridMap =
              cachedGrid.kind === 'dynamic' ? cachedGrid.beatGridMap : undefined
            if (!forceAnalysis) needsBpm = false
          } else if (!forceAnalysis && needsBpm && hasNoBpm) {
            needsBpm = false
          }
          if (!forceAnalysis && cached.hasWaveform) {
            waveformCacheHit = true
            needsWaveform = false
          }
          if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy && !needsStructure) {
            applyJobNeeds()
            job.prepareReason = 'skip-external-cache-complete'
            job.prepareDetails = buildCurrentPrepareDetails()
            deps.events.emit('analysis-stage-update', {
              filePath: job.filePath,
              stage: 'job-done',
              needsKey: false,
              needsBpm: false,
              needsWaveform: false,
              needsStructure: false
            })
            return false
          }
        }
      } else {
        needsWaveform = false
        needsEnergy = false
        needsStructure = false
      }
    }

    if (job.waveformOnly) {
      needsKey = false
      needsBpm = false
      needsEnergy = false
      needsStructure = false
    }

    if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy && !needsStructure) {
      applyJobNeeds()
      job.prepareReason = job.waveformOnly
        ? 'skip-waveform-cache-complete'
        : 'skip-special-grid-complete'
      job.prepareDetails = buildCurrentPrepareDetails()
      return false
    }

    // 这里绝不能在主线程里现探 Beat This runtime。
    // 同步 Python 探针会把打开歌单卡成未响应。
    const beatThisRuntimeAvailable = getBeatThisRuntimeAvailabilitySnapshot()
    if (needsBpm && beatThisRuntimeAvailable === false) {
      needsBpm = false
      if (!hasCachedStructureGrid()) {
        needsStructure = false
      }
    }
    if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy && !needsStructure) {
      applyJobNeeds()
      job.prepareReason = 'skip-runtime-unavailable'
      job.prepareDetails = buildCurrentPrepareDetails()
      return false
    }

    applyJobNeeds()
    job.prepareReason = 'ready-analysis'
    job.prepareDetails = buildCurrentPrepareDetails()
    return true
  }

  return {
    persistKey,
    persistEnergy,
    persistBpm,
    persistNoBpm,
    persistSongStructure,
    persistWaveform,
    prepareJob,
    removeCoverCacheForMissingTrack
  }
}

export type KeyAnalysisPersistence = ReturnType<typeof createKeyAnalysisPersistence>
