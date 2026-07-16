import type { SongBeatGridMapV2 } from './songBeatGridMapV2'
import type { SongStructureFeatureData } from './songStructureFeatureData'
import type { SongStructureSectionKind } from './songStructureCommon'
import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'

export const SONG_STRUCTURE_NATIVE_ALGORITHM_VERSION = 26
export const SONG_STRUCTURE_V23_FORMAT_VERSION = 2

export type BuildSongStructureV23Input = {
  waveformData: UnifiedDisplayWaveformDetailData | null | undefined
  structureFeatureData?: SongStructureFeatureData | null
  beatGridMap: SongBeatGridMapV2 | null | undefined
}

export type SongStructureSectionV23 = {
  startSec: number
  endSec: number
  startDownbeatOrdinal: number
  endDownbeatOrdinal: number
  kind: SongStructureSectionKind
  confidence: number
  energy: number
  low: number
  high: number
  novelty: number
}

export type SongStructureAnalysisV23 = {
  formatVersion: typeof SONG_STRUCTURE_V23_FORMAT_VERSION
  algorithmVersion: number
  source: 'algorithmic'
  durationSec: number
  beatGridSignature: string
  sections: SongStructureSectionV23[]
}
