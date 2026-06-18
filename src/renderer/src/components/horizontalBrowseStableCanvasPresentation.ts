import { applyHorizontalBrowseCanvasPresentationOffset } from './horizontalBrowseCanvasGeometry'

export type HorizontalBrowseStableCanvasPresentationFrame = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
  viewportRangeStartSec: number
  anchorSec: number
  anchorStartedAtMs: number
  playbackRate: number
  renderWidth: number
  overscanCssPx: number
  pixelRatio: number
}

export const resolveHorizontalBrowseStableCanvasOffsetCssPx = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  viewportRangeStartSec: number
) => {
  const rangeDurationSec = Math.max(0.0001, Number(frame.rangeDurationSec) || 0.0001)
  const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
  const overscanSec =
    (Math.max(0, Number(frame.overscanCssPx) || 0) * rangeDurationSec) / renderWidth
  const requestedRangeStartSec = viewportRangeStartSec - overscanSec
  const rawOffset =
    ((frame.rangeStartSec - requestedRangeStartSec) * renderWidth) / rangeDurationSec
  const pixelRatio =
    Number.isFinite(frame.pixelRatio) && frame.pixelRatio > 0 ? frame.pixelRatio : 1
  return Math.round(rawOffset * pixelRatio) / pixelRatio
}

export const shouldReanchorHorizontalBrowseStableCanvas = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  offsetCssPx: number
) => {
  const overscanCssPx = Math.max(0, Number(frame.overscanCssPx) || 0)
  const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
  const viewportWidth = Math.max(1, renderWidth - overscanCssPx * 2)
  const viewportStepLimit = Math.min(64, Math.max(32, viewportWidth * 0.05))
  const reanchorOffsetLimit = Math.min(overscanCssPx * 0.7, viewportStepLimit)
  return offsetCssPx <= -Math.max(1, reanchorOffsetLimit)
}

export const canPresentHorizontalBrowseStableCanvas = (
  frame: HorizontalBrowseStableCanvasPresentationFrame,
  offsetCssPx: number
) => {
  const renderWidth = Math.max(1, Number(frame.renderWidth) || 1)
  const viewportWidth = Math.max(1, renderWidth - Math.max(0, Number(frame.overscanCssPx) || 0) * 2)
  const coverOffsetLimit = Math.max(0, (renderWidth - viewportWidth) * 0.5)
  return Math.abs(offsetCssPx) <= coverOffsetLimit
}

export const applyHorizontalBrowseStableCanvasPresentation = (
  waveformCanvas: HTMLCanvasElement | null,
  overlayCanvas: HTMLCanvasElement | null,
  offsetCssPx: number
) => {
  applyHorizontalBrowseCanvasPresentationOffset(waveformCanvas, overlayCanvas, offsetCssPx, true)
}

type StableCanvasRenderedPayload = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
  ready: boolean
  renderViewportOnly?: boolean
}

type StableCanvasPresentationControllerOptions = {
  isActive: () => boolean
  isPlaying: () => boolean
  isDragging: () => boolean
  currentSeconds: () => number
  playbackRate: () => number
  resolveViewportRangeStartSec: (seconds: number) => number
  waveformCanvas: () => HTMLCanvasElement | null
  overlayCanvas: () => HTMLCanvasElement | null
  scheduleDraw: () => void
  debugLabel?: () => string
}

type StableCanvasPresentationApplyOptions = {
  allowReanchor?: boolean
  requirePresentable?: boolean
}

type StableCanvasRenderedOptions = {
  forceViewportRangeStart?: boolean
}

type StableCanvasPresentationPlaybackClock = {
  seconds: number
  startedAtMs: number
  playbackRate: number
}

export type HorizontalBrowseStableCanvasPresentationApplyResult = {
  applied: boolean
  offsetCssPx: number | null
  presentable: boolean
}

export type HorizontalBrowseStableCanvasPresentationMeasureResult = {
  frame: HorizontalBrowseStableCanvasPresentationFrame | null
  offsetCssPx: number | null
  presentable: boolean
  reanchorNeeded: boolean
}

