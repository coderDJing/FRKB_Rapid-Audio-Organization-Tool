export const CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION = 1

type KeyAnalysisCacheVersionInfo = {
  keyAnalysisAlgorithmVersion?: unknown
}

export const normalizeKeyAnalysisAlgorithmVersion = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1, Math.floor(numeric))
}

export const shouldAcceptKeyAnalysisCacheVersion = (
  info: KeyAnalysisCacheVersionInfo | null | undefined
) =>
  (normalizeKeyAnalysisAlgorithmVersion(info?.keyAnalysisAlgorithmVersion) ?? 0) >=
  CURRENT_KEY_ANALYSIS_ALGORITHM_VERSION
