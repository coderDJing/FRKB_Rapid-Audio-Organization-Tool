import type { ISongInfo } from '../../types/globals'
import type { SongStructureAnalysis } from '../../shared/songStructure'

type MixtapeAnalysisCopyField =
  | 'originalBpm'
  | 'songStructure'
  | 'key'
  | 'originalKey'
  | 'stemStatus'
  | 'stemReadyAt'
  | 'stemModel'
  | 'stemVersion'
  | 'stemVocalPath'
  | 'stemInstPath'
  | 'stemBassPath'
  | 'stemDrumsPath'

export const MIXTAPE_GRID_COPY_FIELDS = [
  'bpm',
  'firstBeatMs',
  'downbeatBeatOffset',
  'barBeatOffset',
  'timeBasisOffsetMs',
  'beatGridSource',
  'beatGridStatus',
  'beatGridAlgorithmVersion',
  'beatGridMap'
] as const

export const stripMixtapeGridCopies = (info: Record<string, unknown>): boolean => {
  let removed = false
  for (const field of MIXTAPE_GRID_COPY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(info, field)) continue
    delete info[field]
    removed = true
  }
  return removed
}

export type MixtapeAnalysisInfo = Record<string, unknown> & {
  originalBpm?: number
  beatGridStatus?: ISongInfo['beatGridStatus']
  songStructure?: SongStructureAnalysis
  key?: string
  originalKey?: string
  stemStatus?: string
  stemReadyAt?: number
  stemModel?: string
  stemVersion?: string
  stemVocalPath?: string
  stemInstPath?: string
  stemBassPath?: string
  stemDrumsPath?: string
}

export const MIXTAPE_ANALYSIS_COPY_FIELDS: MixtapeAnalysisCopyField[] = [
  'originalBpm',
  'songStructure',
  'key',
  'originalKey',
  'stemStatus',
  'stemReadyAt',
  'stemModel',
  'stemVersion',
  'stemVocalPath',
  'stemInstPath',
  'stemBassPath',
  'stemDrumsPath'
]
