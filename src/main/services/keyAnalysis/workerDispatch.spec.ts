import { describe, expect, it } from 'vitest'
import { buildKeyAnalysisWorkerMessage } from './workerDispatch'
import { normalizePath, type KeyAnalysisJob } from './types'

describe('buildKeyAnalysisWorkerMessage', () => {
  it('dispatches v23 structure analysis to a worker', async () => {
    const job: KeyAnalysisJob = {
      jobId: 1,
      filePath: 'D:/music/legacy-segment.mp3',
      normalizedPath: normalizePath('D:/music/legacy-segment.mp3'),
      priority: 'medium',
      fastAnalysis: false,
      source: 'foreground',
      needsBpm: false,
      needsStructure: true
    }

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      needsStructure: true,
      analysisBpmRange: { id: '70-180', minBpm: 70, maxBpm: 180 }
    })
  })

  it('keeps the queued BPM range snapshot', async () => {
    const job: KeyAnalysisJob = {
      jobId: 2,
      filePath: 'D:/music/half-time.mp3',
      normalizedPath: normalizePath('D:/music/half-time.mp3'),
      priority: 'medium',
      fastAnalysis: false,
      source: 'foreground',
      needsBpm: true,
      analysisBpmRange: { id: '88-175', minBpm: 88, maxBpm: 175 }
    }

    await expect(buildKeyAnalysisWorkerMessage(job)).resolves.toMatchObject({
      analysisBpmRange: { id: '88-175', minBpm: 88, maxBpm: 175 }
    })
  })
})
