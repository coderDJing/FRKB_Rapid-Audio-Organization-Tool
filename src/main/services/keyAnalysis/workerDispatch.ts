import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'
import type { KeyAnalysisJob } from './types'

export const buildKeyAnalysisWorkerMessage = async (job: KeyAnalysisJob) => {
  const analyzedTimeBasisOffsetMs =
    job.needsStructure && job.needsBpm && !job.cachedBeatGridMap
      ? await resolveAudioTimeBasisOffsetMsForFile(job.filePath)
      : undefined
  return {
    jobId: job.jobId,
    filePath: job.filePath,
    fastAnalysis: job.fastAnalysis,
    needsKey: job.needsKey,
    needsBpm: job.needsBpm,
    needsWaveform: job.needsWaveform,
    needsEnergy: job.needsEnergy,
    needsStructure: job.needsStructure,
    cachedBpm: job.cachedBpm,
    cachedFirstBeatMs: job.cachedFirstBeatMs,
    cachedBarBeatOffset: job.cachedBarBeatOffset,
    cachedBeatGridMap: job.cachedBeatGridMap,
    cachedUnifiedDisplayWaveformData: job.cachedUnifiedDisplayWaveformData,
    analyzedTimeBasisOffsetMs
  }
}
