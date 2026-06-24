import { ipcMain } from 'electron'

type PlaybackForegroundState = 'start' | 'end'

type PlaybackForegroundPayload = {
  state?: PlaybackForegroundState
  source?: string
  filePath?: string
  requestId?: number | string
  reason?: string
}

type PlaybackForegroundEntry = {
  expiresAtMs: number
}

const PLAYBACK_FOREGROUND_ACTIVITY_CHANNEL = 'player:foreground-activity'
const PLAYBACK_FOREGROUND_STALE_MS = 8000
const PLAYBACK_FOREGROUND_IDLE_GRACE_MS = 300
const BACKGROUND_IO_WAIT_INTERVAL_MS = 60
const BACKGROUND_FILE_IO_MAX_CONCURRENCY = 1

const foregroundEntries = new Map<string, PlaybackForegroundEntry>()
let foregroundGraceUntilMs = 0
let ipcRegistered = false
let backgroundFileIoInFlight = 0
const backgroundFileIoWaiters: Array<() => void> = []

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const normalizeText = (value: unknown): string => String(value || '').trim()

const buildActivityKey = (payload: PlaybackForegroundPayload): string => {
  const source = normalizeText(payload.source) || 'unknown'
  const requestId = normalizeText(payload.requestId) || '0'
  const filePath = normalizeText(payload.filePath)
  return `${source}:${requestId}:${filePath}`
}

const pruneExpiredEntries = (nowMs = Date.now()) => {
  for (const [key, entry] of foregroundEntries) {
    if (entry.expiresAtMs <= nowMs) {
      foregroundEntries.delete(key)
    }
  }
}

const isPlaybackForegroundBusy = (nowMs = Date.now()): boolean => {
  pruneExpiredEntries(nowMs)
  return foregroundEntries.size > 0 || foregroundGraceUntilMs > nowMs
}

const acquireBackgroundFileIoSlot = async (): Promise<() => void> => {
  if (backgroundFileIoInFlight < BACKGROUND_FILE_IO_MAX_CONCURRENCY) {
    backgroundFileIoInFlight += 1
    return releaseBackgroundFileIoSlot
  }

  await new Promise<void>((resolve) => {
    backgroundFileIoWaiters.push(resolve)
  })
  return releaseBackgroundFileIoSlot
}

const releaseBackgroundFileIoSlot = () => {
  const next = backgroundFileIoWaiters.shift()
  if (next) {
    next()
    return
  }
  backgroundFileIoInFlight = Math.max(0, backgroundFileIoInFlight - 1)
}

function markPlaybackForegroundActivity(payload: PlaybackForegroundPayload) {
  const state = payload.state
  if (state !== 'start' && state !== 'end') return

  const nowMs = Date.now()
  const key = buildActivityKey(payload)
  if (state === 'start') {
    foregroundEntries.set(key, {
      expiresAtMs: nowMs + PLAYBACK_FOREGROUND_STALE_MS
    })
    return
  }

  foregroundEntries.delete(key)
  foregroundGraceUntilMs = Math.max(
    foregroundGraceUntilMs,
    nowMs + PLAYBACK_FOREGROUND_IDLE_GRACE_MS
  )
}

export function registerPlaybackForegroundActivityHandlers() {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.on(PLAYBACK_FOREGROUND_ACTIVITY_CHANNEL, (_event, payload: PlaybackForegroundPayload) => {
    markPlaybackForegroundActivity(payload || {})
  })
}

export async function waitForPlaybackForegroundIdle(
  _context: string,
  _payload: Record<string, unknown> = {}
): Promise<number> {
  const startedAtMs = Date.now()
  while (isPlaybackForegroundBusy()) {
    await delay(BACKGROUND_IO_WAIT_INTERVAL_MS)
  }

  return Date.now() - startedAtMs
}

export async function runPlaybackAwareBackgroundFileIo<T>(
  context: string,
  payload: Record<string, unknown>,
  task: () => Promise<T>
): Promise<T> {
  await waitForPlaybackForegroundIdle(`${context}:before-slot`, payload)
  const releaseSlot = await acquireBackgroundFileIoSlot()
  try {
    await waitForPlaybackForegroundIdle(`${context}:after-slot`, payload)
    return await task()
  } finally {
    releaseSlot()
  }
}
