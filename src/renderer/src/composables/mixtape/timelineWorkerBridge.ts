import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type {
  RawWaveformData,
  TimelineRenderPayload,
  TimelineRenderTrack,
  WaveformPreRenderTask
} from '@renderer/composables/mixtape/types'

export const createTimelineWorkerBridgeModule = (ctx: any) => {
  const {
    waveformRenderWorkerRef,
    timelineWorkerReady,
    timelineCanvasRef,
    timelineOffscreenCanvasRef,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTilePending,
    waveformTileCacheTickRef,
    disposeWaveformCacheEntry,
    registerWaveformTileCacheKey,
    pruneWaveformTileCache,
    preRenderPhase,
    preRenderTotals,
    preRenderState,
    pendingFramePreRenderTasksRef,
    waveformPreRenderRafRef,
    waveformPreRenderCursorRef,
    waveformPreRenderQueueRef,
    scheduleWorkerPreRender,
    getScheduleTimelineDraw,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    resolveTrackSourceDurationSeconds,
    resolveRenderPxPerSec,
    resolveTimelineBufferId,
    resolveLaneHeightForZoom,
    clampZoomValue,
    normalizedRenderZoom,
    waveformVersion,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    SHOW_GRID_LINES,
    RENDER_X_BUFFER_PX,
    LANE_GAP,
    LANE_PADDING_TOP,
    MIXTAPE_WAVEFORM_Y_OFFSET
  } = ctx

  const getWaveformRenderWorker = () => waveformRenderWorkerRef.value as Worker | null
  const getWaveformTileCacheTick = () => Number(waveformTileCacheTickRef.value || 0)
  const setWaveformTileCacheTick = (value: number) => {
    waveformTileCacheTickRef.value = value
  }
  const getPendingFramePreRenderTasks = () =>
    pendingFramePreRenderTasksRef.value as TimelineRenderPayload[]
  const setPendingFramePreRenderTasks = (value: TimelineRenderPayload[]) => {
    pendingFramePreRenderTasksRef.value = value
  }

  const postWaveformWorkerMessage = (message: any, transfer?: Transferable[]) => {
    const worker = getWaveformRenderWorker()
    if (!worker) return
    try {
      worker.postMessage(message, transfer || [])
    } catch {}
  }

  const clearWaveformTileCacheForFile = (filePath: string) => {
    if (!filePath) return
    const keys = waveformTileCacheIndex.get(filePath)
    if (keys) {
      for (const key of keys) {
        const entry = waveformTileCache.get(key)
        disposeWaveformCacheEntry(entry || null)
        waveformTileCache.delete(key)
        waveformTilePending.delete(key)
      }
      waveformTileCacheIndex.delete(filePath)
    }
    postWaveformWorkerMessage({ type: 'clearTileCache', payload: { filePath } })
  }

  const pushMixxxWaveformToWorker = (filePath: string, data: MixxxWaveformData | null) => {
    if (!filePath || !getWaveformRenderWorker()) return
    postWaveformWorkerMessage({
      type: 'storeMixxx',
      payload: { filePath, data }
    })
  }

  const pushRawWaveformToWorker = (filePath: string, data: RawWaveformData | null) => {
    if (!filePath || !getWaveformRenderWorker()) return
    postWaveformWorkerMessage({
      type: 'storeRaw',
      payload: { filePath, data }
    })
  }

  const handleWaveformWorkerMessage = (event: MessageEvent) => {
    const payload = (event?.data || {}) as {
      type?: string
      cacheKey?: string
      bitmap?: ImageBitmap
      done?: number
      total?: number
    }
    if (payload.type === 'rendered') {
      const cacheKey = typeof payload.cacheKey === 'string' ? payload.cacheKey : ''
      const bitmap = payload.bitmap
      if (!cacheKey || !bitmap) return
      const existing = waveformTileCache.get(cacheKey)
      if (existing) {
        disposeWaveformCacheEntry(existing)
      }
      const nextTick = getWaveformTileCacheTick() + 1
      setWaveformTileCacheTick(nextTick)
      waveformTileCache.set(cacheKey, { source: bitmap, used: nextTick })
      const filePath = cacheKey.split('::')[0] || ''
      if (filePath) {
        registerWaveformTileCacheKey(filePath, cacheKey)
      }
      waveformTilePending.delete(cacheKey)
      pruneWaveformTileCache()
      const draw = getScheduleTimelineDraw?.()
      if (typeof draw === 'function') draw()
      return
    }
    if (payload.type === 'preRenderProgress') {
      const total = Number(payload.total || 0)
      const done = Number(payload.done || 0)
      if (preRenderPhase.value === 'tiles') {
        const tilesTotal = preRenderTotals.value.tiles
        const framesTotal = preRenderTotals.value.frames
        const safeDone = Math.min(Math.max(0, done), tilesTotal)
        preRenderState.value = {
          active: tilesTotal + framesTotal > 0 && safeDone < tilesTotal + framesTotal,
          total: tilesTotal + framesTotal,
          done: safeDone
        }
      } else if (preRenderPhase.value === 'frames') {
        const tilesTotal = preRenderTotals.value.tiles
        const framesTotal = preRenderTotals.value.frames
        const safeDone = Math.min(Math.max(0, done), framesTotal)
        preRenderState.value = {
          active: tilesTotal + framesTotal > 0 && safeDone < framesTotal,
          total: tilesTotal + framesTotal,
          done: tilesTotal + safeDone
        }
      } else {
        preRenderState.value = {
          active: total > 0 && done < total,
          total,
          done: Math.min(done, total)
        }
      }
      return
    }
    if (payload.type === 'preRenderDone') {
      if (preRenderPhase.value === 'tiles') {
        const frames = getPendingFramePreRenderTasks()
        if (frames.length) {
          preRenderPhase.value = 'frames'
          postWaveformWorkerMessage({ type: 'preRenderFrames', payload: { tasks: frames } })
          return
        }
      }
      preRenderPhase.value = 'idle'
      setPendingFramePreRenderTasks([])
      preRenderState.value = {
        active: false,
        total: preRenderState.value.total,
        done: preRenderState.value.total
      }
    }
  }

  const requestWaveformTileRender = (task: WaveformPreRenderTask) => {
    const { ctx: render, tile, cacheKey } = task
    const filePath = render.track.filePath
    if (!filePath || waveformTilePending.has(cacheKey)) return
    waveformTilePending.add(cacheKey)
    postWaveformWorkerMessage({
      type: 'renderTile',
      payload: {
        cacheKey,
        filePath,
        zoom: render.renderZoom,
        tileIndex: tile.index,
        tileStart: tile.start,
        tileWidth: tile.width,
        trackWidth: render.trackWidth,
        durationSeconds: render.sourceDurationSeconds,
        laneHeight: render.laneHeight,
        pixelRatio: window.devicePixelRatio || 1
      }
    })
  }

  const initTimelineWorkerRenderer = () => {
    if (timelineWorkerReady.value || !getWaveformRenderWorker()) return
    const canvas = timelineCanvasRef.value
    if (!canvas || !('transferControlToOffscreen' in canvas)) return
    try {
      timelineOffscreenCanvasRef.value = canvas.transferControlToOffscreen()
      postWaveformWorkerMessage(
        {
          type: 'initCanvas',
          payload: { canvas: timelineOffscreenCanvasRef.value }
        },
        [timelineOffscreenCanvasRef.value]
      )
      timelineWorkerReady.value = true
      const preRenderRaf = Number(waveformPreRenderRafRef.value || 0)
      if (preRenderRaf) {
        cancelAnimationFrame(preRenderRaf)
        waveformPreRenderRafRef.value = 0
      }
      waveformPreRenderQueueRef.value = []
      waveformPreRenderCursorRef.value = 0
      scheduleWorkerPreRender()
    } catch {
      timelineWorkerReady.value = false
      timelineOffscreenCanvasRef.value = null
    }
  }

  const buildTimelineRenderPayload = (
    widthPx: number,
    heightPx: number,
    startX: number,
    startY: number,
    overrideZoom?: number
  ): TimelineRenderPayload | null => {
    const zoomValue =
      typeof overrideZoom === 'number' ? clampZoomValue(overrideZoom) : normalizedRenderZoom.value
    const bufferId = resolveTimelineBufferId(zoomValue)
    const laneH = resolveLaneHeightForZoom(zoomValue)
    if (!laneH || laneH <= 0) return null
    const lanePaddingTop = LANE_PADDING_TOP + MIXTAPE_WAVEFORM_Y_OFFSET
    const endX = startX + widthPx
    const renderStartX = Math.max(0, Math.floor(startX - RENDER_X_BUFFER_PX))
    const renderEndX = Math.max(renderStartX, Math.ceil(endX + RENDER_X_BUFFER_PX))
    const renderTracks: TimelineRenderTrack[] = []
    const snapshot = buildSequentialLayoutForZoom(zoomValue)
    forEachVisibleLayoutItem(snapshot, renderStartX, renderEndX, (item: any) => {
      const track = item.track
      const durationSeconds = resolveTrackSourceDurationSeconds(track)
      const trackWidth = item.width
      if (!trackWidth || !Number.isFinite(trackWidth)) return
      const trackStartX = item.startX
      const trackEndX = trackStartX + trackWidth
      if (trackEndX < renderStartX || trackStartX > renderEndX) return
      const bpmValue = typeof track.bpm === 'number' ? track.bpm : 0
      const firstBeatMs = Number(track.firstBeatMs) || 0
      renderTracks.push({
        id: track.id,
        filePath: track.filePath,
        durationSeconds,
        trackWidth,
        startX: item.startX,
        laneIndex: item.laneIndex,
        bpm: Number(bpmValue) || 0,
        firstBeatMs
      })
    })
    return {
      width: widthPx,
      height: heightPx,
      pixelRatio: window.devicePixelRatio || 1,
      showGridLines: SHOW_GRID_LINES && !bpmAnalysisActive.value && !bpmAnalysisFailed.value,
      allowTileBuild: true,
      startX,
      startY,
      bufferId,
      zoom: zoomValue,
      laneHeight: laneH,
      laneGap: LANE_GAP,
      lanePaddingTop,
      renderPxPerSec: resolveRenderPxPerSec(zoomValue),
      renderVersion: waveformVersion.value,
      tracks: renderTracks
    }
  }

  const requestTimelineWorkerRender = (
    widthPx: number,
    heightPx: number,
    startX: number,
    startY: number
  ) => {
    if (!timelineWorkerReady.value || !getWaveformRenderWorker()) return
    const payload = buildTimelineRenderPayload(widthPx, heightPx, startX, startY)
    if (!payload) return
    postWaveformWorkerMessage({ type: 'renderFrame', payload })
  }

  return {
    postWaveformWorkerMessage,
    clearWaveformTileCacheForFile,
    pushMixxxWaveformToWorker,
    pushRawWaveformToWorker,
    handleWaveformWorkerMessage,
    requestWaveformTileRender,
    initTimelineWorkerRenderer,
    buildTimelineRenderPayload,
    requestTimelineWorkerRender
  }
}
