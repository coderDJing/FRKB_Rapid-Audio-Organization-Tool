import type { AudioElementWithExtensions } from './webAudioPlayer.shared'

type HtmlSeekRequest = {
  audio: AudioElementWithExtensions
  timeSec: number
  manual: boolean
}

type HtmlSeekInFlight = HtmlSeekRequest & {
  timeoutId: number | null
}

type HtmlSeekRequestResult = {
  status: 'pending' | 'already-current' | 'error'
}

type HtmlSeekCompletion = {
  manual: boolean
  targetSec: number
  actualSec: number
  pending: boolean
}

const HTML_SEEK_NATIVE_TIMEOUT_MS = 900
const SAME_TARGET_EPSILON_SEC = 0.015

const readCurrentTime = (audio: AudioElementWithExtensions) =>
  Number.isFinite(audio.currentTime) ? audio.currentTime : 0

export const createBrowserPlayerHtmlSeekController = () => {
  let inFlight: HtmlSeekInFlight | null = null
  let queued: HtmlSeekRequest | null = null

  const clearTimeoutFor = (target: HtmlSeekInFlight) => {
    if (target.timeoutId === null) return
    window.clearTimeout(target.timeoutId)
    target.timeoutId = null
  }

  const finishInFlight = (target: HtmlSeekInFlight) => {
    clearTimeoutFor(target)
    if (inFlight === target) {
      inFlight = null
    }
  }

  const flushQueued = (audio: AudioElementWithExtensions) => {
    const next = queued
    queued = null
    if (!next || next.audio !== audio) return
    apply(next)
  }

  const armTimeout = (target: HtmlSeekInFlight) => {
    target.timeoutId = window.setTimeout(() => {
      if (inFlight !== target) return
      finishInFlight(target)
      flushQueued(target.audio)
    }, HTML_SEEK_NATIVE_TIMEOUT_MS)
  }

  const apply = (request: HtmlSeekRequest): HtmlSeekRequestResult => {
    const currentSec = readCurrentTime(request.audio)
    if (
      !request.audio.seeking &&
      Math.abs(currentSec - request.timeSec) < SAME_TARGET_EPSILON_SEC
    ) {
      return { status: 'already-current' }
    }

    const target: HtmlSeekInFlight = {
      ...request,
      timeoutId: null
    }
    inFlight = target
    armTimeout(target)

    try {
      if (typeof request.audio.fastSeek === 'function') {
        request.audio.fastSeek(request.timeSec)
      } else {
        request.audio.currentTime = request.timeSec
      }
    } catch {
      finishInFlight(target)
      return { status: 'error' }
    }
    return { status: 'pending' }
  }

  const requestSeek = (request: HtmlSeekRequest): HtmlSeekRequestResult => {
    if (inFlight) {
      if (inFlight.audio === request.audio) {
        queued = request
        return { status: 'pending' }
      }
      finishInFlight(inFlight)
      queued = null
    }
    return apply(request)
  }

  const handleSeeked = (audio: AudioElementWithExtensions): HtmlSeekCompletion | null => {
    const target = inFlight
    if (!target || target.audio !== audio) return null
    finishInFlight(target)
    flushQueued(audio)
    return {
      manual: target.manual,
      targetSec: target.timeSec,
      actualSec: readCurrentTime(audio),
      pending: Boolean(inFlight)
    }
  }

  const reset = () => {
    if (inFlight) {
      clearTimeoutFor(inFlight)
    }
    inFlight = null
    queued = null
  }

  return {
    requestSeek,
    handleSeeked,
    reset
  }
}
