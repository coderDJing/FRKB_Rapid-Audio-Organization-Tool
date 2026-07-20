import type {
  KeyAnalysisJob,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory,
  KeyAnalysisRequestFlags,
  KeyAnalysisSource
} from './types'
import type { AnalysisBpmRangePresetId } from '../../../shared/analysisBpmRange'

export type KeyAnalysisEnqueueOptions = KeyAnalysisRequestFlags & {
  urgent?: boolean
  source?: KeyAnalysisSource
  fastAnalysis?: boolean
  focusSlot?: string
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
  analysisBpmRangeId?: AnalysisBpmRangePresetId
  manualBatchId?: string
  manualBatchIds?: string[]
}

export const isHigherKeyAnalysisPriority = (
  next: KeyAnalysisPriority,
  current: KeyAnalysisPriority
) => {
  const rank: Record<KeyAnalysisPriority, number> = {
    high: 4,
    medium: 3,
    low: 2,
    background: 1
  }
  return rank[next] > rank[current]
}

export const normalizeKeyAnalysisFocusSlot = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

export const applyKeyAnalysisWaveformOnlyOption = (job: KeyAnalysisJob, waveformOnly?: boolean) => {
  if (waveformOnly !== true) {
    if (waveformOnly === false || job.waveformOnly) job.waveformOnly = false
    return
  }
  if (job.waveformOnly === true) job.waveformOnly = true
}

export const applyKeyAnalysisQueueCategory = (
  job: KeyAnalysisJob,
  category?: KeyAnalysisQueueCategory
) => {
  if (!category) return
  if (job.category === 'manual-batch' && category !== 'manual-batch') return
  if (job.priority === 'high' && category === 'visible') return
  if (job.category === 'visible' && category === 'waveform-preview') return
  job.category = category
}

export const applyKeyAnalysisIncludeStructureOption = (
  job: KeyAnalysisJob,
  includeStructure?: boolean
) => {
  if (includeStructure === true) job.includeStructure = true
}

export const applyKeyAnalysisRequestFlags = (
  job: KeyAnalysisJob,
  flags: KeyAnalysisRequestFlags
) => {
  if (flags.forceAnalysis === true) job.forceAnalysis = true
}

export const normalizeManualBatchIds = (options: {
  manualBatchId?: string
  manualBatchIds?: string[]
}) => {
  const ids = [options.manualBatchId, ...(options.manualBatchIds || [])]
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)))
}

export const addManualBatchIdsToJob = (job: KeyAnalysisJob, batchIds: string[]) => {
  if (!batchIds.length) return
  const current = Array.isArray(job.manualBatchIds) ? job.manualBatchIds.filter(Boolean) : []
  job.manualBatchIds = Array.from(new Set([...current, ...batchIds]))
}

export const removeManualBatchIdFromJob = (job: KeyAnalysisJob, batchId: string) => {
  const current = job.manualBatchIds?.filter(Boolean) || []
  if (!current.includes(batchId)) return false
  const next = current.filter((id) => id !== batchId)
  job.manualBatchIds = next.length ? next : undefined
  return true
}
