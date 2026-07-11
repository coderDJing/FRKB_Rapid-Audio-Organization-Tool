import { normalizeSongBeatGridMap } from '../../shared/songBeatGridMap'

type SharedSongGridCacheInfo = {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  beatGridMap?: unknown
  beatGridAlgorithmVersion?: unknown
}

export const shouldAcceptSharedSongGridCache = (info: SharedSongGridCacheInfo | null | undefined) =>
  normalizeSongBeatGridMap(info?.beatGridMap) !== null ||
  (Number.isFinite(Number(info?.bpm)) &&
    Number(info?.bpm) > 0 &&
    Number.isFinite(Number(info?.firstBeatMs)) &&
    Number.isFinite(Number(info?.barBeatOffset)))
