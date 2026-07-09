import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventEmitter } from 'node:events'
import { findSongListRoot } from '../cacheMaintenance'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { buildLiteSongInfo } from '../songInfoLite'
import { log } from '../../log'
import {
  normalizeSongStructureAnalysis,
  type SongStructureAnalysis
} from '../../../shared/songStructure'
import { normalizePath, type DoneEntry } from './types'

type EnsureStructureSongCacheEntry = (
  listRoot: string,
  filePath: string,
  payload: {
    songStructure?: SongStructureAnalysis | null
  },
  stat?: { size: number; mtimeMs: number }
) => Promise<void>

type CreateStructurePersistenceParams = {
  doneByPath: Map<string, DoneEntry>
  events: EventEmitter
  ensureSongCacheEntry: EnsureStructureSongCacheEntry
  cleanupMissingPersistTarget: (normalizedPath: string, filePath: string) => Promise<void>
  isMissingFileError: (error: unknown) => boolean
}

export const createPersistSongStructure = (params: CreateStructurePersistenceParams) => {
  return async (filePath: string, songStructure: SongStructureAnalysis | null | undefined) => {
    const normalizedPath = normalizePath(filePath)
    const normalizedSongStructure = normalizeSongStructureAnalysis(songStructure)
    if (!normalizedSongStructure) return
    try {
      const stat = await fs.stat(filePath)
      const existing = params.doneByPath.get(normalizedPath)
      params.doneByPath.set(normalizedPath, {
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
        beatGridMap: existing?.beatGridMap,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: normalizedSongStructure,
        hasWaveform: existing?.hasWaveform
      })

      const listRoot = await findSongListRoot(path.dirname(filePath))
      if (listRoot) {
        await params.ensureSongCacheEntry(
          listRoot,
          filePath,
          { songStructure: normalizedSongStructure },
          { size: stat.size, mtimeMs: stat.mtimeMs }
        )
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
              songStructure: normalizedSongStructure,
              analysisOnly: true
            })
          )
        }
      }

      params.events.emit('structure-updated', {
        filePath,
        songStructure: normalizedSongStructure
      })
    } catch (error) {
      if (params.isMissingFileError(error)) {
        await params.cleanupMissingPersistTarget(normalizedPath, filePath)
        return
      }
      const existing = params.doneByPath.get(normalizedPath)
      params.doneByPath.set(normalizedPath, {
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
        beatGridMap: existing?.beatGridMap,
        energyScore: existing?.energyScore,
        energyAlgorithmVersion: existing?.energyAlgorithmVersion,
        songStructure: normalizedSongStructure,
        hasWaveform: existing?.hasWaveform
      })
      params.events.emit('structure-updated', {
        filePath,
        songStructure: normalizedSongStructure
      })
      log.error('[闲时分析] persistSongStructure 失败，已写入内存记录', {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
