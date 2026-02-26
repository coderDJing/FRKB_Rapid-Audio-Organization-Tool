import { onBeforeUnmount, onMounted, watch } from 'vue'

type BridgeRef<T> = {
  value: T
}

export const setupTimelineVisualScaleLifecycle = (ctx: any) => {
  const {
    tracks,
    timelineRootRef,
    transportError,
    timelineVisualScale,
    resolveTimelineScalableBaseHeight,
    timelineVisualScaleMin,
    timelineVisualScaleMax,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    cleanupTransportAndDrag,
    timelineObserverRef,
    timelineViewportObserverRef,
    overviewObserverRef,
    timelineRootObserverRef,
    timelineScaleRafRef,
    setTimelineWheelTarget,
    handleWaveformUpdated,
    waveformLoadTimerRef,
    waveformPreRenderTimerRef,
    cancelWorkerPreRender,
    waveformPreRenderRafRef,
    waveformPreRenderQueueRef,
    waveformRenderWorkerRef,
    postWaveformWorkerMessage,
    timelineWorkerReady,
    timelineOffscreenCanvasRef,
    timelineCanvasRafRef,
    cleanupInteractions
  } = ctx as {
    tracks: BridgeRef<Array<unknown>>
    timelineRootRef: BridgeRef<HTMLElement | null>
    transportError: BridgeRef<string>
    timelineVisualScale: BridgeRef<number>
    resolveTimelineScalableBaseHeight: () => number
    timelineVisualScaleMin: number
    timelineVisualScaleMax: number
    scheduleTimelineDraw: () => void
    scheduleFullPreRender: () => void
    scheduleWorkerPreRender: () => void
    cleanupTransportAndDrag: () => void
    timelineObserverRef: BridgeRef<ResizeObserver | null>
    timelineViewportObserverRef: BridgeRef<ResizeObserver | null>
    overviewObserverRef: BridgeRef<ResizeObserver | null>
    timelineRootObserverRef: BridgeRef<ResizeObserver | null>
    timelineScaleRafRef: BridgeRef<number>
    setTimelineWheelTarget: (value: HTMLElement | null) => void
    handleWaveformUpdated: (...args: any[]) => void
    waveformLoadTimerRef: BridgeRef<ReturnType<typeof setTimeout> | null>
    waveformPreRenderTimerRef: BridgeRef<ReturnType<typeof setTimeout> | null>
    cancelWorkerPreRender: () => void
    waveformPreRenderRafRef: BridgeRef<number>
    waveformPreRenderQueueRef: BridgeRef<any[]>
    waveformRenderWorkerRef: BridgeRef<Worker | null>
    postWaveformWorkerMessage: (payload: any) => void
    timelineWorkerReady: BridgeRef<boolean>
    timelineOffscreenCanvasRef: BridgeRef<OffscreenCanvas | null>
    timelineCanvasRafRef: BridgeRef<number>
    cleanupInteractions: () => void
  }
  const TIMELINE_VISUAL_SCALE_EPSILON = 0.01

  const measureTimelineCurrentContentHeight = () => {
    const root = timelineRootRef.value
    if (!root) return 0
    const children = Array.from(root.children) as HTMLElement[]
    return children.reduce((sum, child) => sum + Math.max(0, Number(child.offsetHeight || 0)), 0)
  }

  const updateTimelineVisualScale = () => {
    const root = timelineRootRef.value
    if (!root) return
    const scalableBaseHeight = resolveTimelineScalableBaseHeight()
    if (!scalableBaseHeight) {
      timelineVisualScale.value = 1
      return
    }
    const currentScale = Math.max(timelineVisualScaleMin, Number(timelineVisualScale.value || 1))
    const currentContentHeight = Math.max(0, measureTimelineCurrentContentHeight())
    if (!currentContentHeight) {
      timelineVisualScale.value = 1
      return
    }
    const fixedHeight = Math.max(0, currentContentHeight - scalableBaseHeight * currentScale)
    const availableHeight = Math.max(0, Number(root.clientHeight || 0))
    const rawScale = (availableHeight - fixedHeight) / scalableBaseHeight
    const nextScale = Math.max(
      timelineVisualScaleMin,
      Math.min(timelineVisualScaleMax, Number(rawScale.toFixed(3)))
    )
    if (Math.abs(nextScale - timelineVisualScale.value) < TIMELINE_VISUAL_SCALE_EPSILON) return
    timelineVisualScale.value = nextScale
    scheduleTimelineDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    scheduleTimelineVisualScaleUpdate()
  }

  const scheduleTimelineVisualScaleUpdate = () => {
    if (typeof requestAnimationFrame === 'undefined') {
      updateTimelineVisualScale()
      return
    }
    if (timelineScaleRafRef.value) return
    timelineScaleRafRef.value = requestAnimationFrame(() => {
      timelineScaleRafRef.value = 0
      updateTimelineVisualScale()
    })
  }

  const ensureTimelineRootObserver = () => {
    if (typeof ResizeObserver === 'undefined') return
    if (!timelineRootObserverRef.value) {
      timelineRootObserverRef.value = new ResizeObserver(() => {
        scheduleTimelineVisualScaleUpdate()
      })
    }
    try {
      timelineRootObserverRef.value?.disconnect()
    } catch {}
    const root = timelineRootRef.value
    if (!root) return
    try {
      timelineRootObserverRef.value?.observe(root)
    } catch {}
  }

  watch(
    () => timelineRootRef.value,
    () => {
      timelineVisualScale.value = 1
      ensureTimelineRootObserver()
      scheduleTimelineVisualScaleUpdate()
    }
  )

  watch(
    () => tracks.value.length,
    () => {
      scheduleTimelineVisualScaleUpdate()
    }
  )

  watch(
    () => transportError.value,
    () => {
      scheduleTimelineVisualScaleUpdate()
    }
  )

  onMounted(() => {
    ensureTimelineRootObserver()
    scheduleTimelineVisualScaleUpdate()
  })

  onBeforeUnmount(() => {
    cleanupTransportAndDrag()
    try {
      timelineObserverRef.value?.disconnect()
    } catch {}
    try {
      timelineViewportObserverRef.value?.disconnect()
    } catch {}
    try {
      overviewObserverRef.value?.disconnect()
    } catch {}
    try {
      timelineRootObserverRef.value?.disconnect()
    } catch {}
    if (timelineScaleRafRef.value) {
      cancelAnimationFrame(timelineScaleRafRef.value)
      timelineScaleRafRef.value = 0
    }
    setTimelineWheelTarget(null)
    try {
      if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.removeListener(
          'mixtape-waveform-updated',
          handleWaveformUpdated as any
        )
      }
    } catch {}
    if (waveformLoadTimerRef.value) {
      clearTimeout(waveformLoadTimerRef.value)
      waveformLoadTimerRef.value = null
    }
    if (waveformPreRenderTimerRef.value) {
      clearTimeout(waveformPreRenderTimerRef.value)
      waveformPreRenderTimerRef.value = null
    }
    cancelWorkerPreRender()
    if (waveformPreRenderRafRef.value) {
      cancelAnimationFrame(waveformPreRenderRafRef.value)
      waveformPreRenderRafRef.value = 0
    }
    waveformPreRenderQueueRef.value = []
    if (waveformRenderWorkerRef.value) {
      try {
        postWaveformWorkerMessage({ type: 'clearAllCaches' })
        waveformRenderWorkerRef.value.terminate()
      } catch {}
      waveformRenderWorkerRef.value = null
    }
    timelineWorkerReady.value = false
    timelineOffscreenCanvasRef.value = null
    if (timelineCanvasRafRef.value) {
      cancelAnimationFrame(timelineCanvasRafRef.value)
      timelineCanvasRafRef.value = 0
    }
    cleanupInteractions()
  })
}
