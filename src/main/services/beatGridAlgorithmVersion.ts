import type { BeatGridStatus } from '../../types/globals'

export const CURRENT_BEAT_GRID_ALGORITHM_VERSION = 9
export const BEAT_GRID_STATUS_NO_BPM: BeatGridStatus = 'no-bpm'

type BeatGridCacheVersionInfo = {
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
  beatGridSource?: unknown
  beatGridStatus?: unknown
}

export const normalizeBeatGridAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

export const shouldAcceptBeatGridCacheVersion = (
  info: BeatGridCacheVersionInfo | null | undefined
) => {
  const version = normalizeBeatGridAlgorithmVersion(info?.beatGridAlgorithmVersion)
  if (version !== undefined) {
    return version >= CURRENT_BEAT_GRID_ALGORITHM_VERSION
  }
  return false
}

export const hasCurrentNoBpmBeatGridResult = (info: BeatGridCacheVersionInfo | null | undefined) =>
  info?.beatGridStatus === BEAT_GRID_STATUS_NO_BPM && shouldAcceptBeatGridCacheVersion(info)
