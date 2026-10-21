import { Session, type Profiler } from 'node:inspector'
import { log } from '../log'

type ProfileWindow = { profile: Profiler.Profile; endedAtMs: number }

/** V8 栈采样只代表 JS 调用边界；采样空洞不代表空闲，也不能提供原生锁栈。 */
export const summarizeStallProfiles = (
  windows: ProfileWindow[],
  sinceMs: number,
  untilMs: number
) => {
  const stacks = new Map<string, { samples: number; frames: string[] }>()
  let sampleCount = 0
  let maxSampleGapMs = 0
  for (const { profile, endedAtMs } of windows) {
    const wallStart = endedAtMs - (profile.endTime - profile.startTime) / 1000
    if (endedAtMs < sinceMs || wallStart > untilMs) continue
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
    const parents = new Map<number, number>()
    for (const node of profile.nodes) {
      for (const child of node.children || []) parents.set(child, node.id)
    }
    let sampledAt = wallStart
    for (let index = 0; index < (profile.samples?.length || 0); index++) {
      const gapMs = (profile.timeDeltas?.[index] || 0) / 1000
      const previousSampleAt = sampledAt
      sampledAt += gapMs
      if (sampledAt >= sinceMs && previousSampleAt <= untilMs) {
        maxSampleGapMs = Math.max(
          maxSampleGapMs,
          Math.min(sampledAt, untilMs) - Math.max(previousSampleAt, sinceMs)
        )
      }
      if (sampledAt < sinceMs || sampledAt > untilMs) continue
      let nodeId: number | undefined = profile.samples?.[index]
      const frames: string[] = []
      while (nodeId !== undefined && frames.length < 16) {
        const node = nodes.get(nodeId)
        if (!node) break
        const frame = node.callFrame
        frames.push(
          `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
        )
        nodeId = parents.get(nodeId)
      }
      const key = frames.join('\n')
      const entry = stacks.get(key) || { samples: 0, frames }
      entry.samples++
      stacks.set(key, entry)
      sampleCount++
    }
    // 原生调用期间采样可能中断，连最后一个样本到窗口结束的空洞也要保留。
    if (endedAtMs >= sinceMs && sampledAt <= untilMs) {
      maxSampleGapMs = Math.max(
        maxSampleGapMs,
        Math.min(endedAtMs, untilMs) - Math.max(sampledAt, sinceMs)
      )
    }
  }
  return {
    sinceMs,
    untilMs,
    sampleCount,
    maxSampleGapMs: Math.round(maxSampleGapMs),
    topStacks: [...stacks.values()].sort((a, b) => b.samples - a.samples).slice(0, 8),
    limitation: 'JS sampling only; missing samples do not prove idle or identify native lock owners'
  }
}

/**
 * 用户要求保留的 RC 卡顿诊断。10ms 采样、30 秒轮换，最多保留两个已完成窗口；
 * 只有发生卡顿才把栈摘要写入 log.txt。FRKB_RC_STALL_PROFILING=0 可关闭。
 * 根因修复且连续复测无卡顿后，移除此模块和调用点。
 */
export const startMainThreadStallProfiler = () => {
  if (process.env.FRKB_RC_STALL_PROFILING === '0') return null
  const session = new Session()
  const windows: ProfileWindow[] = []
  let disposed = false
  let rotating = false
  let running = false
  let failed = false
  const pending: Array<{ sinceMs: number; untilMs: number }> = []
  const fail = (error: Error) => {
    if (!failed && !disposed) log.error('[main-stall-profiler] sampling failed', error)
    failed = true
    session.disconnect()
  }
  const flush = () => {
    for (const interval of pending.splice(0)) {
      log.warn(
        '[main-stall-profiler] stall stacks',
        JSON.stringify(summarizeStallProfiles(windows, interval.sinceMs, interval.untilMs))
      )
    }
  }
  const start = () => {
    session.post('Profiler.start', (error) => {
      if (error) return fail(error)
      running = true
      if (disposed) session.disconnect()
    })
  }
  const rotate = () => {
    if (disposed || failed || rotating || !running) return
    rotating = true
    session.post('Profiler.stop', (error, result) => {
      rotating = false
      running = false
      if (disposed) return
      if (error) return fail(error)
      windows.push({ profile: result.profile, endedAtMs: Date.now() })
      if (windows.length > 2) windows.shift()
      start()
      flush()
    })
  }
  try {
    session.connect()
    session.post('Profiler.enable', (error) => {
      if (error) return fail(error)
      session.post('Profiler.setSamplingInterval', { interval: 10_000 }, (error) => {
        if (error) return fail(error)
        start()
      })
    })
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
  const timer = setInterval(rotate, 30_000)
  timer.unref()
  return {
    capture: (sinceMs: number, untilMs: number) => {
      if (disposed || failed) return
      pending.push({ sinceMs, untilMs })
      rotate()
    },
    dispose: () => {
      disposed = true
      clearInterval(timer)
      session.disconnect()
      windows.length = 0
      pending.length = 0
    }
  }
}
