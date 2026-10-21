import type { KeyAnalysisDiagnosticPhase, KeyAnalysisJob } from './types'
import { log } from '../../log'

/**
 * 用户要求保留的 RC/开发诊断：活动 job 只存最近 12 个阶段，失败、卡顿或阶段超过 3 秒才落盘。
 * workerElapsedMs / workerThreadCpuMs 是本任务的累计墙钟 / 当前 worker 线程 CPU，
 * phaseDeliveryLagMs 用于区分 worker 慢和主进程接收消息慢，不代表具体锁等待。
 * workerMemory 的 RSS 是全进程值，其余是 worker isolate 值，最多每秒刷新一次。
 * 确认根因修复且连续复测无异常后，移除本模块和对应 worker 阶段回调。
 */
export const recordKeyAnalysisDiagnosticPhase = (
  job: KeyAnalysisJob,
  diagnostic: KeyAnalysisDiagnosticPhase
) => {
  const previous = job.trace?.diagnosticPhases?.at(-1)
  if (previous) {
    const elapsedMs = diagnostic.workerElapsedMs - previous.workerElapsedMs
    if (elapsedMs >= 3_000) {
      log.warn('[key-analysis] slow worker phase', {
        jobId: job.jobId,
        filePath: job.filePath,
        phase: previous.phase,
        nextPhase: diagnostic.phase,
        elapsedMs,
        threadCpuMs: diagnostic.workerThreadCpuMs - previous.workerThreadCpuMs,
        deliveryLagMs: Date.now() - diagnostic.startedAtMs,
        workerThreadId: diagnostic.workerThreadId,
        memoryBefore: previous.workerMemory,
        memoryAfter: diagnostic.workerMemory
      })
    }
  }
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
        needsKey: job.needsKey,
        needsBpm: job.needsBpm,
        needsEnergy: job.needsEnergy,
        needsStructure: job.needsStructure,
        stage: job.trace?.lastStage,
        elapsedMs:
          job.startTime !== undefined ? now - job.startTime : (phase?.workerElapsedMs ?? null),
        audio: {
          sampleRate: job.trace?.sampleRate,
          channels: job.trace?.channels,
          totalFrames: job.trace?.totalFrames,
          framesToProcess: job.trace?.framesToProcess
        },
        phase,
        phaseAgeMs: phase ? now - phase.startedAtMs : null,
        phaseDeliveryLagMs: phase ? phase.receivedAtMs - phase.startedAtMs : null,
        recentPhases: job.trace?.diagnosticPhases
      }
    })
}