export const createHorizontalBrowseStableCanvasPresentationController = (
  options: StableCanvasPresentationControllerOptions
) => {
  let pendingFrame: HorizontalBrowseStableCanvasPresentationFrame | null = null
  let currentFrame: HorizontalBrowseStableCanvasPresentationFrame | null = null
  let reanchorPending = false
  let playbackClock: StableCanvasPresentationPlaybackClock | null = null
  let playbackRaf = 0

  const clearPlaybackLoop = () => {
    if (!playbackRaf) return
    cancelAnimationFrame(playbackRaf)
    playbackRaf = 0
  }

  const estimatePlaybackSeconds = (nowMs = performance.now()) => {
    if (!playbackClock) return Number(options.currentSeconds()) || 0
    const elapsedSec = Math.max(0, nowMs - playbackClock.startedAtMs) / 1000
    return playbackClock.seconds + elapsedSec * playbackClock.playbackRate
  }

  const clear = () => {
    clearPlaybackLoop()
    playbackClock = null
    pendingFrame = null
    currentFrame = null
    reanchorPending = false
  }

  const queueFrame = (frame: HorizontalBrowseStableCanvasPresentationFrame | null) => {
    pendingFrame = frame
    if (!frame) {
      currentFrame = null
      reanchorPending = false
    }
  }

  const queueRenderFrame = (
    active: boolean,
    renderToken: number,
    rangeStartSec: number,
    rangeDurationSec: number,
    viewportRangeStartSec: number,
    anchorSec: number,
    anchorStartedAtMs: number,
    playbackRate: number,
    renderWidth: number,
    overscanCssPx: number,
    pixelRatio: number
  ) => {
    queueFrame(
      active
        ? {
            renderToken,
            rangeStartSec,
            rangeDurationSec,
            viewportRangeStartSec,
            anchorSec,
            anchorStartedAtMs,
            playbackRate,
            renderWidth,
            overscanCssPx,
            pixelRatio
          }
        : null
    )
  }

  const measure = (
    seconds = Number(options.currentSeconds()) || 0
  ): HorizontalBrowseStableCanvasPresentationMeasureResult => {
    if (!options.isActive() || !currentFrame) {
      return {
        frame: null,
        offsetCssPx: null,
        presentable: false,
        reanchorNeeded: false
      }
    }
    const offsetCssPx = resolveHorizontalBrowseStableCanvasOffsetCssPx(
      currentFrame,
      options.resolveViewportRangeStartSec(seconds)
    )
    const reanchorNeeded = shouldReanchorHorizontalBrowseStableCanvas(currentFrame, offsetCssPx)
    const presentable = canPresentHorizontalBrowseStableCanvas(currentFrame, offsetCssPx)
    return {
      frame: currentFrame,
      offsetCssPx,
      presentable,
      reanchorNeeded
    }
  }

  const apply = (
    seconds = Number(options.currentSeconds()) || 0,
    applyOptions: StableCanvasPresentationApplyOptions = {}
  ): HorizontalBrowseStableCanvasPresentationApplyResult => {
    const measured = measure(seconds)
    const currentFrame = measured.frame
    if (!currentFrame) {
      return { applied: false, offsetCssPx: null, presentable: false }
    }
    const offsetCssPx = measured.offsetCssPx ?? 0
    const reanchorNeeded = measured.reanchorNeeded
    const presentable = measured.presentable
    if (!presentable) {
      if (
        applyOptions.requirePresentable !== true &&
        applyOptions.allowReanchor !== false &&
        options.isPlaying() &&
        !options.isDragging() &&
        !reanchorPending
      ) {
        reanchorPending = true
        options.scheduleDraw()
      }
      return { applied: false, offsetCssPx, presentable }
    }
    applyHorizontalBrowseStableCanvasPresentation(
      options.waveformCanvas(),
      options.overlayCanvas(),
      offsetCssPx
    )
    const shouldReanchor =
      applyOptions.allowReanchor !== false &&
      options.isPlaying() &&
      !options.isDragging() &&
      !reanchorPending &&
      reanchorNeeded
    if (shouldReanchor) {
      reanchorPending = true
      options.scheduleDraw()
    }
    return { applied: true, offsetCssPx, presentable }
  }

  const tickPlayback = () => {
    playbackRaf = 0
    if (!playbackClock || !options.isActive() || !options.isPlaying() || options.isDragging()) {
      playbackClock = null
      return
    }
    const result = apply(estimatePlaybackSeconds(), { allowReanchor: true })
    if (result.applied) {
      playbackRaf = requestAnimationFrame(tickPlayback)
      return
    }
    playbackClock = null
  }

  const startPlayback = (seconds: number, playbackRate: number) => {
    playbackClock = {
      seconds,
      startedAtMs: performance.now(),
      playbackRate: Math.max(0.25, Number(playbackRate) || 1)
    }
    if (!playbackRaf) {
      playbackRaf = requestAnimationFrame(tickPlayback)
    }
  }

  const stopPlayback = () => {
    clearPlaybackLoop()
    playbackClock = null
  }

  const reanchorPlayback = (seconds: number, playbackRate: number) => {
    const rate = Math.max(0.25, Number(playbackRate) || 1)
    playbackClock = {
      seconds,
      startedAtMs: performance.now(),
      playbackRate: rate
    }
    if (options.isActive() && options.isPlaying() && !options.isDragging() && !playbackRaf) {
      playbackRaf = requestAnimationFrame(tickPlayback)
    }
  }

  const resumePlaybackFrom = (seconds: number) => {
    if (!options.isActive() || !options.isPlaying() || options.isDragging()) return
    reanchorPlayback(seconds, options.playbackRate())
  }

  const applyViewportRangeStart = (
    viewportRangeStartSec: number,
    applyOptions: StableCanvasPresentationApplyOptions = {}
  ) => {
    if (!options.isActive() || !currentFrame) return false
    const offsetCssPx = resolveHorizontalBrowseStableCanvasOffsetCssPx(
      currentFrame,
      viewportRangeStartSec
    )
    const presentable = canPresentHorizontalBrowseStableCanvas(currentFrame, offsetCssPx)
    if (!presentable) return false
    applyHorizontalBrowseStableCanvasPresentation(
      options.waveformCanvas(),
      options.overlayCanvas(),
      offsetCssPx
    )
    return true
  }

  const handleRendered = (
    payload: StableCanvasRenderedPayload,
    renderedOptions: StableCanvasRenderedOptions = {}
  ) => {
    if (payload.renderToken !== pendingFrame?.renderToken) return false
    const renderedFrame = pendingFrame
    const pendingViewportRangeStartSec = pendingFrame.viewportRangeStartSec
    currentFrame = payload.ready
      ? {
          ...renderedFrame,
          rangeStartSec: payload.rangeStartSec,
          rangeDurationSec: payload.rangeDurationSec
        }
      : null
    pendingFrame = null
    reanchorPending = false
    if (payload.ready && options.isActive()) {
      if (renderedOptions.forceViewportRangeStart === true) {
        applyViewportRangeStart(pendingViewportRangeStartSec)
        if (options.isPlaying() && !playbackClock) {
          resumePlaybackFrom(renderedFrame.anchorSec)
        }
      } else if (!options.isPlaying()) {
        applyViewportRangeStart(pendingViewportRangeStartSec)
      } else {
        const pendingPlaybackSeconds =
          renderedFrame.anchorSec +
          (Math.max(0, performance.now() - renderedFrame.anchorStartedAtMs) / 1000) *
            renderedFrame.playbackRate
        const seconds = playbackClock ? estimatePlaybackSeconds() : pendingPlaybackSeconds
        const result = apply(seconds)
        if (result.applied && options.isPlaying() && !playbackClock) {
          resumePlaybackFrom(seconds)
        }
      }
    }
    return true
  }

  return {
    clear,
    queueFrame,
    queueRenderFrame,
    handleRendered,
    measure,
    apply,
    applyViewportRangeStart,
    startPlayback,
    stopPlayback,
    reanchorPlayback,
    isActive: options.isActive
  }
}
