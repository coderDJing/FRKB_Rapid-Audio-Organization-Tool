import type { ISongInfo } from '../../types/globals'
import type { SongBeatGridMap } from '../../shared/songBeatGridMap'

type MixtapeAnalysisCopyField =
  | 'bpm'
  | 'originalBpm'
  | 'firstBeatMs'
  | 'barBeatOffset'
  | 'timeBasisOffsetMs'
  | 'beatGridAlgorithmVersion'
  | 'beatGridStatus'
  | 'beatGridMap'
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

export type MixtapeAnalysisInfo = Record<string, unknown> & {
  bpm?: number
  originalBpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
  timeBasisOffsetMs?: number
  beatGridAlgorithmVersion?: number
  beatGridStatus?: ISongInfo['beatGridStatus']
  beatGridMap?: SongBeatGridMap
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
  'bpm',
  'originalBpm',
  'firstBeatMs',
  'barBeatOffset',
  'timeBasisOffsetMs',
  'beatGridAlgorithmVersion',
  'beatGridStatus',
  'beatGridMap',
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
