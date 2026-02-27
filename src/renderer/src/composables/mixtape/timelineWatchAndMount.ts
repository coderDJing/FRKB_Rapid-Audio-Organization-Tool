import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'

export const createTimelineWatchAndMountModule = (ctx: any) => {
  const {
    tracks,
    isTrackDragging,
    bpmAnalysisActive,
    timelineDurationSec,
    playheadSec,
    renderPxPerSec,
    waveformVersion,
    stopTransportForTrackChange,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleWaveformLoad,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    scheduleTimelineDraw,
    scheduleWaveformDraw,
    waveformRenderWorkerRef,
    handleWaveformWorkerMessage,
    pushMixxxWaveformToWorker,
    pushRawWaveformToWorker,
    waveformDataMap,
    rawWaveformDataMap,
    timelineScrollRef,
    setTimelineWheelTarget,
    timelineViewport,
    timelineObserverRef,
    timelineViewportObserverRef,
    overviewObserverRef,
    overviewRef,
    updateOverviewWidth,
    startTimelineScrollSampler,
    handleTimelineWheel,
    handleWaveformUpdated,
    scheduleTransportPreload
  } = ctx
  const INITIAL_VIEWPORT_BIND_MAX_ATTEMPTS = 24
  const INITIAL_VIEWPORT_BIND_INTERVAL_MS = 50
  let initialViewportBindAttempts = 0
  let initialViewportBindTimer: ReturnType<typeof setTimeout> | null = null

  const clearInitialViewportBindTimer = () => {
    if (!initialViewportBindTimer) return
    clearTimeout(initialViewportBindTimer)
    initialViewportBindTimer = null
  }

  const bindTimelineViewportIfReady = () => {
    const viewportEl = timelineScrollRef.value?.osInstance()?.elements().viewport as
      | HTMLElement
      | undefined
    if (!viewportEl) return false
    setTimelineWheelTarget(viewportEl)
    if (typeof ResizeObserver !== 'undefined') {
      if (!timelineViewportObserverRef.value) {
        timelineViewportObserverRef.value = new ResizeObserver(() => updateTimelineWidth())
      }
      try {
        timelineViewportObserverRef.value.observe(viewportEl)
      } catch {}
    }
    updateTimelineWidth()
    nextTick(() => scheduleWaveformDraw())
    return true
  }

  const scheduleInitialViewportBind = () => {
    if (bindTimelineViewportIfReady()) {
      clearInitialViewportBindTimer()
      return
    }
    if (initialViewportBindAttempts >= INITIAL_VIEWPORT_BIND_MAX_ATTEMPTS) return
    initialViewportBindAttempts += 1
    clearInitialViewportBindTimer()
    initialViewportBindTimer = setTimeout(() => {
      initialViewportBindTimer = null
      scheduleInitialViewportBind()
    }, INITIAL_VIEWPORT_BIND_INTERVAL_MS)
  }

  watch(
    () => tracks.value.map((track: any) => track.id).join('|'),
    () => {
      stopTransportForTrackChange()
      clearTimelineLayoutCache()
      updateTimelineWidth()
      scheduleWaveformLoad()
      scheduleTransportPreload()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
      nextTick(() => scheduleWaveformDraw())
    }
  )

  watch(
    () =>
      tracks.value
        .map((track: any) => {
          const startSec = Number(track.startSec) || 0
          const bpm = Number(track.bpm) || 0
          const firstBeatMs = Number(track.firstBeatMs) || 0
          const barBeatOffset = Number(track.barBeatOffset) || 0
          const masterTempo = track.masterTempo === false ? 0 : 1
          return `${track.id}:${Math.round(startSec * 1000)}:${Math.round(
            bpm * 1000
          )}:${firstBeatMs}:${barBeatOffset}:${masterTempo}`
        })
        .join('|'),
    (_next, prev) => {
      if (typeof prev === 'string' && prev) {
        stopTransportForTrackChange()
      }
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      if (!isTrackDragging.value) {
        scheduleFullPreRender()
        scheduleWorkerPreRender()
      }
    }
  )

  watch(
    () => bpmAnalysisActive.value,
    (active) => {
      if (active) {
        stopTransportForTrackChange()
      }
    }
  )

  watch(
    () => timelineDurationSec.value,
    (duration) => {
      if (!Number.isFinite(duration) || duration < 0) return
      if (playheadSec.value > duration) {
        playheadSec.value = duration
      }
    }
  )

  watch(
    () => renderPxPerSec.value,
    () => {
      clearTimelineLayoutCache()
      updateTimelineWidth()
    }
  )

  watch(
    () => waveformVersion.value,
    () => {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
    }
  )

  onMounted(() => {
    updateTimelineWidth()
    if (typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(
          // @ts-expect-error Vite resolves import.meta.url in renderer build
          new URL('../../workers/mixtapeWaveformRender.worker.ts', import.meta.url),
          { type: 'module' }
        )
        waveformRenderWorkerRef.value = worker
        worker.onmessage = handleWaveformWorkerMessage
        for (const [filePath, data] of waveformDataMap.entries()) {
          pushMixxxWaveformToWorker(filePath, data)
        }
        for (const [filePath, data] of rawWaveformDataMap.entries()) {
          pushRawWaveformToWorker(filePath, data)
        }
      } catch {
        waveformRenderWorkerRef.value = null
      }
    }
    try {
      bindTimelineViewportIfReady()
      if (timelineViewport.value && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => scheduleWaveformDraw())
        timelineObserverRef.value = observer
        observer.observe(timelineViewport.value)
      }
      if (overviewRef.value && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => updateOverviewWidth())
        overviewObserverRef.value = observer
        observer.observe(overviewRef.value)
      }
    } catch {}
    updateOverviewWidth()
    initialViewportBindAttempts = 0
    scheduleInitialViewportBind()
    scheduleTransportPreload()
    startTimelineScrollSampler()
    if (typeof window !== 'undefined') {
      window.addEventListener('wheel', handleTimelineWheel, { passive: false })
    }
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('mixtape-waveform-updated', handleWaveformUpdated)
    }
  })

  onBeforeUnmount(() => {
    clearInitialViewportBindTimer()
  })
}
