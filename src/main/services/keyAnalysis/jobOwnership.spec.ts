import { describe, expect, it } from 'vitest'
import { hasCurrentKeyAnalysisJobOwnership } from './jobOwnership'

describe('KeyAnalysis 任务所有权', () => {
  it('只允许仍占有 Worker、inFlight 和路径槽位的任务提交结果', () => {
    const oldJob = { jobId: 1 }
    const nextJob = { jobId: 2 }
    const currentState = {
      terminationExpected: false,
      busyJobId: oldJob.jobId,
      inFlightJob: oldJob,
      activeJob: oldJob
    }

    expect(hasCurrentKeyAnalysisJobOwnership(oldJob, currentState)).toBe(true)
    expect(
      hasCurrentKeyAnalysisJobOwnership(oldJob, {
        ...currentState,
        terminationExpected: true
      })
    ).toBe(false)
    expect(
      hasCurrentKeyAnalysisJobOwnership(oldJob, {
        ...currentState,
        busyJobId: nextJob.jobId
      })
    ).toBe(false)
    expect(
      hasCurrentKeyAnalysisJobOwnership(oldJob, {
        ...currentState,
        inFlightJob: nextJob
      })
    ).toBe(false)
    expect(
      hasCurrentKeyAnalysisJobOwnership(oldJob, {
        ...currentState,
        activeJob: nextJob
      })
    ).toBe(false)
  })
})
