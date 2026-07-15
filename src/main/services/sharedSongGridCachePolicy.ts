import { normalizeSongBeatGridMapV2 } from '../../shared/songBeatGridMapV2'

const getBeatGridMap = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { beatGridMap?: unknown }).beatGridMap
    : undefined

export const shouldAcceptSharedSongGridCache = (info: unknown) =>
  normalizeSongBeatGridMapV2(getBeatGridMap(info), { allowSingleClip: true }) !== null
