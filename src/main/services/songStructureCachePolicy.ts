import {
  hasCurrentSongStructureAnalysis,
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from '../../shared/songStructure'
import type { ISongInfo } from '../../types/globals'

type SongStructureCarrier = Pick<
  ISongInfo,
  'songStructure' | 'bpm' | 'firstBeatMs' | 'barBeatOffset' | 'beatGridMap'
>

export const discardIncompatibleSongStructure = (info: SongStructureCarrier) => {
  if (!hasUsableSongStructureAnalysis(info)) delete info.songStructure
}

export const preserveBestAvailableSongStructure = (
  target: SongStructureCarrier,
  cachedInfo?: SongStructureCarrier | null
) => {
  if (!cachedInfo || hasCurrentSongStructureAnalysis(target)) return
  const structure = normalizeSongStructureAnalysis(cachedInfo.songStructure)
  if (!structure) return
  const candidateInfo = { ...target, songStructure: structure }
  if (!hasUsableSongStructureAnalysis(candidateInfo)) return
  if (hasUsableSongStructureAnalysis(target) && !hasCurrentSongStructureAnalysis(candidateInfo)) {
    return
  }
  target.songStructure = structure
}
