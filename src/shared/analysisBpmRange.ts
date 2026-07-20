export const ANALYSIS_BPM_RANGE_PRESETS = [
  { id: '70-180', minBpm: 70, maxBpm: 180 },
  { id: '48-95', minBpm: 48, maxBpm: 95 },
  { id: '58-115', minBpm: 58, maxBpm: 115 },
  { id: '68-135', minBpm: 68, maxBpm: 135 },
  { id: '78-155', minBpm: 78, maxBpm: 155 },
  { id: '88-175', minBpm: 88, maxBpm: 175 },
  { id: '98-195', minBpm: 98, maxBpm: 195 },
  { id: '108-215', minBpm: 108, maxBpm: 215 },
  { id: '118-235', minBpm: 118, maxBpm: 235 },
  { id: '128-255', minBpm: 128, maxBpm: 255 }
] as const

export const LEGACY_ANALYSIS_BPM_RANGE = {
  id: '70-200',
  minBpm: 70,
  maxBpm: 200
} as const

export type AnalysisBpmRangePresetId =
  | (typeof ANALYSIS_BPM_RANGE_PRESETS)[number]['id']
  | typeof LEGACY_ANALYSIS_BPM_RANGE.id

export type AnalysisBpmRange = {
  id: AnalysisBpmRangePresetId
  minBpm: number
  maxBpm: number
}

export const DEFAULT_ANALYSIS_BPM_RANGE_ID: AnalysisBpmRangePresetId = '70-180'

const ALL_ANALYSIS_BPM_RANGES: readonly AnalysisBpmRange[] = [
  ...ANALYSIS_BPM_RANGE_PRESETS,
  LEGACY_ANALYSIS_BPM_RANGE
]

export const isAnalysisBpmRangePresetId = (value: unknown): value is AnalysisBpmRangePresetId =>
  typeof value === 'string' && ALL_ANALYSIS_BPM_RANGES.some((preset) => preset.id === value)

export const normalizeAnalysisBpmRangeId = (
  value: unknown,
  fallback: AnalysisBpmRangePresetId = DEFAULT_ANALYSIS_BPM_RANGE_ID
): AnalysisBpmRangePresetId => (isAnalysisBpmRangePresetId(value) ? value : fallback)

export const resolveAnalysisBpmRange = (
  value: unknown,
  fallback: AnalysisBpmRangePresetId = DEFAULT_ANALYSIS_BPM_RANGE_ID
): AnalysisBpmRange => {
  const id = normalizeAnalysisBpmRangeId(value, fallback)
  const preset = ALL_ANALYSIS_BPM_RANGES.find((item) => item.id === id)
  return preset ? { ...preset } : { ...ANALYSIS_BPM_RANGE_PRESETS[0] }
}

export const listAnalysisBpmRanges = (includeLegacy = false): AnalysisBpmRange[] => [
  ...ANALYSIS_BPM_RANGE_PRESETS.map((preset) => ({ ...preset })),
  ...(includeLegacy ? [{ ...LEGACY_ANALYSIS_BPM_RANGE }] : [])
]

export const isOctaveSafeAnalysisBpmRange = (range: AnalysisBpmRange) =>
  range.maxBpm < range.minBpm * 2
