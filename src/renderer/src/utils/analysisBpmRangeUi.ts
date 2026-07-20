import { t } from '@renderer/utils/translate'
import {
  LEGACY_ANALYSIS_BPM_RANGE,
  listAnalysisBpmRanges,
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'

export const buildAnalysisBpmRangeOptions = (currentValue: unknown) => {
  const currentId = normalizeAnalysisBpmRangeId(currentValue)
  const includeLegacy = currentId === LEGACY_ANALYSIS_BPM_RANGE.id
  const ranges = listAnalysisBpmRanges(includeLegacy)
  if (includeLegacy) {
    ranges.sort((left, right) =>
      left.id === LEGACY_ANALYSIS_BPM_RANGE.id
        ? -1
        : right.id === LEGACY_ANALYSIS_BPM_RANGE.id
          ? 1
          : 0
    )
  }
  return ranges.map((range) => ({
    label:
      range.id === LEGACY_ANALYSIS_BPM_RANGE.id
        ? t('settings.analysisBpmRange.legacyOption', { range: range.id })
        : range.id,
    value: range.id satisfies AnalysisBpmRangePresetId
  }))
}
