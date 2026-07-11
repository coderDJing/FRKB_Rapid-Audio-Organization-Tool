import type { BuildSongStructureInput, SongStructureSection } from './songStructureCommon'
import { clusterSongStructureSpectralBars } from './songStructureSpectralClustering'
import { buildSongStructureSpectralFeatures } from './songStructureSpectralFeatures'
import { labelSongStructureSpectralSegments } from './songStructureSemanticLabels'

export type SongStructureSpectralCandidate = {
  sections: SongStructureSection[]
  confidence: number
  beatGridSignature?: string
}

export const buildSpectralSongStructureSections = (
  input: BuildSongStructureInput,
  durationSec: number
): SongStructureSpectralCandidate | null => {
  const featureSet = buildSongStructureSpectralFeatures(input, durationSec)
  if (!featureSet) return null
  const clustering = clusterSongStructureSpectralBars(featureSet.bars)
  if (!clustering) return null
  const labeled = labelSongStructureSpectralSegments(featureSet.bars, clustering)
  if (!labeled) return null
  return {
    ...labeled,
    beatGridSignature: featureSet.beatGridSignature
  }
}
