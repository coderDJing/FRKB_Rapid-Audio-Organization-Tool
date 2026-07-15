import type { KeyAnalysisJob } from './types'

export const buildKeyAnalysisWorkerMessage = async (job: KeyAnalysisJob) => {
  return {
    jobId: job.jobId,
    filePath: job.filePath,
    fastAnalysis: job.fastAnalysis,
    needsKey: job.needsKey,
    needsBpm: job.needsBpm,
    needsWaveform: job.needsWaveform,
    needsEnergy: job.needsEnergy,
    needsStructure: false,
    cachedBpm: job.cachedBpm,
    cachedUnifiedDisplayWaveformData: job.cachedUnifiedDisplayWaveformData,
    analyzedTimeBasisOffsetMs: undefined
  }
}
