import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import type { ISongInfo } from '../../../types/globals'
import type { MixxxWaveformData } from '../../waveformCodec'
import type { UnifiedDisplayWaveformDetailData } from '../../../shared/unifiedDisplayWaveform'
import { buildWaveformSurfaceCacheDataFromUnifiedDisplay } from '../../../shared/waveformSurfaceCache'
import {
  CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
  hasCurrentSongEnergyAnalysis,
  normalizeSongEnergyScore
} from '../../../shared/songEnergy'
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
  BEAT_GRID_STATUS_NO_BPM,
  CURRENT_BEAT_GRID_ALGORITHM_VERSION,
  hasCurrentNoBpmBeatGridResult,
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
import { createPersistEnergy } from './energyPersistence'
import { removeCoverCacheForMissingTrack } from './coverCacheCleanup'

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
    delete info.beatGridAlgorithmVersion
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
  }) => ({
    listRootResolved: params.listRootResolved,
    externalCacheResolved: params.externalCacheResolved === true,
    doneEntryHit: params.doneEntryHit,
    songCacheHit: params.songCacheHit,
    waveformCacheHit: params.waveformCacheHit,
    energyCacheHit: params.energyCacheHit,
    needsKey: params.needsKey,
    needsBpm: params.needsBpm,
    needsWaveform: params.needsWaveform,
    needsEnergy: params.needsEnergy
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
      beatGridStatus?: ISongInfo['beatGridStatus']
      energyScore?: number
      energyAlgorithmVersion?: number
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
      delete info.beatGridStatus
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
    if (payload.beatGridStatus !== undefined) {
      info.beatGridStatus = payload.beatGridStatus
    }
    if (payload.energyScore !== undefined) {
      info.energyScore = payload.energyScore
      info.energyAlgorithmVersion =
        payload.energyAlgorithmVersion ?? CURRENT_SONG_ENERGY_ALGORITHM_VERSION
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
        beatGridStatus: existing?.beatGridStatus,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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
          energyScore: existing?.energyScore,
          energyAlgorithmVersion: existing?.energyAlgorithmVersion,
          hasWaveform: existing?.hasWaveform
        })
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
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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
        await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, nextInfo)
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
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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

  const persistNoBpm = async (filePath: string) => {
    const normalizedPath = normalizePath(filePath)
    try {
      const stat = await fs.stat(filePath)
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
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        const entry = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
        const info = applyLiteDefaults(
          entry?.info ? { ...entry.info } : buildLiteSongInfo(filePath),
          filePath
        )
        stripBeatThisDebugInfo(info)
        if (!entry || Boolean(entry.info?.analysisOnly)) {
          info.analysisOnly = true
        }
        applyNoBpmBeatGridResult(info)
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
          const info = applyLiteDefaults(
            cached?.info ? { ...cached.info, filePath } : buildLiteSongInfo(filePath),
            filePath
          )
          stripBeatThisDebugInfo(info)
          info.analysisOnly = true
          applyNoBpmBeatGridResult(info)
          await LibraryCacheDb.upsertExternalAnalysisCacheEntry(externalContext, stat, info)
        }
      }

      const payload: BpmAnalysisResult = {
        filePath,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM
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
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION,
        beatGridStatus: BEAT_GRID_STATUS_NO_BPM,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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
      const surfaceData = buildWaveformSurfaceCacheDataFromUnifiedDisplay(
        unifiedDisplayWaveformData
      )
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
        beatGridStatus: existing?.beatGridStatus,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        hasWaveform: listRoot ? Boolean(surfaceData) : true
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
        if (unifiedDisplayWaveformData && surfaceData) {
          await LibraryCacheDb.upsertUnifiedDisplayWaveformCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            unifiedDisplayWaveformData
          )
          await LibraryCacheDb.upsertWaveformSurfaceCacheEntry(
            listRoot,
            filePath,
            { size: stat.size, mtimeMs: stat.mtimeMs },
            surfaceData
          )
          await LibraryCacheDb.removeMixtapeRawWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
        } else {
          await LibraryCacheDb.removeUnifiedDisplayWaveformCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformSurfaceCacheEntry(listRoot, filePath)
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
        beatGridAlgorithmVersion: existing?.beatGridAlgorithmVersion,
        beatGridStatus: existing?.beatGridStatus,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
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

  const prepareJob = async (job: KeyAnalysisJob): Promise<boolean> => {
    const filePath = job.filePath
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
        needsEnergy
      })
    const applyJobNeeds = () => {
      Object.assign(job, { needsKey, needsBpm, needsWaveform, needsEnergy })
    }
    const resolveCurrentEnergy = (
      info: { energyScore?: unknown; energyAlgorithmVersion?: unknown } | null | undefined
    ) => {
      if (!hasCurrentSongEnergyAnalysis(info)) return null
      const energyScore = normalizeSongEnergyScore(info?.energyScore)
      if (energyScore === undefined) return null
      return {
        energyScore,
        energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
      }
    }
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
    const done = deps.doneByPath.get(job.normalizedPath)
    if (done && done.size === stat.size && Math.abs(done.mtimeMs - stat.mtimeMs) < 1) {
      doneEntryHit = true
      const hasDoneBpm = isValidBpm(done.bpm)
      const hasDoneFirstBeatMs = isValidFirstBeatMs(done.firstBeatMs)
      const hasDoneBarBeatOffset = isValidBarBeatOffset(done.barBeatOffset)
      const hasDoneCurrentKeyAlgorithm = shouldAcceptKeyAnalysisCacheVersion(done)
      const hasDoneCurrentBeatGridAlgorithm = shouldAcceptBeatGridCacheVersion(done)
      const hasDoneNoBpm = hasCurrentNoBpmBeatGridResult(done)
      const hasDoneEnergy = hasCurrentSongEnergyAnalysis(done)
      if (isValidKeyText(done.keyText) && hasDoneCurrentKeyAlgorithm) {
        needsKey = false
      }
      if (
        hasDoneNoBpm ||
        (hasDoneBpm &&
          hasDoneFirstBeatMs &&
          hasDoneBarBeatOffset &&
          hasDoneCurrentBeatGridAlgorithm)
      ) {
        job.cachedBpm = done.bpm
        needsBpm = false
      }
      if (done.hasWaveform) {
        needsWaveform = false
      }
      if (hasDoneEnergy) {
        energyCacheHit = true
        needsEnergy = false
      }
      if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy) {
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
        const hasNoBpm = hasCurrentNoBpmBeatGridResult(cached.info)
        const hasCompleteCurrentGrid =
          hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm
        const cachedEnergy = resolveCurrentEnergy(cached.info)
        if (cachedEnergy) {
          energyCacheHit = true
          needsEnergy = false
        }
        if (hasKey || hasCompleteCurrentGrid || hasNoBpm || cachedEnergy) {
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
              : hasNoBpm
                ? cachedBeatGridAlgorithmVersion
                : undefined,
            beatGridStatus: hasNoBpm ? BEAT_GRID_STATUS_NO_BPM : undefined,
            energyScore: cachedEnergy?.energyScore,
            energyAlgorithmVersion: cachedEnergy?.energyAlgorithmVersion,
            hasWaveform: false
          })
        }
        if (needsKey && hasKey) {
          needsKey = false
        }
        if (
          needsBpm &&
          (hasNoBpm ||
            (hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm))
        ) {
          job.cachedBpm = cachedBpm
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
            energyScore: existingDone?.energyScore,
            energyAlgorithmVersion: existingDone?.energyAlgorithmVersion,
            hasWaveform: true
          })
          needsWaveform = false
        }
        if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy) {
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
          const hasNoBpm = hasCurrentNoBpmBeatGridResult(cached.info)
          const hasCompleteCurrentGrid =
            hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm
          const cachedEnergy = resolveCurrentEnergy(cached.info)
          if (cachedEnergy) {
            energyCacheHit = true
            needsEnergy = false
          }
          if (hasKey || hasCompleteCurrentGrid || hasNoBpm || cached.hasWaveform || cachedEnergy) {
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
                : hasNoBpm
                  ? cachedBeatGridAlgorithmVersion
                  : undefined,
              beatGridStatus: hasNoBpm ? BEAT_GRID_STATUS_NO_BPM : undefined,
              energyScore: cachedEnergy?.energyScore,
              energyAlgorithmVersion: cachedEnergy?.energyAlgorithmVersion,
              hasWaveform: cached.hasWaveform
            })
          }
          if (needsKey && hasKey) {
            needsKey = false
          }
          if (
            needsBpm &&
            (hasNoBpm ||
              (hasBpm && hasFirstBeatMs && hasBarBeatOffset && hasCurrentBeatGridAlgorithm))
          ) {
            job.cachedBpm = cachedBpm
            needsBpm = false
          }
          if (cached.hasWaveform) {
            waveformCacheHit = true
            needsWaveform = false
          }
          if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy) {
            applyJobNeeds()
            job.prepareReason = 'skip-external-cache-complete'
            job.prepareDetails = buildCurrentPrepareDetails()
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
        needsEnergy = false
      }
    }

    if (job.waveformOnly) {
      needsKey = false
      needsBpm = false
    }

    if (!needsKey && !needsBpm && !needsWaveform && !needsEnergy) {
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
    persistWaveform,
    prepareJob,
    removeCoverCacheForMissingTrack
  }
}

export type KeyAnalysisPersistence = ReturnType<typeof createKeyAnalysisPersistence>
