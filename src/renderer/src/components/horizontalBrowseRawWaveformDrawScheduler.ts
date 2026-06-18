export type HorizontalBrowseRawWaveformDrawOptions = {
  preferPreviewStart?: boolean
  viewportOnly?: boolean
}

type HorizontalBrowseRawWaveformDrawSchedulerOptions = {
  draw: (drawOptions?: HorizontalBrowseRawWaveformDrawOptions) => void
}

export type HorizontalBrowseRawWaveformDrawScheduler = {
  scheduleDraw: (drawOptions?: HorizontalBrowseRawWaveformDrawOptions) => void
  drawNow: (drawOptions?: HorizontalBrowseRawWaveformDrawOptions) => void
  scheduleStablePlaybackRenderRetry: (retryAfterMs: number) => void
  clearStablePlaybackRenderRetryTimer: () => void
  dispose: () => void
}

const mergeDrawOptions = (
  current: HorizontalBrowseRawWaveformDrawOptions | null,
  incoming: HorizontalBrowseRawWaveformDrawOptions = {}
): HorizontalBrowseRawWaveformDrawOptions => {
  if (!current) return { ...incoming }
  return {
    preferPreviewStart: current.preferPreviewStart === true || incoming.preferPreviewStart === true,
    viewportOnly: current.viewportOnly === true && incoming.viewportOnly === true
  }
}

export const createHorizontalBrowseRawWaveformDrawScheduler = ({
  draw
}: HorizontalBrowseRawWaveformDrawSchedulerOptions): HorizontalBrowseRawWaveformDrawScheduler => {
  let drawRaf = 0
  let scheduledDrawOptions: HorizontalBrowseRawWaveformDrawOptions | null = null
  let stablePlaybackRenderRetryTimer: ReturnType<typeof setTimeout> | null = null

  const clearStablePlaybackRenderRetryTimer = () => {
    if (!stablePlaybackRenderRetryTimer) return
    clearTimeout(stablePlaybackRenderRetryTimer)
    stablePlaybackRenderRetryTimer = null
  }

  const scheduleDraw = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) => {
    scheduledDrawOptions = mergeDrawOptions(scheduledDrawOptions, drawOptions)
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      const nextOptions = scheduledDrawOptions ?? {}
      scheduledDrawOptions = null
      draw(nextOptions)
    })
  }

  const drawNow = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) => {
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
      scheduledDrawOptions = null
    }
    draw(drawOptions)
  }

  const scheduleStablePlaybackRenderRetry = (retryAfterMs: number) => {
    clearStablePlaybackRenderRetryTimer()
    const delayMs = Math.max(1, Math.ceil(retryAfterMs - performance.now()))
    stablePlaybackRenderRetryTimer = setTimeout(() => {
      stablePlaybackRenderRetryTimer = null
      draw()
    }, delayMs)
  }

  const dispose = () => {
    clearStablePlaybackRenderRetryTimer()
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    scheduledDrawOptions = null
  }

  return {
    scheduleDraw,
    drawNow,
    scheduleStablePlaybackRenderRetry,
    clearStablePlaybackRenderRetryTimer,
    dispose
  }
}
