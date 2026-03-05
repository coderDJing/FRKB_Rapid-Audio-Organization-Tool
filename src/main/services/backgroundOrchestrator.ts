import { is } from '@electron-toolkit/utils'
import { log } from '../log'
import { getBackgroundIdleSnapshot } from './backgroundIdleGate'

export type BackgroundTaskCategory =
  | 'key-analysis'
  | 'mixtape-stem-resume'
  | 'mixtape-waveform-hires'

type BackgroundTaskRequest = {
  category: BackgroundTaskCategory
  trigger: string
  requestedAt: number
  run: () => Promise<void>
}

type BackgroundTaskRunningState = {
  category: BackgroundTaskCategory
  startedAt: number
  trigger: string
}

const CATEGORY_PRIORITY: Record<BackgroundTaskCategory, number> = {
  'key-analysis': 400,
  'mixtape-stem-resume': 300,
  'mixtape-waveform-hires': 200
}

const ORCHESTRATOR_TICK_MS = 5000

const pendingRequestMap = new Map<BackgroundTaskCategory, BackgroundTaskRequest>()
let runningState: BackgroundTaskRunningState | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let started = false
let flushInProgress = false
let flushRequested = false
let lastDeniedSnapshot = ''

const debugDev = (message: string, payload?: unknown) => {
  if (!is.dev) return
  if (payload === undefined) {
    log.debug(`[background-orchestrator][dev] ${message}`)
    return
  }
  log.debug(`[background-orchestrator][dev] ${message}`, payload)
}

const pickNextRequest = (): BackgroundTaskRequest | null => {
  if (pendingRequestMap.size === 0) return null
  let next: BackgroundTaskRequest | null = null
  for (const request of pendingRequestMap.values()) {
    if (!next) {
      next = request
      continue
    }
    const currentPriority = CATEGORY_PRIORITY[request.category] || 0
    const nextPriority = CATEGORY_PRIORITY[next.category] || 0
    if (currentPriority > nextPriority) {
      next = request
      continue
    }
    if (currentPriority === nextPriority && request.requestedAt < next.requestedAt) {
      next = request
    }
  }
  return next
}

const runRequest = async (request: BackgroundTaskRequest) => {
  const currentRunning: BackgroundTaskRunningState = {
    category: request.category,
    startedAt: Date.now(),
    trigger: request.trigger
  }
  runningState = currentRunning
  debugDev('开始执行后台任务', {
    category: request.category,
    trigger: request.trigger,
    priority: CATEGORY_PRIORITY[request.category] || 0
  })
  try {
    await request.run()
  } catch (error) {
    log.error('[background-orchestrator] background task failed', {
      category: request.category,
      trigger: request.trigger,
      error
    })
  } finally {
    const elapsedMs = Date.now() - currentRunning.startedAt
    debugDev('后台任务执行完成', {
      category: currentRunning.category,
      trigger: currentRunning.trigger,
      elapsedMs
    })
    runningState = null
  }
}

const flushPendingRequests = async (trigger: string) => {
  if (!started) return
  if (flushInProgress) {
    flushRequested = true
    return
  }
  flushInProgress = true
  try {
    while (true) {
      if (runningState) return
      if (pendingRequestMap.size === 0) return
      const idleSnapshot = getBackgroundIdleSnapshot()
      if (!idleSnapshot.allowed) {
        const pendingCategorySummary = Array.from(pendingRequestMap.keys()).sort().join(',')
        const denyReason = idleSnapshot.foregroundBusy
          ? 'foreground-busy'
          : idleSnapshot.systemIdleEnough
            ? 'unknown'
            : 'system-not-idle'
        const denySummary = `${denyReason}|${idleSnapshot.systemIdleState}|${idleSnapshot.idleThresholdSec}|${idleSnapshot.deepIdleThresholdSec}|${pendingCategorySummary}`
        if (lastDeniedSnapshot !== denySummary) {
          lastDeniedSnapshot = denySummary
          debugDev('闲时闸门未打开，延后后台任务', {
            trigger,
            denyReason,
            pendingCategories: pendingCategorySummary ? pendingCategorySummary.split(',') : [],
            idleSnapshot
          })
        }
        return
      }
      lastDeniedSnapshot = ''
      const nextRequest = pickNextRequest()
      if (!nextRequest) return
      pendingRequestMap.delete(nextRequest.category)
      await runRequest(nextRequest)
      if (!flushRequested) {
        if (pendingRequestMap.size === 0) return
        continue
      }
      flushRequested = false
    }
  } finally {
    flushInProgress = false
    if (flushRequested) {
      flushRequested = false
      void flushPendingRequests('flush-queued')
    }
  }
}

export const requestBackgroundTaskExecution = (params: {
  category: BackgroundTaskCategory
  run: () => Promise<void> | void
  trigger?: string
}) => {
  if (!started) {
    debugDev('调度器未启动，忽略后台任务请求', {
      category: params.category,
      trigger: String(params.trigger || 'manual')
    })
    return
  }
  const category = params.category
  const request: BackgroundTaskRequest = {
    category,
    trigger: String(params.trigger || 'manual'),
    requestedAt: Date.now(),
    run: async () => {
      await Promise.resolve(params.run())
    }
  }
  const replaced = pendingRequestMap.has(category)
  pendingRequestMap.set(category, request)
  debugDev(replaced ? '刷新后台任务请求' : '挂起后台任务请求', {
    category,
    trigger: request.trigger,
    pendingCount: pendingRequestMap.size,
    pendingCategories: Array.from(pendingRequestMap.keys())
  })
  void flushPendingRequests(`request:${category}`)
}

export const startBackgroundOrchestrator = () => {
  if (started) return
  started = true
  tickTimer = setInterval(() => {
    void flushPendingRequests('tick')
  }, ORCHESTRATOR_TICK_MS)
  tickTimer.unref?.()
  debugDev('启动后台统一调度器', {
    tickMs: ORCHESTRATOR_TICK_MS,
    priority: CATEGORY_PRIORITY
  })
}

export const stopBackgroundOrchestrator = () => {
  started = false
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  pendingRequestMap.clear()
  runningState = null
  flushInProgress = false
  flushRequested = false
  lastDeniedSnapshot = ''
  debugDev('停止后台统一调度器')
}
