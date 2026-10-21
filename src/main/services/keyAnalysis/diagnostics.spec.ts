import { afterEach, describe, expect, it, vi } from 'vitest'
import { getKeyAnalysisJobDiagnostics, recordKeyAnalysisDiagnosticPhase } from './diagnostics'
import type { KeyAnalysisJob } from './types'

const mocks = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../../log', () => ({ log: mocks }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const makeJob = (): KeyAnalysisJob => ({
  jobId: 1,
  filePath: 'song.mp3',
  normalizedPath: 'song.mp3',
  priority: 'high',
  fastAnalysis: false,
  source: 'foreground'
})

describe('key analysis diagnostics', () => {
  it('阶段消息保留超时依据和持久化状态，只留下最近 12 个阶段', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2000)
    const job: KeyAnalysisJob = {
      ...makeJob(),
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

  it('主线程延迟接收 50 秒不会误报为 worker 阶段执行慢', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const job = makeJob()
    recordKeyAnalysisDiagnosticPhase(job, {
      phase: 'key:native-start',
      startedAtMs: 50_000,
      workerElapsedMs: 0,
      workerThreadCpuMs: 0
    })
    recordKeyAnalysisDiagnosticPhase(job, {
      phase: 'key:native-done',
      startedAtMs: 50_100,
      workerElapsedMs: 100,
      workerThreadCpuMs: 80
    })
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(getKeyAnalysisJobDiagnostics([job])[0].phaseDeliveryLagMs).toBe(49_900)
  })

  it('慢原生阶段结束后留下 CPU 差值，即使任务随后被移出活动队列', () => {
    const job = makeJob()
    const startedAtMs = Date.now()
    recordKeyAnalysisDiagnosticPhase(job, {
      phase: 'key:native-start',
      startedAtMs,
      workerElapsedMs: 0,
      workerThreadCpuMs: 0
    })
    recordKeyAnalysisDiagnosticPhase(job, {
      phase: 'key:native-done',
      startedAtMs,
      workerElapsedMs: 57_000,
      workerThreadCpuMs: 300,
      workerThreadId: 2
    })
    expect(mocks.warn).toHaveBeenCalledWith(
      '[key-analysis] slow worker phase',
      expect.objectContaining({
        filePath: 'song.mp3',
        phase: 'key:native-start',
        elapsedMs: 57_000,
        threadCpuMs: 300,
        workerThreadId: 2
      })
    )
  })
})
