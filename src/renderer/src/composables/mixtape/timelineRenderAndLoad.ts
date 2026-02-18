import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type {
  MixtapeTrack,
  RawWaveformData,
  TimelineTrackLayout,
  WaveformRenderContext,
  WaveformTile
} from '@renderer/composables/mixtape/types'

export const createTimelineRenderAndLoadModule = (ctx: any) => {
  const {
    requestTimelineWorkerRender,
    timelineWorkerReady,
    timelineCanvasRef,
    timelineScrollWrapRef,
    timelineScrollRef,
    timelineViewportWidth,
    timelineViewportHeight,
    timelineScrollLeft,
    timelineScrollTop,
    timelineCanvasRafRef,
    timelineContentWidth,
    normalizedRenderZoom,
    clampZoomValue,
    resolveLaneHeightForZoom,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackRenderWidthPx,
    resolveRenderPxPerSec,
    resolveRawWaveformLevel,
    useHalfWaveform,
    waveformDataMap,
    rawWaveformDataMap,
    waveformMinMaxCache,
    waveformScratch,
    waveformRenderWorker,
    waveformTileCache,
    waveformTileCacheTickRef,
    registerWaveformTileCacheKey,
    pruneWaveformTileCache,
    waveformTilePending,
    disposeWaveformCacheEntry,
    pushMixxxWaveformToWorker,
    pushRawWaveformToWorker,
    clearWaveformTileCacheForFile,
    buildRawWaveformPyramid,
    rawWaveformPyramidMap,
    decodeRawWaveformData,
    isValidWaveformData,
    tracks,
    resolveWaveformListRoot,
    waveformInflight,
    waveformQueuedMissing,
    rawWaveformInflight,
    waveformLoadTimerRef,
    initTimelineWorkerRenderer,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    buildWaveformTileCacheKey,
    requestWaveformTileRender,
    renderWaveformTileToCache,
    touchWaveformTileCache,
    drawTrackGridLines,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    RENDER_X_BUFFER_PX,
    LANE_GAP,
    LANE_PADDING_TOP,
    MIXTAPE_WAVEFORM_Y_OFFSET,
    SHOW_GRID_LINES,
    GRID_BAR_ONLY_ZOOM,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    MIXTAPE_SUMMARY_ZOOM,
    RAW_WAVEFORM_MIN_ZOOM,
    RAW_WAVEFORM_TARGET_RATE,
    WAVEFORM_TILE_WIDTH,
    WAVEFORM_BATCH_SIZE,
    RAW_WAVEFORM_BATCH_SIZE,
    MIXTAPE_WAVEFORM_SUPERSAMPLE,
    drawMixxxRgbWaveform,
    useRawWaveform,
    waveformVersion
  } = ctx

  const getWaveformTileCacheTick = () => Number(waveformTileCacheTickRef.value || 0)
  const setWaveformTileCacheTick = (value: number) => {
    waveformTileCacheTickRef.value = value
  }
  const getTimelineCanvasRaf = () => Number(timelineCanvasRafRef.value || 0)
  const setTimelineCanvasRaf = (value: number) => {
    timelineCanvasRafRef.value = value
  }
  const getWaveformLoadTimer = () =>
    waveformLoadTimerRef.value as ReturnType<typeof setTimeout> | null
  const setWaveformLoadTimer = (value: ReturnType<typeof setTimeout> | null) => {
    waveformLoadTimerRef.value = value
  }
  const drawTimelineCanvas = () => {
    const canvas = timelineCanvasRef.value
    const wrap = timelineScrollWrapRef.value
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    if (!canvas || !wrap || !viewport) return
    if (
      !timelineWorkerReady.value &&
      waveformRenderWorker &&
      'transferControlToOffscreen' in canvas
    ) {
      initTimelineWorkerRenderer()
    }
    const width = viewport.clientWidth || 0
    const height = viewport.clientHeight || 0
    if (!width || !height) return
    const wrapRect = wrap.getBoundingClientRect()
    const viewRect = viewport.getBoundingClientRect()
    const left = Math.max(0, Math.round(viewRect.left - wrapRect.left))
    const top = Math.max(0, Math.round(viewRect.top - wrapRect.top))
    const widthPx = Math.max(0, Math.floor(width))
    const heightPx = Math.max(0, Math.floor(height))
    if (canvas.style.left !== `${left}px`) canvas.style.left = `${left}px`
    if (canvas.style.top !== `${top}px`) canvas.style.top = `${top}px`
    if (canvas.style.width !== `${widthPx}px`) canvas.style.width = `${widthPx}px`
    if (canvas.style.height !== `${heightPx}px`) canvas.style.height = `${heightPx}px`
    const startX = Math.round(viewport.scrollLeft || 0)
    const startY = Math.round(viewport.scrollTop || 0)

    if (timelineWorkerReady.value) {
      requestTimelineWorkerRender(widthPx, heightPx, startX, startY)
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    resizeCanvas(canvas, ctx, widthPx, heightPx)
    const endX = startX + widthPx
    const renderStartX = Math.max(0, Math.floor(startX - RENDER_X_BUFFER_PX))
    const renderEndX = Math.max(renderStartX, Math.ceil(endX + RENDER_X_BUFFER_PX))
    const zoomValue = normalizedRenderZoom.value
    const laneH = resolveLaneHeightForZoom(zoomValue)
    if (!laneH || laneH <= 0) return
    const laneStride = laneH + LANE_GAP
    const lanePaddingTop = LANE_PADDING_TOP + MIXTAPE_WAVEFORM_Y_OFFSET
    const pixelRatio = window.devicePixelRatio || 1
    const showGridLines = SHOW_GRID_LINES && !bpmAnalysisActive.value && !bpmAnalysisFailed.value
    const allowTileBuild = true
    const barOnlyGrid = zoomValue <= GRID_BAR_ONLY_ZOOM
    const snapshot = buildSequentialLayoutForZoom(zoomValue)

    forEachVisibleLayoutItem(snapshot, renderStartX, renderEndX, (item: TimelineTrackLayout) => {
      const track = item.track
      const filePath = track.filePath
      if (!filePath) return
      const trackWidth = item.width
      if (!trackWidth || !Number.isFinite(trackWidth)) return
      const trackStartX = item.startX
      const trackEndX = trackStartX + trackWidth
      if (trackEndX < renderStartX || trackStartX > renderEndX) return
      const trackY = lanePaddingTop + item.laneIndex * laneStride - startY
      const visibleStart = Math.max(trackStartX, startX)
      const visibleEnd = Math.min(trackEndX, endX)
      if (visibleEnd <= visibleStart) return
      const localStart = visibleStart - trackStartX
      const localEnd = visibleEnd - trackStartX
      const tileStartIndex = Math.max(0, Math.floor(localStart / WAVEFORM_TILE_WIDTH))
      const tileEndIndex = Math.max(
        tileStartIndex,
        Math.floor(Math.max(0, localEnd - 1) / WAVEFORM_TILE_WIDTH)
      )
      const renderCtx = buildTrackRenderContext(track, zoomValue)
      for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
        const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
        const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, trackWidth - tileStart))
        if (!tileWidth) continue
        const cacheKey = buildWaveformTileCacheKey(
          filePath,
          tileIndex,
          zoomValue,
          Math.max(1, Math.floor(tileWidth)),
          Math.max(1, Math.floor(laneH)),
          pixelRatio
        )
        let cached = waveformTileCache.get(cacheKey)
        if (!cached) {
          if (allowTileBuild) {
            const task = {
              ctx: renderCtx,
              tile: { index: tileIndex, start: tileStart, width: tileWidth },
              cacheKey
            }
            if (waveformRenderWorker) {
              requestWaveformTileRender(task)
            } else {
              renderWaveformTileToCache(task)
              cached = waveformTileCache.get(cacheKey)
            }
          }
        }
        if (cached) {
          const source = cached.source
          ctx.drawImage(source, trackStartX + tileStart - startX, trackY, tileWidth, laneH)
          touchWaveformTileCache(cacheKey)
        }
      }
      const visibleWidth = Math.max(0, localEnd - localStart)
      if (showGridLines && visibleWidth > 0) {
        const renderPxPerSecSafe = Math.max(0.0001, renderCtx.renderPxPerSec)
        const trackStartSecFromPx = trackStartX / renderPxPerSecSafe
        const trackStartSec =
          Number.isFinite(Number(item.startSec)) && Number(item.startSec) >= 0
            ? Number(item.startSec)
            : trackStartSecFromPx
        const adjustedFirstBeatMs =
          resolveTrackFirstBeatMs(track) + (trackStartSec - trackStartSecFromPx) * 1000
        ctx.save()
        ctx.translate(trackStartX + localStart - startX, trackY)
        drawTrackGridLines(
          ctx,
          visibleWidth,
          laneH,
          Number(track.bpm) || 0,
          adjustedFirstBeatMs,
          Number(track.barBeatOffset) || 0,
          { start: localStart, end: localEnd },
          renderCtx.renderPxPerSec,
          barOnlyGrid,
          zoomValue
        )
        ctx.restore()
      }
    })
  }

  const scheduleTimelineDraw = () => {
    if (typeof requestAnimationFrame === 'undefined') {
      drawTimelineCanvas()
      return
    }
    if (getTimelineCanvasRaf()) return
    setTimelineCanvasRaf(
      requestAnimationFrame(() => {
        setTimelineCanvasRaf(0)
        drawTimelineCanvas()
      })
    )
  }

  const resizeCanvas = (
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const pixelRatio = window.devicePixelRatio || 1
    const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
    const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth
      canvas.height = scaledHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(pixelRatio, pixelRatio)
  }

  const ensureWaveformScratch = (width: number, height: number) => {
    if (!waveformScratch.canvas) {
      waveformScratch.canvas = document.createElement('canvas')
      waveformScratch.ctx = waveformScratch.canvas.getContext('2d')
    }
    const canvas = waveformScratch.canvas
    const ctx = waveformScratch.ctx
    if (!canvas || !ctx) return null
    resizeCanvas(canvas, ctx, width, height)
    return { canvas, ctx }
  }

  const buildTrackRenderContext = (
    track: MixtapeTrack,
    renderZoomValue?: number
  ): WaveformRenderContext => {
    const data = waveformDataMap.get(track.filePath) || null
    const sourceDurationSeconds = resolveTrackSourceDurationSeconds(track)
    const durationSeconds = resolveTrackDurationSeconds(track)
    const zoomValue =
      typeof renderZoomValue === 'number'
        ? clampZoomValue(renderZoomValue)
        : normalizedRenderZoom.value
    const rawData =
      zoomValue >= RAW_WAVEFORM_MIN_ZOOM ? rawWaveformDataMap.get(track.filePath) || null : null
    let frameCount = 0
    if (data) {
      const low = data.bands.low
      const mid = data.bands.mid
      const high = data.bands.high
      frameCount = Math.min(
        low.left.length,
        low.right.length,
        mid.left.length,
        mid.right.length,
        high.left.length,
        high.right.length
      )
    }

    const trackWidth = resolveTrackRenderWidthPx(track, zoomValue)
    return {
      track,
      trackWidth,
      sourceDurationSeconds,
      durationSeconds,
      data,
      frameCount,
      rawData,
      renderZoom: zoomValue,
      renderPxPerSec: resolveRenderPxPerSec(zoomValue),
      laneHeight: resolveLaneHeightForZoom(zoomValue)
    }
  }

  const renderSummaryWaveformBar = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const barHeight = Math.max(4, Math.round(height * 0.55))
    const y = Math.round((height - barHeight) / 2)
    ctx.fillStyle = 'rgba(90, 170, 255, 0.35)'
    ctx.fillRect(0, y, width, barHeight)
  }

  const renderWaveformTileContents = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    render: WaveformRenderContext,
    tile: WaveformTile
  ) => {
    const { track, trackWidth, sourceDurationSeconds, data, frameCount, rawData } = render
    if (render.renderZoom <= MIXTAPE_SUMMARY_ZOOM + 0.0001) {
      renderSummaryWaveformBar(ctx, width, height)
      return
    }
    if (!data || frameCount <= 0) {
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)'
      ctx.setLineDash([4, 4])
      const midY = height / 2
      ctx.beginPath()
      ctx.moveTo(0, midY)
      ctx.lineTo(width, midY)
      ctx.stroke()
      ctx.setLineDash([])
      return
    }

    const startFrame = Math.floor((tile.start / Math.max(1, trackWidth)) * frameCount)
    const endFrame = Math.ceil(((tile.start + tile.width) / Math.max(1, trackWidth)) * frameCount)
    const rawDurationSeconds =
      rawData && Number.isFinite(rawData.duration) && rawData.duration > 0 ? rawData.duration : 0
    const waveformDurationSeconds =
      rawDurationSeconds > 0 ? rawDurationSeconds : sourceDurationSeconds
    const startTime = waveformDurationSeconds
      ? (tile.start / Math.max(1, trackWidth)) * waveformDurationSeconds
      : 0
    const endTime = waveformDurationSeconds
      ? ((tile.start + tile.width) / Math.max(1, trackWidth)) * waveformDurationSeconds
      : 0

    const pixelRatio = window.devicePixelRatio || 1
    const rawSpan = Math.max(0, endTime - startTime)
    const rawSamplesPerPixel =
      rawData && rawSpan > 0 ? (rawData.rate * rawSpan) / Math.max(1, width * pixelRatio) : 0
    const resolvedRaw =
      track.filePath && rawData
        ? resolveRawWaveformLevel(track.filePath, rawData, rawSamplesPerPixel)
        : rawData

    const renderScale = render.renderZoom >= 1 ? MIXTAPE_WAVEFORM_SUPERSAMPLE : 1
    if (renderScale > 1) {
      const scratch = ensureWaveformScratch(width * renderScale, height)
      if (scratch) {
        drawMixxxRgbWaveform(scratch.ctx, width * renderScale, height, data, useHalfWaveform(), {
          startFrame,
          endFrame,
          startTime,
          endTime,
          raw: resolvedRaw
        })
        ctx.save()
        ctx.imageSmoothingEnabled = true
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(
          scratch.canvas,
          0,
          0,
          scratch.canvas.width,
          scratch.canvas.height,
          0,
          0,
          width,
          height
        )
        ctx.restore()
        return
      }
    }

    drawMixxxRgbWaveform(ctx, width, height, data, useHalfWaveform(), {
      startFrame,
      endFrame,
      startTime,
      endTime,
      raw: resolvedRaw
    })
  }

  const scheduleWaveformDraw = (_deferSwap: boolean = false) => {
    scheduleTimelineDraw()
  }

  const storeWaveformData = (filePath: string, data: MixxxWaveformData | null) => {
    if (!filePath) return
    const normalized = isValidWaveformData(data) ? data : null
    if (waveformDataMap.has(filePath)) {
      waveformDataMap.delete(filePath)
    }
    waveformDataMap.set(filePath, normalized)
    pushMixxxWaveformToWorker(filePath, normalized)
    clearWaveformTileCacheForFile(filePath)
    if (!normalized) {
      waveformMinMaxCache.delete(filePath)
    }
    waveformVersion.value += 1
    scheduleWaveformDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
  }

  const fetchWaveformBatch = async (filePaths: string[], listRoot?: string) => {
    if (!filePaths.length) return
    for (const filePath of filePaths) {
      waveformInflight.add(filePath)
    }
    let response: { items?: Array<{ filePath: string; data: MixxxWaveformData | null }> } | null =
      null
    try {
      response = await window.electron.ipcRenderer.invoke('mixtape-waveform-cache:batch', {
        filePaths,
        listRoot
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : null
    if (!items) {
      for (const filePath of filePaths) {
        waveformInflight.delete(filePath)
      }
      return
    }

    const itemMap = new Map(items.map((item) => [item.filePath, item.data ?? null]))
    const missing: string[] = []
    for (const filePath of filePaths) {
      const data = itemMap.has(filePath) ? itemMap.get(filePath) : null
      storeWaveformData(filePath, data ?? null)
      if (data) {
        waveformQueuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      waveformInflight.delete(filePath)
    }

    if (missing.length) {
      const toQueue = missing.filter((filePath) => !waveformQueuedMissing.has(filePath))
      if (toQueue.length) {
        for (const filePath of toQueue) {
          waveformQueuedMissing.add(filePath)
        }
        window.electron.ipcRenderer.send('mixtape-waveform:queue-visible', {
          filePaths: toQueue,
          listRoot
        })
      }
    }
  }

  const fetchRawWaveformBatch = async (filePaths: string[]) => {
    if (!filePaths.length) return
    for (const filePath of filePaths) {
      rawWaveformInflight.add(filePath)
    }
    let response: { items?: Array<{ filePath: string; data: any | null }> } | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('mixtape-waveform-raw:batch', {
        filePaths,
        targetRate: RAW_WAVEFORM_TARGET_RATE
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : []
    let updated = false
    for (const filePath of filePaths) {
      const item = items.find((entry) => entry?.filePath === filePath)
      const decoded = item ? decodeRawWaveformData(item.data) : null
      rawWaveformDataMap.set(filePath, decoded)
      if (decoded) {
        rawWaveformPyramidMap.set(filePath, buildRawWaveformPyramid(decoded))
      } else {
        rawWaveformPyramidMap.delete(filePath)
      }
      pushRawWaveformToWorker(filePath, decoded)
      clearWaveformTileCacheForFile(filePath)
      rawWaveformInflight.delete(filePath)
      updated = true
    }
    if (updated) {
      waveformVersion.value += 1
    }
    scheduleWaveformDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
  }

  const loadWaveforms = async () => {
    if (!tracks.value.length) return
    const grouped = new Map<string, string[]>()
    for (const track of tracks.value) {
      const filePath = track.filePath
      if (!filePath || waveformDataMap.has(filePath) || waveformInflight.has(filePath)) continue
      const listRoot = resolveWaveformListRoot(track)
      const listKey = listRoot || ''
      const list = grouped.get(listKey)
      if (list) {
        if (!list.includes(filePath)) list.push(filePath)
      } else {
        grouped.set(listKey, [filePath])
      }
    }
    if (grouped.size === 0) {
      scheduleWaveformDraw()
      return
    }
    for (const [listRoot, filePaths] of grouped.entries()) {
      for (let i = 0; i < filePaths.length; i += WAVEFORM_BATCH_SIZE) {
        const batch = filePaths.slice(i, i + WAVEFORM_BATCH_SIZE)
        await fetchWaveformBatch(batch, listRoot || undefined)
      }
    }
  }

  const loadRawWaveforms = async () => {
    if (!tracks.value.length) return
    if (!useRawWaveform.value) return
    const targets: string[] = []
    for (const track of tracks.value) {
      const filePath = track.filePath
      if (!filePath || rawWaveformDataMap.has(filePath) || rawWaveformInflight.has(filePath))
        continue
      targets.push(filePath)
    }
    if (!targets.length) return
    for (let i = 0; i < targets.length; i += RAW_WAVEFORM_BATCH_SIZE) {
      const batch = targets.slice(i, i + RAW_WAVEFORM_BATCH_SIZE)
      await fetchRawWaveformBatch(batch)
    }
  }

  const scheduleWaveformLoad = () => {
    const timer = getWaveformLoadTimer()
    if (timer) clearTimeout(timer)
    setWaveformLoadTimer(
      setTimeout(() => {
        setWaveformLoadTimer(null)
        void loadWaveforms()
        void loadRawWaveforms()
      }, 120)
    )
  }

  const handleWaveformUpdated = (_event: unknown, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    waveformDataMap.delete(filePath)
    waveformQueuedMissing.delete(filePath)
    clearWaveformTileCacheForFile(filePath)
    void fetchWaveformBatch([filePath])
  }

  return {
    drawTimelineCanvas,
    scheduleTimelineDraw,
    resizeCanvas,
    ensureWaveformScratch,
    buildTrackRenderContext,
    renderSummaryWaveformBar,
    renderWaveformTileContents,
    scheduleWaveformDraw,
    storeWaveformData,
    fetchWaveformBatch,
    fetchRawWaveformBatch,
    loadWaveforms,
    loadRawWaveforms,
    scheduleWaveformLoad,
    handleWaveformUpdated
  }
}
