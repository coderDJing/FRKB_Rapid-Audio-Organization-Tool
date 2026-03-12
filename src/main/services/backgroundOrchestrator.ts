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
  'mixtape-stem-resume': 400,
  'mixtape-waveform-hires': 350,
  'key-analysis': 300
}

const ORCHESTRATOR_TICK_MS = 5000

const pendingRequestMap = new Map<BackgroundTaskCategory, BackgroundTaskRequest>()
let runningState: BackgroundTaskRunningState | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let started = false
let flushInProgress = false
let flushRequested = false
let lastIdleBlockedSignature = ''

const debugDev = (message: string, payload?: unknown) => {
  if (!is.dev) return
  if (payload === undefined) {
    log.debug(`[background-orchestrator][dev] ${message}`)
    return
  }
  log.debug(`[background-orchestrator][dev] ${message}`, payload)
}

const listPendingCategories = (): Array<{
  category: BackgroundTaskCategory
  trigger: string
  waitMs: number
  priority: number
}> =>
  Array.from(pendingRequestMap.values())
    .map((request) => ({
      category: request.category,
      trigger: request.trigger,
      waitMs: Math.max(0, Date.now() - request.requestedAt),
      priority: CATEGORY_PRIORITY[request.category] || 0
    }))
    .sort((a, b) => b.priority - a.priority || a.waitMs - b.waitMs)

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
  const waitMs = Math.max(0, Date.now() - request.requestedAt)
  const currentRunning: BackgroundTaskRunningState = {
    category: request.category,
    startedAt: Date.now(),
    trigger: request.trigger
  }
  runningState = currentRunning
  debugDev('开始执行后台任务', {
    category: request.category,
    trigger: request.trigger,
    waitMs,
    pendingCategories: listPendingCategories()
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
    debugDev('后台任务执行结束', {
      category: request.category,
      trigger: request.trigger,
      durationMs: Date.now() - currentRunning.startedAt
    })
    runningState = null
  }
}

const flushPendingRequests = async () => {
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
        const signature = JSON.stringify({
          profile: idleSnapshot.profile,
          systemIdleState: idleSnapshot.systemIdleState,
          systemIdleSeconds: idleSnapshot.systemIdleSeconds,
          foregroundBusy: idleSnapshot.foregroundBusy,
          pending: Array.from(pendingRequestMap.keys()).sort()
        })
        if (signature !== lastIdleBlockedSignature) {
          lastIdleBlockedSignature = signature
          debugDev('后台任务等待闲置许可', {
            idleProfile: idleSnapshot.profile,
            systemIdleState: idleSnapshot.systemIdleState,
            systemIdleSeconds: idleSnapshot.systemIdleSeconds,
            foregroundBusy: idleSnapshot.foregroundBusy,
            pendingCategories: listPendingCategories()
          })
        }
        return
      }
      lastIdleBlockedSignature = ''
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
      void flushPendingRequests()
    }
  }
}

export const requestBackgroundTaskExecution = (params: {
  category: BackgroundTaskCategory
  run: () => Promise<void> | void
  trigger?: string
}) => {
  if (!started) {
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
  const replacedExisting = pendingRequestMap.has(category)
  pendingRequestMap.set(category, request)
  debugDev('收到后台任务请求', {
    category,
    trigger: request.trigger,
    replacedExisting,
    pendingCategories: listPendingCategories()
  })
  void flushPendingRequests()
}

export const startBackgroundOrchestrator = () => {
  if (started) return
  started = true
  tickTimer = setInterval(() => {
    void flushPendingRequests()
  }, ORCHESTRATOR_TICK_MS)
  tickTimer.unref?.()
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
}
