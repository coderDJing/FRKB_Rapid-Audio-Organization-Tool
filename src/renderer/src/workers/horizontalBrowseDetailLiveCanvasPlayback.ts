import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

export const PLAYHEAD_RATIO = 0.5
export const PLAYBACK_RENDER_INTERVAL_MS = 16
export const PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS = 48
export const PLAYBACK_RENDER_MIN_FRAME_GAP_MS = PLAYBACK_RENDER_INTERVAL_MS
export const PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS = PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS * 2
export const PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS = 120
export const PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES = 0
export const PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS = 30
export const PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS = 48

export const clampPlaybackRenderLeadMs = (value: number) => {
  const safeValue = Number.isFinite(value) ? value : PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS
  return Math.max(0, Math.min(PLAYBACK_INITIAL_FULL_RENDER_LEAD_MAX_MS, safeValue))
}

export const clampPlaybackRangeStart = (
  value: number,
  duration: number,
  visibleDuration: number
) => {
  if (!duration || !visibleDuration) return 0
  const leadingPad = visibleDuration * PLAYHEAD_RATIO
  const trailingPad = visibleDuration * (1 - PLAYHEAD_RATIO)
  return Math.min(Number.isFinite(value) ? value : 0, Math.max(-leadingPad, duration - trailingPad))
}

export const resolvePlaybackSeconds = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  baseSeconds: number,
  startedAtMs: number,
  nowMs = performance.now()
) => {
  const elapsedSec = Math.max(0, nowMs - startedAtMs) / 1000
  const playbackRate = Math.max(0, Number(request.playbackRate) || 1)
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  const seconds = baseSeconds + elapsedSec * playbackRate
  if (!Number.isFinite(seconds)) return 0
  return durationSec ? Math.min(seconds, durationSec) : seconds
}

export const resolvePlaybackRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  playbackSeconds: number
) => {
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  return clampPlaybackRangeStart(
    playbackSeconds - request.rangeDurationSec * PLAYHEAD_RATIO,
    durationSec,
    request.rangeDurationSec
  )
}
