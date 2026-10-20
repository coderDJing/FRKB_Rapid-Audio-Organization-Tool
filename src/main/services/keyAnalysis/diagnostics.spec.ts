import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyAnalysisJobDiagnostics, recordKeyAnalysisDiagnosticPhase } from './diagnostics'
import type { KeyAnalysisJob } from './types'

afterEach(() => vi.useRealTimers())

describe('analysis diagnostics', () => {
  it('阶段消息保留超时依据和持久化状态，只留下最近 12 个阶段', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2000)
    const job: KeyAnalysisJob = {
      jobId: 1,
      filePath: 'D:/music/song.mp3',
      normalizedPath: 'd:/music/song.mp3',
      priority: 'high',
      fastAnalysis: false,
      source: 'foreground',
      startTime: 500,
      trace: { lastStage: 'analyze-done', lastUpdateAt: 1000, partialBpmPersisted: true }
    }
    for (let index = 0; index < 20; index++) {
      recordKeyAnalysisDiagnosticPhase(job, {
        phase: `energy:embedding-batch:${index}`,
        startedAtMs: 1500,
        workerElapsedMs: 1000,
        workerThreadCpuMs: 20
      })
    }
    expect(job.trace).toMatchObject({
      lastStage: 'analyze-done',
      lastUpdateAt: 1000,
      partialBpmPersisted: true
    })
    expect(job.trace?.diagnosticPhases).toHaveLength(12)
    expect(getKeyAnalysisJobDiagnostics([job])[0]).toMatchObject({
      phase: { phase: 'energy:embedding-batch:19' },
      phaseAgeMs: 500,
      phaseDeliveryLagMs: 500,
      elapsedMs: 1500
    })
    expect(getKeyAnalysisJobDiagnostics([])).toEqual([])
  })
})
