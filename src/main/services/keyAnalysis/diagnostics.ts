import type { KeyAnalysisDiagnosticPhase, KeyAnalysisJob } from './types'

/**
 * 用户要求保留的 RC/开发诊断：活动 job 只存最近 12 个阶段，失败或卡顿时才落盘。
 * workerElapsedMs / workerThreadCpuMs 是本任务的累计墙钟 / 当前 worker 线程 CPU，
 * phaseDeliveryLagMs 用于区分 worker 慢和主进程接收消息慢，不代表具体锁等待。
 * 确认根因修复且连续复测无异常后，移除本模块和对应 worker 阶段回调。
 */
export const recordKeyAnalysisDiagnosticPhase = (
  job: KeyAnalysisJob,
  diagnostic: KeyAnalysisDiagnosticPhase
) => {
  job.trace = {
    ...job.trace,
    diagnosticPhases: [
      ...(job.trace?.diagnosticPhases || []),
      { ...diagnostic, phase: diagnostic.phase.slice(0, 120), receivedAtMs: Date.now() }
    ].slice(-12)
  }
}

export const getKeyAnalysisJobDiagnostics = (jobs: Iterable<KeyAnalysisJob>) => {
  const now = Date.now()
  return Array.from(jobs)
    .slice(0, 8)
    .map((job) => {
      const phase = job.trace?.diagnosticPhases?.at(-1)
      return {
        jobId: job.jobId,
        filePath: job.filePath,
        source: job.source,
        needsEnergy: job.needsEnergy,
        needsStructure: job.needsStructure,
        stage: job.trace?.lastStage,
        elapsedMs: job.startTime ? now - job.startTime : null,
        phase,
        phaseAgeMs: phase ? now - phase.startedAtMs : null,
        phaseDeliveryLagMs: phase ? phase.receivedAtMs - phase.startedAtMs : null,
        recentPhases: job.trace?.diagnosticPhases
      }
    })
}
