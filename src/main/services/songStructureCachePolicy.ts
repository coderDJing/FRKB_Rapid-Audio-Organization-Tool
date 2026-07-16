import {
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from '../../shared/songStructure'
import type { ISongInfo } from '../../types/globals'

type SongStructureCarrier = Pick<ISongInfo, 'beatGridMap' | 'songStructure'>

export const discardIncompatibleSongStructure = (info: SongStructureCarrier) => {
  if (!normalizeSongStructureAnalysis(info.songStructure)) return
  if (!hasUsableSongStructureAnalysis(info)) delete info.songStructure
}

export const preserveBestAvailableSongStructure = (
  target: SongStructureCarrier,
  cachedInfo?: SongStructureCarrier | null
) => {
  if (!cachedInfo || hasUsableSongStructureAnalysis(target)) return
  const structure = normalizeSongStructureAnalysis(cachedInfo.songStructure)
  if (!structure) return
  if (!hasUsableSongStructureAnalysis({ ...target, songStructure: structure })) return
  target.songStructure = structure
}
