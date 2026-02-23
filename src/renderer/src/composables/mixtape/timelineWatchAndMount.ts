import { nextTick, onMounted, watch } from 'vue'

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
      const viewportEl = timelineScrollRef.value?.osInstance()?.elements().viewport as
        | HTMLElement
        | undefined
      if (viewportEl) {
        setTimelineWheelTarget(viewportEl)
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => updateTimelineWidth())
          timelineViewportObserverRef.value = observer
          observer.observe(viewportEl)
        }
      }
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
    scheduleTransportPreload()
    startTimelineScrollSampler()
    if (typeof window !== 'undefined') {
      window.addEventListener('wheel', handleTimelineWheel, { passive: false })
    }
    if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('mixtape-waveform-updated', handleWaveformUpdated)
    }
  })
}
