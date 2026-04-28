import store from '../store'

export type BeatGridAnalyzerProvider = 'beatthis' | 'classic'

export const DEFAULT_BEAT_GRID_ANALYZER_PROVIDER: BeatGridAnalyzerProvider = 'beatthis'
export const ENV_BEAT_GRID_ANALYZER_PROVIDER = 'FRKB_BEAT_GRID_ANALYZER'

export const BEAT_GRID_ALGORITHM_VERSIONS: Record<BeatGridAnalyzerProvider, number> = {
  beatthis: 8,
  classic: 1
}

export const CURRENT_BEAT_GRID_ALGORITHM_VERSION =
  BEAT_GRID_ALGORITHM_VERSIONS[DEFAULT_BEAT_GRID_ANALYZER_PROVIDER]

export type BeatGridCacheVersionInfo = {
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
  beatGridAnalyzerProvider?: unknown
}

export const normalizeBeatGridAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

export const normalizeBeatGridAnalyzerProvider = (
  value: unknown
): BeatGridAnalyzerProvider | undefined => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '')
  if (normalized === 'beatthis') return 'beatthis'
  if (normalized === 'classic' || normalized === 'classical' || normalized === 'dsp') {
    return 'classic'
  }
  return undefined
}

export const resolveConfiguredBeatGridAnalyzerProvider = (): BeatGridAnalyzerProvider =>
  normalizeBeatGridAnalyzerProvider(process.env[ENV_BEAT_GRID_ANALYZER_PROVIDER]) ??
  normalizeBeatGridAnalyzerProvider(store.settingConfig?.beatGridAnalyzerProvider) ??
  DEFAULT_BEAT_GRID_ANALYZER_PROVIDER

export const getCurrentBeatGridAlgorithmVersion = (
  provider: BeatGridAnalyzerProvider = resolveConfiguredBeatGridAnalyzerProvider()
) => BEAT_GRID_ALGORITHM_VERSIONS[provider]

const normalizeBeatThisWindowCount = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

export const hasCurrentBeatGridAlgorithmVersion = (
  value: unknown,
  provider: BeatGridAnalyzerProvider = resolveConfiguredBeatGridAnalyzerProvider()
) => (normalizeBeatGridAlgorithmVersion(value) ?? 0) >= getCurrentBeatGridAlgorithmVersion(provider)

export const isVersionedBeatGridCache = (info: BeatGridCacheVersionInfo | null | undefined) =>
  normalizeBeatThisWindowCount(info?.beatThisWindowCount) !== undefined

export const shouldAcceptBeatGridCacheVersion = (
  info: BeatGridCacheVersionInfo | null | undefined,
  provider: BeatGridAnalyzerProvider = resolveConfiguredBeatGridAnalyzerProvider()
) => {
  const cachedProvider =
    normalizeBeatGridAnalyzerProvider(info?.beatGridAnalyzerProvider) ??
    DEFAULT_BEAT_GRID_ANALYZER_PROVIDER
  if (cachedProvider !== provider) return false

  const version = normalizeBeatGridAlgorithmVersion(info?.beatGridAlgorithmVersion)
  if (version !== undefined) {
    return version >= getCurrentBeatGridAlgorithmVersion(provider)
  }
  return provider === DEFAULT_BEAT_GRID_ANALYZER_PROVIDER && !isVersionedBeatGridCache(info)
}
