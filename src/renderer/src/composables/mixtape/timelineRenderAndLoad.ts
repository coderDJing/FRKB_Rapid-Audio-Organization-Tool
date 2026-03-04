import {
  MIXTAPE_WAVEFORM_HEIGHT_SCALE,
  TIMELINE_SIDE_PADDING_PX
} from '@renderer/composables/mixtape/constants'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type {
  MixtapeTrack,
  MixtapeWaveformStemId,
  RawWaveformData,
  StemWaveformData,
  TimelineTrackLayout,
  WaveformRenderContext,
  WaveformTile
} from '@renderer/composables/mixtape/types'
import type {
  StemWaveformBatchRequestItem,
  TimelineWaveformData
} from '@renderer/composables/mixtape/timelineRenderAndLoadTypes'

export const createTimelineRenderAndLoadModule = (ctx: any) => {
  const {
    mixtapeMixMode,
    requestTimelineWorkerRender,
    timelineWorkerReady,
    timelineCanvasRef,
    timelineScrollWrapRef,
    timelineScrollRef,
    timelineViewportWidth,
    timelineViewportHeight,
    timelineScrollLeft,
    timelineScrollTop,
    isTimelineZooming,
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
    resolveWaveformSubLaneMetrics,
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
    pushStemWaveformToWorker,
    pushRawWaveformToWorker,
    clearWaveformTileCacheForFile,
    buildRawWaveformPyramid,
    rawWaveformPyramidMap,
    decodeRawWaveformData,
    isValidWaveformData,
    tracks,
    resolveWaveformListRoot,
    resolveTrackWaveformSources,
    waveformInflight,
    waveformQueuedMissing,
    rawWaveformInflight,
    waveformLoadTimerRef,
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
    drawStemWaveform,
    useRawWaveform,
    waveformVersion
  } = ctx
  const isStemMixMode = () => mixtapeMixMode?.value !== 'traditional'
  const isStemWaveformData = (value: unknown): value is StemWaveformData =>
    Boolean(value && typeof value === 'object' && (value as StemWaveformData).all)
  const isMixxxWaveformData = (value: unknown): value is MixxxWaveformData =>
    Boolean(value && typeof value === 'object' && (value as MixxxWaveformData).bands)

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
  const RAW_VISIBLE_BUFFER_PX = Math.max(WAVEFORM_TILE_WIDTH, Math.round(RENDER_X_BUFFER_PX * 1.5))
  const RAW_BATCH_MAX_CONCURRENT = 2
  let rawLoadInFlight = false
  let rawLoadRerunPending = false
  const drawTimelineCanvas = () => {
    const canvas = timelineCanvasRef.value
    const wrap = timelineScrollWrapRef.value
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    if (!canvas || !wrap || !viewport) return
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

    if (isStemMixMode() && timelineWorkerReady.value) {
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
      const waveformSources = resolveTrackWaveformSources(track)
      if (!waveformSources.length) return
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

      for (const waveformSource of waveformSources) {
        const filePath = waveformSource.filePath
        if (!filePath) continue
        const subLane = resolveWaveformSubLaneMetrics(
          laneH,
          waveformSource.laneIndex,
          waveformSource.laneCount
        )
        const subTrackY = trackY + subLane.offset
        if (subTrackY > heightPx || subTrackY + subLane.height < 0) continue
        const renderCtx = buildTrackRenderContext(track, {
          renderZoomValue: zoomValue,
          waveformFilePath: filePath,
          waveformStemId: waveformSource.stemId,
          laneHeight: subLane.height
        })
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
          const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, trackWidth - tileStart))
          if (!tileWidth) continue
          const cacheKey = buildWaveformTileCacheKey(
            filePath,
            waveformSource.stemId,
            tileIndex,
            zoomValue,
            Math.max(1, Math.floor(tileWidth)),
            Math.max(1, Math.floor(subLane.height)),
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
              if (isStemMixMode() && waveformRenderWorker) {
                requestWaveformTileRender(task)
              } else {
                renderWaveformTileToCache(task)
                cached = waveformTileCache.get(cacheKey)
              }
            }
          }
          if (cached) {
            const source = cached.source
            ctx.drawImage(
              source,
              trackStartX + tileStart - startX,
              subTrackY,
              tileWidth,
              subLane.height
            )
            touchWaveformTileCache(cacheKey)
          }
        }
      }
      const visibleWidth = Math.max(0, localEnd - localStart)
      if (showGridLines && visibleWidth > 0) {
        const renderPxPerSecSafe = Math.max(0.0001, resolveRenderPxPerSec(zoomValue))
        const trackStartSecFromPx = Math.max(
          0,
          (trackStartX - TIMELINE_SIDE_PADDING_PX) / renderPxPerSecSafe
        )
        const trackStartSec =
          Number.isFinite(Number(item.startSec)) && Number(item.startSec) >= 0
            ? Number(item.startSec)
            : trackStartSecFromPx
        const adjustedFirstBeatMs =
          resolveTrackFirstBeatMs(track) + (trackStartSec - trackStartSecFromPx) * 1000
        for (const waveformSource of waveformSources) {
          const subLane = resolveWaveformSubLaneMetrics(
            laneH,
            waveformSource.laneIndex,
            waveformSource.laneCount
          )
          const subTrackY = trackY + subLane.offset
          if (subTrackY > heightPx || subTrackY + subLane.height < 0) continue
          ctx.save()
          ctx.translate(trackStartX + localStart - startX, subTrackY)
          drawTrackGridLines(
            ctx,
            visibleWidth,
            subLane.height,
            Number(track.bpm) || 0,
            adjustedFirstBeatMs,
            Number(track.barBeatOffset) || 0,
            { start: localStart, end: localEnd },
            renderPxPerSecSafe,
            barOnlyGrid,
            zoomValue
          )
          ctx.restore()
        }
      }
    })
  }

  const scheduleTimelineDraw = () => {
    if ((!isStemMixMode() || !timelineWorkerReady.value) && isTimelineZooming.value) {
      drawTimelineCanvas()
      return
    }
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

  const resolveWaveformFrameCount = (
    data: TimelineWaveformData | null,
    stemMode: boolean
  ): number => {
    if (!data) return 0
    if (stemMode && isStemWaveformData(data)) {
      const all = data.all
      return Math.min(all.left.length, all.right.length)
    }
    if (!stemMode && isMixxxWaveformData(data)) {
      const low = data.bands.low
      const mid = data.bands.mid
      const high = data.bands.high
      const all = data.bands.all
      return Math.min(
        low.left.length,
        low.right.length,
        mid.left.length,
        mid.right.length,
        high.left.length,
        high.right.length,
        all.left.length,
        all.right.length
      )
    }
    return 0
  }

  const buildTrackRenderContext = (
    track: MixtapeTrack,
    options?: {
      renderZoomValue?: number
      waveformFilePath?: string
      waveformStemId?: MixtapeWaveformStemId
      laneHeight?: number
    }
  ): WaveformRenderContext => {
    const waveformFilePath = String(options?.waveformFilePath || track.filePath || '').trim()
    const waveformStemId = options?.waveformStemId || 'inst'
    const data = (waveformDataMap.get(waveformFilePath) || null) as TimelineWaveformData | null
    const sourceDurationSeconds =
      data && Number.isFinite(data.duration) && data.duration > 0
        ? data.duration
        : resolveTrackSourceDurationSeconds(track)
    const durationSeconds = resolveTrackDurationSeconds(track)
    const zoomValue =
      typeof options?.renderZoomValue === 'number'
        ? clampZoomValue(options.renderZoomValue)
        : normalizedRenderZoom.value
    const rawData =
      zoomValue >= RAW_WAVEFORM_MIN_ZOOM ? rawWaveformDataMap.get(waveformFilePath) || null : null
    const frameCount = resolveWaveformFrameCount(data, isStemMixMode())

    const trackWidth = resolveTrackRenderWidthPx(track, zoomValue)
    return {
      track,
      waveformFilePath,
      waveformStemId,
      trackWidth,
      sourceDurationSeconds,
      durationSeconds,
      data,
      frameCount,
      rawData,
      renderZoom: zoomValue,
      renderPxPerSec: resolveRenderPxPerSec(zoomValue),
      laneHeight: Math.max(
        1,
        Math.round(
          Number.isFinite(Number(options?.laneHeight))
            ? Number(options?.laneHeight)
            : resolveLaneHeightForZoom(zoomValue)
        )
      )
    }
  }

  const renderSummaryWaveformBar = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => {
    const barHeight = Math.max(4, Math.round(height * 0.55 * MIXTAPE_WAVEFORM_HEIGHT_SCALE))
    const y = Math.round((height - barHeight) / 2)
    ctx.fillStyle = 'rgba(120, 205, 255, 0.52)'
    ctx.fillRect(0, y, width, barHeight)
  }

  const renderWaveformTileContents = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    render: WaveformRenderContext,
    tile: WaveformTile
  ) => {
    const { trackWidth, sourceDurationSeconds, data, frameCount, rawData } = render
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
      render.waveformFilePath && rawData
        ? resolveRawWaveformLevel(render.waveformFilePath, rawData, rawSamplesPerPixel)
        : rawData

    const stemMode = isStemMixMode()
    const stemData = stemMode && isStemWaveformData(data) ? data : null
    const mixxxData = !stemMode && isMixxxWaveformData(data) ? data : null
    if (stemMode && !stemData) return
    if (!stemMode && !mixxxData) return

    const drawWaveform = (targetCtx: CanvasRenderingContext2D, targetWidth: number) => {
      if (stemData) {
        drawStemWaveform(targetCtx, targetWidth, height, stemData, useHalfWaveform(), {
          startFrame,
          endFrame,
          startTime,
          endTime,
          raw: resolvedRaw,
          stemId: render.waveformStemId
        })
        return
      }
      drawMixxxRgbWaveform(targetCtx, targetWidth, height, mixxxData, useHalfWaveform(), {
        startFrame,
        endFrame,
        startTime,
        endTime,
        raw: resolvedRaw
      })
    }

    const renderScale = render.renderZoom >= 1 ? MIXTAPE_WAVEFORM_SUPERSAMPLE : 1
    if (renderScale > 1) {
      const scratch = ensureWaveformScratch(width * renderScale, height)
      if (scratch) {
        drawWaveform(scratch.ctx, width * renderScale)
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

    drawWaveform(ctx, width)
  }

  const scheduleWaveformDraw = (_deferSwap: boolean = false) => {
    scheduleTimelineDraw()
  }

  const decodeUint8Array = (value: unknown): Uint8Array | null => {
    if (!value) return null
    if (value instanceof Uint8Array) return value
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value)
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value.map((item) => Number(item) || 0))
    }
    return null
  }

  const decodeStemWaveformData = (payload: unknown): StemWaveformData | null => {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as Record<string, any>
    const allRaw = source.all || source.bands?.all
    if (!allRaw || typeof allRaw !== 'object') return null
    const left = decodeUint8Array(allRaw.left)
    const right = decodeUint8Array(allRaw.right)
    const peakLeft = decodeUint8Array(allRaw.peakLeft) || left
    const peakRight = decodeUint8Array(allRaw.peakRight) || right
    if (!left || !right || !peakLeft || !peakRight) return null
    const frameCount = Math.min(left.length, right.length, peakLeft.length, peakRight.length)
    if (!frameCount) return null
    return {
      duration: Number(source.duration) || 0,
      sampleRate: Number(source.sampleRate) || 0,
      step: Number(source.step) || 0,
      all: {
        left: left.subarray(0, frameCount),
        right: right.subarray(0, frameCount),
        peakLeft: peakLeft.subarray(0, frameCount),
        peakRight: peakRight.subarray(0, frameCount)
      }
    }
  }

  const decodeMixxxBand = (value: unknown) => {
    if (!value || typeof value !== 'object') return null
    const source = value as Record<string, unknown>
    const left = decodeUint8Array(source.left)
    const right = decodeUint8Array(source.right)
    const peakLeft = decodeUint8Array(source.peakLeft) || left
    const peakRight = decodeUint8Array(source.peakRight) || right
    if (!left || !right || !peakLeft || !peakRight) return null
    const frameCount = Math.min(left.length, right.length, peakLeft.length, peakRight.length)
    if (!frameCount) return null
    return {
      left: left.subarray(0, frameCount),
      right: right.subarray(0, frameCount),
      peakLeft: peakLeft.subarray(0, frameCount),
      peakRight: peakRight.subarray(0, frameCount)
    }
  }

  const decodeMixxxWaveformData = (payload: unknown): MixxxWaveformData | null => {
    if (!payload || typeof payload !== 'object') return null
    const source = payload as Record<string, any>
    const bands = source.bands && typeof source.bands === 'object' ? source.bands : source
    const low = decodeMixxxBand(bands?.low)
    const mid = decodeMixxxBand(bands?.mid)
    const high = decodeMixxxBand(bands?.high)
    const all = decodeMixxxBand(bands?.all)
    if (!low || !mid || !high || !all) return null
    return {
      duration: Number(source.duration) || 0,
      sampleRate: Number(source.sampleRate) || 0,
      step: Number(source.step) || 0,
      bands: {
        low,
        mid,
        high,
        all
      }
    }
  }

  const storeWaveformData = (filePath: string, data: TimelineWaveformData | null) => {
    if (!filePath) return
    const normalized = isValidWaveformData(data) ? data : null
    if (waveformDataMap.has(filePath)) {
      waveformDataMap.delete(filePath)
    }
    waveformDataMap.set(filePath, normalized)
    if (isStemMixMode()) {
      const stemData = normalized && isStemWaveformData(normalized) ? normalized : null
      pushStemWaveformToWorker(filePath, stemData)
    }
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
    let response: { items?: Array<{ filePath: string; data: unknown }> } | null = null
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

    const stemModeAtRequest = isStemMixMode()
    const decodeWaveformData = stemModeAtRequest
      ? (payload: unknown) => decodeStemWaveformData(payload)
      : (payload: unknown) => decodeMixxxWaveformData(payload)
    const itemMap = new Map(
      items.map((item) => [item.filePath, decodeWaveformData(item.data) ?? null])
    )
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

  const fetchStemWaveformBundleBatch = async (requestItems: StemWaveformBatchRequestItem[]) => {
    if (!requestItems.length) return
    const requestedFilePathToRoot = new Map<string, string>()
    for (const item of requestItems) {
      const stemPaths = item?.stemPaths || {}
      const requiredPaths = [
        stemPaths.vocalPath,
        stemPaths.instPath,
        stemPaths.drumsPath,
        ...(item.stemMode === '4stems' ? [stemPaths.bassPath] : [])
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
      for (const filePath of requiredPaths) {
        if (requestedFilePathToRoot.has(filePath)) continue
        requestedFilePathToRoot.set(filePath, String(item.listRoot || '').trim())
      }
    }
    const requestedPaths = Array.from(requestedFilePathToRoot.keys())
    if (!requestedPaths.length) return
    for (const filePath of requestedPaths) {
      waveformInflight.add(filePath)
    }

    let response: {
      items?: Array<{
        sourceFilePath?: string
        stems?: Array<{ stemId?: string; filePath?: string; data?: unknown }>
      }>
    } | null = null
    try {
      response = await window.electron.ipcRenderer.invoke('mixtape-stem-waveform-cache:batch', {
        items: requestItems
      })
    } catch {
      response = null
    }

    const responseItems = Array.isArray(response?.items) ? response!.items : []
    const responseDataMap = new Map<string, StemWaveformData | null>()
    for (const item of responseItems) {
      const stems = Array.isArray(item?.stems) ? item.stems : []
      for (const stem of stems) {
        const filePath = String(stem?.filePath || '').trim()
        if (!filePath) continue
        responseDataMap.set(filePath, decodeStemWaveformData(stem?.data) ?? null)
      }
    }

    const missing: string[] = []
    for (const filePath of requestedPaths) {
      const data = responseDataMap.has(filePath) ? responseDataMap.get(filePath) : null
      storeWaveformData(filePath, data ?? null)
      if (data) {
        waveformQueuedMissing.delete(filePath)
      } else {
        missing.push(filePath)
      }
      waveformInflight.delete(filePath)
    }

    if (missing.length) {
      const grouped = new Map<string, string[]>()
      const groupedSet = new Map<string, Set<string>>()
      for (const filePath of missing) {
        if (waveformQueuedMissing.has(filePath)) continue
        const listRoot = requestedFilePathToRoot.get(filePath) || ''
        const existing = grouped.get(listRoot) || []
        const existingSet = groupedSet.get(listRoot) || new Set<string>()
        if (existingSet.has(filePath)) continue
        existingSet.add(filePath)
        existing.push(filePath)
        grouped.set(listRoot, existing)
        groupedSet.set(listRoot, existingSet)
        waveformQueuedMissing.add(filePath)
      }
      for (const [listRoot, filePaths] of grouped.entries()) {
        if (!filePaths.length) continue
        window.electron.ipcRenderer.send('mixtape-waveform:queue-visible', {
          filePaths,
          listRoot: listRoot || undefined
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
        targetRate: RAW_WAVEFORM_TARGET_RATE,
        preferSharedDecode: true
      })
    } catch {
      response = null
    }
    const items = Array.isArray(response?.items) ? response!.items : []
    const itemMap = new Map(items.map((entry) => [entry?.filePath || '', entry?.data ?? null]))
    let updated = false
    for (const filePath of filePaths) {
      try {
        const decoded = decodeRawWaveformData(itemMap.get(filePath))
        rawWaveformDataMap.set(filePath, decoded)
        if (decoded) {
          rawWaveformPyramidMap.set(filePath, buildRawWaveformPyramid(decoded))
        } else {
          rawWaveformPyramidMap.delete(filePath)
        }
        pushRawWaveformToWorker(filePath, decoded)
        clearWaveformTileCacheForFile(filePath)
        updated = true
      } catch {
        rawWaveformDataMap.set(filePath, null)
        rawWaveformPyramidMap.delete(filePath)
        pushRawWaveformToWorker(filePath, null)
        clearWaveformTileCacheForFile(filePath)
        updated = true
      } finally {
        rawWaveformInflight.delete(filePath)
      }
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
    if (!isStemMixMode()) {
      const grouped = new Map<string, string[]>()
      for (const track of tracks.value) {
        const waveformSources = resolveTrackWaveformSources(track)
        if (!waveformSources.length) continue
        const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
        const listKey = listRoot || ''
        const list = grouped.get(listKey) || []
        for (const source of waveformSources) {
          const filePath = String(source.filePath || '').trim()
          if (!filePath || waveformDataMap.has(filePath) || waveformInflight.has(filePath)) continue
          if (!list.includes(filePath)) {
            list.push(filePath)
          }
        }
        if (list.length) {
          grouped.set(listKey, list)
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
      return
    }

    const stemBundleRequestItems: StemWaveformBatchRequestItem[] = []
    const stemBundleRequestKeySet = new Set<string>()

    for (const track of tracks.value) {
      const waveformSources = resolveTrackWaveformSources(track)
      if (!waveformSources.length) continue
      const pendingSources = waveformSources.filter((waveformSource: { filePath?: string }) => {
        const filePath = String(waveformSource.filePath || '').trim()
        if (!filePath) return false
        if (waveformDataMap.has(filePath)) return false
        if (waveformInflight.has(filePath)) return false
        return true
      })
      if (!pendingSources.length) continue
      const sourceFilePath = String(track.filePath || '').trim()
      const stemMode: '4stems' = '4stems'
      const requestKey = [
        sourceFilePath,
        stemMode,
        String(track.stemModel || '').trim(),
        String(track.stemVersion || '').trim()
      ].join('::')
      if (sourceFilePath && !stemBundleRequestKeySet.has(requestKey)) {
        stemBundleRequestKeySet.add(requestKey)
        const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
        stemBundleRequestItems.push({
          listRoot,
          sourceFilePath,
          stemMode,
          stemModel: String(track.stemModel || '').trim() || undefined,
          stemVersion: String(track.stemVersion || '').trim() || undefined,
          stemPaths: {
            vocalPath: String(track.stemVocalPath || '').trim() || undefined,
            instPath: String(track.stemInstPath || '').trim() || undefined,
            bassPath: String(track.stemBassPath || '').trim() || undefined,
            drumsPath: String(track.stemDrumsPath || '').trim() || undefined
          }
        })
      }
    }
    if (stemBundleRequestItems.length === 0) {
      scheduleWaveformDraw()
      return
    }
    for (let i = 0; i < stemBundleRequestItems.length; i += WAVEFORM_BATCH_SIZE) {
      const batch = stemBundleRequestItems.slice(i, i + WAVEFORM_BATCH_SIZE)
      await fetchStemWaveformBundleBatch(batch)
    }
  }

  const loadRawWaveforms = async () => {
    if (rawLoadInFlight) {
      rawLoadRerunPending = true
      return
    }
    rawLoadInFlight = true
    try {
      if (!tracks.value.length) return
      if (!useRawWaveform.value) return

      const collectVisibleTargets = () => {
        const viewport =
          (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
          null
        const viewportLeft = Math.max(
          0,
          Math.floor(viewport?.scrollLeft || Number(timelineScrollLeft.value || 0))
        )
        const viewportWidth = Math.max(
          0,
          Math.floor(viewport?.clientWidth || Number(timelineViewportWidth.value || 0))
        )

        const targets: string[] = []
        const targetSet = new Set<string>()
        const pushTarget = (filePath: string) => {
          if (!filePath) return
          if (targetSet.has(filePath)) return
          if (rawWaveformDataMap.has(filePath) || rawWaveformInflight.has(filePath)) return
          targetSet.add(filePath)
          targets.push(filePath)
        }

        if (viewportWidth <= 0) {
          const fallbackLimit = Math.max(RAW_WAVEFORM_BATCH_SIZE, RAW_WAVEFORM_BATCH_SIZE * 2)
          for (const track of tracks.value) {
            const waveformSources = resolveTrackWaveformSources(track)
            for (const waveformSource of waveformSources) {
              pushTarget(waveformSource.filePath)
            }
            if (targets.length >= fallbackLimit) break
          }
          return targets
        }

        const visibleStart = Math.max(0, viewportLeft - RAW_VISIBLE_BUFFER_PX)
        const visibleEnd = Math.max(
          visibleStart,
          Math.ceil(viewportLeft + viewportWidth + RAW_VISIBLE_BUFFER_PX)
        )
        const snapshot = buildSequentialLayoutForZoom(normalizedRenderZoom.value)
        forEachVisibleLayoutItem(
          snapshot,
          visibleStart,
          visibleEnd,
          (item: TimelineTrackLayout) => {
            const waveformSources = resolveTrackWaveformSources(item.track)
            for (const waveformSource of waveformSources) {
              pushTarget(waveformSource.filePath)
            }
          }
        )
        return targets
      }

      const targets = collectVisibleTargets()
      if (!targets.length) return

      const batches: string[][] = []
      for (let i = 0; i < targets.length; i += RAW_WAVEFORM_BATCH_SIZE) {
        const batch = targets.slice(i, i + RAW_WAVEFORM_BATCH_SIZE)
        if (batch.length) batches.push(batch)
      }
      if (!batches.length) return

      const maxConcurrent = Math.max(1, Math.min(RAW_BATCH_MAX_CONCURRENT, batches.length))
      let cursor = 0
      const runNext = async () => {
        while (cursor < batches.length) {
          const index = cursor
          cursor += 1
          const batch = batches[index]
          await fetchRawWaveformBatch(batch)
        }
      }
      await Promise.all(Array.from({ length: maxConcurrent }, () => runNext()))
    } finally {
      rawLoadInFlight = false
      if (rawLoadRerunPending) {
        rawLoadRerunPending = false
        void loadRawWaveforms()
      }
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
    if (!isStemMixMode()) {
      let listRoot = ''
      for (const track of tracks.value) {
        const waveformSource = resolveTrackWaveformSources(track).find(
          (item: { filePath: string }) => item.filePath === filePath
        )
        if (waveformSource?.listRoot) {
          listRoot = waveformSource.listRoot
          break
        }
      }
      void fetchWaveformBatch([filePath], listRoot || undefined)
      return
    }

    const stemBundleRequestItems: StemWaveformBatchRequestItem[] = []
    const stemBundleRequestKeySet = new Set<string>()
    for (const track of tracks.value) {
      const waveformSources = resolveTrackWaveformSources(track)
      if (!waveformSources.some((source: { filePath?: string }) => source.filePath === filePath)) {
        continue
      }
      const sourceFilePath = String(track.filePath || '').trim()
      if (!sourceFilePath) continue
      const stemMode: '4stems' = '4stems'
      const requestKey = [
        sourceFilePath,
        stemMode,
        String(track.stemModel || '').trim(),
        String(track.stemVersion || '').trim()
      ].join('::')
      if (stemBundleRequestKeySet.has(requestKey)) continue
      stemBundleRequestKeySet.add(requestKey)
      const listRoot = waveformSources[0]?.listRoot || resolveWaveformListRoot(track)
      stemBundleRequestItems.push({
        listRoot,
        sourceFilePath,
        stemMode,
        stemModel: String(track.stemModel || '').trim() || undefined,
        stemVersion: String(track.stemVersion || '').trim() || undefined,
        stemPaths: {
          vocalPath: String(track.stemVocalPath || '').trim() || undefined,
          instPath: String(track.stemInstPath || '').trim() || undefined,
          bassPath: String(track.stemBassPath || '').trim() || undefined,
          drumsPath: String(track.stemDrumsPath || '').trim() || undefined
        }
      })
    }
    if (stemBundleRequestItems.length > 0) {
      void fetchStemWaveformBundleBatch(stemBundleRequestItems)
      return
    }
    let listRoot = ''
    for (const track of tracks.value) {
      const waveformSource = resolveTrackWaveformSources(track).find(
        (item: { filePath: string }) => item.filePath === filePath
      )
      if (waveformSource?.listRoot) {
        listRoot = waveformSource.listRoot
        break
      }
    }
    void fetchWaveformBatch([filePath], listRoot || undefined)
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
