import fs from 'node:fs/promises'
import * as LibraryCacheDb from '../../libraryCacheDb'
import { stripBeatThisDebugInfo } from '../../libraryCacheDb/pathResolvers'
import { applyLiteDefaults, buildLiteSongInfo } from '../songInfoLite'
import type { ISongInfo } from '../../../types/globals'
import { CURRENT_SONG_ENERGY_ALGORITHM_VERSION } from '../../../shared/songEnergy'
import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis,
  type SongStructureAnalysis
} from '../../../shared/songStructure'

export type EnsureSongCacheEntryPayload = {
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
  songStructure?: SongStructureAnalysis | null
}

export const ensureSongCacheEntry = async (
  listRoot: string,
  filePath: string,
  payload: EnsureSongCacheEntryPayload,
  stat?: { size: number; mtimeMs: number },
  options: {
    shouldPersist?: () => boolean
    validateBeforeWrite?: () => boolean | Promise<boolean>
  } = {}
) => {
  const shouldPersist = () => options.shouldPersist?.() !== false
  if (!listRoot || !filePath || !shouldPersist()) return
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
  if (!shouldPersist()) return
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
    delete info.beatGridMap
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
  if (Object.prototype.hasOwnProperty.call(payload, 'songStructure')) {
    const songStructure = normalizeSongStructureAnalysis(payload.songStructure)
    if (songStructure) {
      info.songStructure = songStructure
    } else {
      delete info.songStructure
    }
  } else if (
    (payload.bpm !== undefined ||
      payload.firstBeatMs !== undefined ||
      payload.barBeatOffset !== undefined ||
      payload.beatGridStatus !== undefined) &&
    !hasUsableSongStructureAnalysis(info)
  ) {
    delete info.songStructure
  }
  const validation = options.validateBeforeWrite?.()
  if (validation instanceof Promise ? !(await validation) : validation === false) return
  if (!shouldPersist()) return
  await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    info
  })
}
