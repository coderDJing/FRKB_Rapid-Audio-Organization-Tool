import { normalizeSongStructureAnalysis } from '../../shared/songStructure'
import type { ISongInfo } from '../../types/globals'

type SongStructureCarrier = Pick<ISongInfo, 'songStructure'>

// 段落分析已冻结：网格变化不得清除历史段落结果，也不再用旧网格语义判定其有效性。
export const discardIncompatibleSongStructure = (_info: SongStructureCarrier) => {}

export const preserveBestAvailableSongStructure = (
  target: SongStructureCarrier,
  cachedInfo?: SongStructureCarrier | null
) => {
  if (!cachedInfo || normalizeSongStructureAnalysis(target.songStructure)) return
  const structure = normalizeSongStructureAnalysis(cachedInfo.songStructure)
  if (!structure) return
  target.songStructure = structure
}
