import { createUnifiedSongBeatGridRuntime } from './songBeatGridRuntime'
import { normalizeSongBeatGridMapV2 } from './songBeatGridMapV2'
import { clamp01, toFixedNumber } from './songStructureCommon'
import {
  buildSongStructureDirectionalBoundaries,
  type SongStructureDirectionalBoundaryResult
} from './songStructureDirectionalBoundaries'
import { labelSongStructureSpectralSegments } from './songStructureSemanticLabels'
import {
  buildSongStructureSpectralClusterModel,
  buildSongStructureSpectralClusteringFromModel,
  type SongStructureSpectralClusteringResult
} from './songStructureSpectralClustering'
import {
  buildSongStructureV23SpectralFeatures,
  type SongStructureSpectralFeatureSet
} from './songStructureSpectralFeatures'
import {
  SONG_STRUCTURE_NATIVE_ALGORITHM_VERSION,
  SONG_STRUCTURE_V23_FORMAT_VERSION,
  type BuildSongStructureV23Input,
  type SongStructureAnalysisV23,
  type SongStructureSectionV23
} from './songStructureV23Common'

export {
  SONG_STRUCTURE_NATIVE_ALGORITHM_VERSION,
  SONG_STRUCTURE_V23_FORMAT_VERSION,
  type BuildSongStructureV23Input,
  type SongStructureAnalysisV23,
  type SongStructureSectionV23
} from './songStructureV23Common'

const buildWholeSongSection = (
  durationSec: number,
  downbeatCount: number
): SongStructureSectionV23 => ({
  startSec: 0,
  endSec: toFixedNumber(durationSec, 3),
  startDownbeatOrdinal: 0,
  endDownbeatOrdinal: Math.max(1, downbeatCount),
  kind: 'groove',
  confidence: 0.35,
  energy: 0,
  low: 0,
  high: 0,
  novelty: 0
})

type SongStructureV23LabeledCandidate = NonNullable<
  ReturnType<typeof labelSongStructureSpectralSegments>
>

export type SongStructureV23SpectralCandidate = {
  featureSet: SongStructureSpectralFeatureSet
  clustering: SongStructureSpectralClusteringResult
  directional: SongStructureDirectionalBoundaryResult
  labeled: SongStructureV23LabeledCandidate
}

export const buildSongStructureV23SpectralCandidate = (
  input: BuildSongStructureV23Input,
  durationSec: number
): SongStructureV23SpectralCandidate | null => {
  const featureSet = buildSongStructureV23SpectralFeatures(input, durationSec)
  if (!featureSet) return null
  const clusterModel = buildSongStructureSpectralClusterModel(featureSet.bars)
  if (!clusterModel) return null
  // 原生路径只把 downbeat 当作可落点，不再推断或奖励固定乐句周期。
  const clustering = buildSongStructureSpectralClusteringFromModel(featureSet.bars, clusterModel, {
    useStoredPeriodicPrior: false,
    inferPeriodicPhase: false,
    boundaryContextBars: 2,
    boundaryRefineRadiusBars: 1
  })
  if (!clustering) return null
  const directional = buildSongStructureDirectionalBoundaries(featureSet.bars, clustering)
  const directionalClustering: SongStructureSpectralClusteringResult = {
    ...clustering,
    boundaries: directional.boundaries
  }
  const labeled = labelSongStructureSpectralSegments(featureSet.bars, directionalClustering)
  return labeled ? { featureSet, clustering: directionalClustering, directional, labeled } : null
}

export const buildSongStructureAnalysisV23 = (
  input: BuildSongStructureV23Input
): SongStructureAnalysisV23 | null => {
  const durationSec = Math.max(
    0,
    Number(input.waveformData?.duration ?? input.structureFeatureData?.durationSec) || 0
  )
  if (durationSec <= 0) return null
  const beatGridMap = normalizeSongBeatGridMapV2(input.beatGridMap, {
    durationSec,
    allowSingleClip: true
  })
  if (!beatGridMap) return null
  const runtime = createUnifiedSongBeatGridRuntime(beatGridMap, durationSec)
  if (!runtime) return null

  const spectralCandidate = buildSongStructureV23SpectralCandidate(
    { ...input, beatGridMap },
    durationSec
  )
  const labeled = spectralCandidate?.labeled
  const sections = labeled?.sections.length
    ? labeled.sections.map(
        (section): SongStructureSectionV23 => ({
          startSec: section.startSec,
          endSec: section.endSec,
          startDownbeatOrdinal: Math.max(0, section.startBar - 1),
          endDownbeatOrdinal: Math.max(section.startBar, section.endBar),
          kind: section.kind,
          confidence: section.confidence,
          energy: section.energy,
          low: section.low,
          high: section.high,
          novelty: section.novelty
        })
      )
    : [
        buildWholeSongSection(
          durationSec,
          runtime.lines.filter((line) => line.level === 'downbeat').length
        )
      ]

  return {
    formatVersion: SONG_STRUCTURE_V23_FORMAT_VERSION,
    algorithmVersion: SONG_STRUCTURE_NATIVE_ALGORITHM_VERSION,
    source: 'algorithmic',
    durationSec: toFixedNumber(durationSec, 3),
    beatGridSignature: runtime.signature,
    sections: sections.map((section) => ({
      ...section,
      confidence: toFixedNumber(clamp01(section.confidence), 3)
    }))
  }
}
