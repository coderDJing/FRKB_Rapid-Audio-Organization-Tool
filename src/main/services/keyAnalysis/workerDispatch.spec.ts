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
      needsStructure: true
    })
  })
})
