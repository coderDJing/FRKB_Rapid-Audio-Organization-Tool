type HorizontalBrowseWaveformSeekTransitionOptions = {
  waveformCanvas: () => HTMLCanvasElement | null
  resolveTargetStartSec: (targetSec: number) => number
  fadeInMs?: number
}

const SEEK_TRANSITION_RANGE_EPSILON_SEC = 0.35

type QueuedSeekTransitionRender = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
}

export const createHorizontalBrowseWaveformSeekTransition = (
  options: HorizontalBrowseWaveformSeekTransitionOptions
) => {
  let active = false
  let targetSec: number | null = null
  let targetStartSec: number | null = null
  let queuedRender: QueuedSeekTransitionRender | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const resolveCanvas = () => options.waveformCanvas()

  const applyOpacity = (opacity: number, durationMs: number) => {
    const canvas = resolveCanvas()
    if (!canvas) return
    canvas.style.transition = durationMs > 0 ? `opacity ${durationMs}ms linear` : 'none'
    canvas.style.opacity = String(opacity)
  }

  const clearInlineStyles = () => {
    const canvas = resolveCanvas()
    if (!canvas) return
    canvas.style.removeProperty('opacity')
    canvas.style.removeProperty('transition')
  }

  const resolveRangeToleranceSec = (rangeDurationSec: number) =>
    Math.max(SEEK_TRANSITION_RANGE_EPSILON_SEC, Math.max(0, rangeDurationSec) * 0.04)

  const rangeMatchesTarget = (rangeStartSec: number, rangeDurationSec: number) => {
    const safeDurationSec = Math.max(0, Number(rangeDurationSec) || 0)
    const toleranceSec = resolveRangeToleranceSec(safeDurationSec)
    if (targetSec !== null) {
      const rangeEndSec = rangeStartSec + safeDurationSec
      return targetSec >= rangeStartSec - toleranceSec && targetSec <= rangeEndSec + toleranceSec
    }
    return targetStartSec === null || Math.abs(rangeStartSec - targetStartSec) <= toleranceSec
  }

  const rangeMatchesQueuedRender = (
    queued: QueuedSeekTransitionRender,
    renderToken: number,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    if (queued.renderToken !== renderToken) return false
    const toleranceSec = resolveRangeToleranceSec(queued.rangeDurationSec)
    return (
      Math.abs(rangeStartSec - queued.rangeStartSec) <= toleranceSec &&
      Math.abs(rangeDurationSec - queued.rangeDurationSec) <= toleranceSec
    )
  }

  const finish = () => {
    if (!active) return
    active = false
    targetSec = null
    targetStartSec = null
    queuedRender = null
    clearTimer()
    const fadeInMs = Math.max(0, Number(options.fadeInMs) || 100)
    applyOpacity(1, fadeInMs)
    timer = setTimeout(() => {
      timer = null
      clearInlineStyles()
    }, fadeInMs + 40)
  }

  const begin = (nextTargetSec: number) => {
    active = true
    targetSec = Number.isFinite(nextTargetSec) ? nextTargetSec : 0
    targetStartSec = options.resolveTargetStartSec(targetSec)
    queuedRender = null
    clearTimer()
    applyOpacity(0, 0)
  }

  const markFullRenderQueued = (
    renderToken: number,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    if (!active) return
    if (!rangeMatchesTarget(rangeStartSec, rangeDurationSec)) return
    queuedRender = { renderToken, rangeStartSec, rangeDurationSec }
  }

  const clearQueuedRender = () => {
    queuedRender = null
  }

  const finishIfReady = (renderToken: number, rangeStartSec: number, rangeDurationSec: number) => {
    if (!active || !queuedRender) return
    if (!rangeMatchesQueuedRender(queuedRender, renderToken, rangeStartSec, rangeDurationSec)) {
      return
    }
    finish()
  }

  const cancel = () => {
    active = false
    targetSec = null
    targetStartSec = null
    queuedRender = null
    clearTimer()
    clearInlineStyles()
  }

  return {
    begin,
    markFullRenderQueued,
    clearQueuedRender,
    finishIfReady,
    isActive: () => active,
    cancel,
    dispose: cancel
  }
}
