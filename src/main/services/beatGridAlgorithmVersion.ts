export const CURRENT_BEAT_GRID_ALGORITHM_VERSION = 8

export type BeatGridCacheVersionInfo = {
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
}

export const normalizeBeatGridAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

const normalizeBeatThisWindowCount = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

export const hasCurrentBeatGridAlgorithmVersion = (value: unknown) =>
  (normalizeBeatGridAlgorithmVersion(value) ?? 0) >= CURRENT_BEAT_GRID_ALGORITHM_VERSION

export const isVersionedBeatGridCache = (info: BeatGridCacheVersionInfo | null | undefined) =>
  normalizeBeatThisWindowCount(info?.beatThisWindowCount) !== undefined

export const shouldAcceptBeatGridCacheVersion = (
  info: BeatGridCacheVersionInfo | null | undefined
) => {
  const version = normalizeBeatGridAlgorithmVersion(info?.beatGridAlgorithmVersion)
  if (version !== undefined) {
    return version >= CURRENT_BEAT_GRID_ALGORITHM_VERSION
  }
  return !isVersionedBeatGridCache(info)
}
