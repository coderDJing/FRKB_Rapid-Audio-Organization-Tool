import type { KeyAnalysisJob } from './types'
import { resolveAudioTimeBasisOffsetMsForFile } from '../audioTimeBasisOffset'
import { resolveAnalysisBpmRange } from '../../../shared/analysisBpmRange'
import { isSqliteReadDiagnosticsEnabled } from '../sqliteReadDiagnostics'

export const buildKeyAnalysisWorkerMessage = async (job: KeyAnalysisJob) => {
  const analysisBpmRange = resolveAnalysisBpmRange(job.analysisBpmRange?.id)
  const analyzedTimeBasisOffsetMs =
    job.needsStructure && job.needsBpm
      ? await resolveAudioTimeBasisOffsetMsForFile(job.filePath)
      : undefined
  return {
    jobId: job.jobId,
    diagnostics: isSqliteReadDiagnosticsEnabled(),
    filePath: job.filePath,
    fastAnalysis: job.fastAnalysis,
    needsKey: job.needsKey,
    needsBpm: job.needsBpm,
    needsWaveform: job.needsWaveform,
    needsEnergy: job.needsEnergy,
    needsStructure: job.needsStructure,
    analysisBpmRange,
    cachedBpm: job.cachedBpm,
    cachedBeatGridMap: job.cachedBeatGridMap,
    cachedUnifiedDisplayWaveformData: job.cachedUnifiedDisplayWaveformData,
    analyzedTimeBasisOffsetMs
  }
}
