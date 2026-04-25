import type { Ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseWaveformTileCacheKey,
  disposeHorizontalBrowseWaveformBitmap,
  normalizeHorizontalBrowsePathKey,
  resolveHorizontalBrowseWaveformThemeVariant
} from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import {
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  clampNumber
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import type {
  HorizontalBrowseDetailWaveformTileRequest,
  HorizontalBrowseDetailWaveformWorkerIncoming,
  HorizontalBrowseDetailWaveformWorkerOutgoing,
  HorizontalBrowseWaveformThemeVariant
} from '@renderer/workers/horizontalBrowseDetailWaveform.types'
import { createHorizontalBrowseDetailWaveformWorker } from '@renderer/workers/horizontalBrowseDetailWaveform.workerClient'
import { clampHorizontalBrowsePreviewStartByVisibleDuration } from '@renderer/components/horizontalBrowseDetailMath'

type HorizontalBrowseWaveformLayout = 'top-half' | 'bottom-half'

type HorizontalBrowseWaveformTileCacheEntry = {
  bitmap: ImageBitmap
  width: number
  height: number
  pixelRatio: number
  used: number
}

type HorizontalBrowseVisibleTilePaintPayload = {
  cacheKey: string
  rangeStartSec: number
  rangeDurationSec: number
}

type CreateHorizontalBrowseRawWaveformTileManagerOptions = {
  wrapRef: Ref<HTMLDivElement | null>
  waveformCanvasRef: Ref<HTMLCanvasElement | null>
  displayStartSec: Ref<number>
  displayReady: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  playing: Ref<boolean>
  getSongFilePath: () => string
  resolvePreviewTimeScale: () => number
  resolvePreviewDurationSec: () => number
  resolveVisibleDurationSec: () => number
  resolvePreviewAnchorSec: () => number
  resolveTimeBasisOffsetMs: () => number
  clampPreviewStart: (value: number) => number
  resolvePlaybackDrivenRenderStartSec: (visibleDuration: number) => number
  resolveWaveformLayout: () => HorizontalBrowseWaveformLayout
  resolveLastZoomAnchor: () => { sec: number; ratio: number }
  drawGridAndOverlay: (rangeStartSec: number, rangeDurationSec: number) => void
  scheduleDraw: () => void
}

const WAVEFORM_TILE_WIDTH = 256
const WAVEFORM_TILE_OVERSCAN = 1
const WAVEFORM_TILE_CACHE_LIMIT = 72
const WAVEFORM_PREWARM_STEP_COUNT = 2

const cloneRawWaveformData = (value: RawWaveformData): RawWaveformData => ({
  duration: Number(value.duration) || 0,
  sampleRate: Number(value.sampleRate) || 0,
  rate: Number(value.rate) || 0,
  frames: Math.max(0, Number(value.frames) || 0),
  startSec: Math.max(0, Number(value.startSec) || 0),
  minLeft: new Float32Array(value.minLeft),
  maxLeft: new Float32Array(value.maxLeft),
  minRight: new Float32Array(value.minRight),
  maxRight: new Float32Array(value.maxRight)
})

export const createHorizontalBrowseRawWaveformTileManager = (
  options: CreateHorizontalBrowseRawWaveformTileManagerOptions
) => {
  let waveformRenderToken = 0
  let waveformTileCacheTick = 0
  let lastWaveformBatchSignature = ''
  let tilePaintRaf = 0
  let waveformWorker: ReturnType<typeof createHorizontalBrowseDetailWaveformWorker> | null = null

  const waveformTilePending = new Set<string>()
  const waveformTileCache = new Map<string, HorizontalBrowseWaveformTileCacheEntry>()
  const pendingVisibleTilePaints = new Map<string, HorizontalBrowseVisibleTilePaintPayload>()

  const clearWaveformWorkerQueue = () => {
    if (!waveformWorker) return
    const message: HorizontalBrowseDetailWaveformWorkerIncoming = { type: 'clearQueue' }
    waveformWorker.postMessage(message)
  }

  const clearWaveformTileCache = () => {
    waveformTilePending.clear()
    pendingVisibleTilePaints.clear()
    lastWaveformBatchSignature = ''
    waveformTileCacheTick = 0
    for (const entry of waveformTileCache.values()) {
      disposeHorizontalBrowseWaveformBitmap(entry.bitmap)
    }
    waveformTileCache.clear()
  }

  const invalidateWaveformTiles = () => {
    waveformRenderToken += 1
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
  }

  const pruneWaveformTileCache = () => {
    while (waveformTileCache.size > WAVEFORM_TILE_CACHE_LIMIT) {
      let oldestKey = ''
      let oldestUsed = Number.POSITIVE_INFINITY
      for (const [key, entry] of waveformTileCache.entries()) {
        if (entry.used >= oldestUsed) continue
        oldestUsed = entry.used
        oldestKey = key
      }
      if (!oldestKey) break
      const entry = waveformTileCache.get(oldestKey)
      if (entry) {
        disposeHorizontalBrowseWaveformBitmap(entry.bitmap)
      }
      waveformTileCache.delete(oldestKey)
      waveformTilePending.delete(oldestKey)
    }
  }

  const resolveWaveformCanvasMetrics = () => {
    const wrap = options.wrapRef.value
    const canvas = options.waveformCanvasRef.value
    if (!wrap || !canvas) return null
    const cssWidth = Math.max(1, wrap.clientWidth)
    const cssHeight = Math.max(1, wrap.clientHeight)
    const metrics = resolveCanvasScaleMetrics(cssWidth, cssHeight, window.devicePixelRatio || 1)
    if (canvas.width !== metrics.scaledWidth) {
      canvas.width = metrics.scaledWidth
    }
    if (canvas.height !== metrics.scaledHeight) {
      canvas.height = metrics.scaledHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    return {
      wrap,
      canvas,
      ctx,
      metrics
    }
  }

  const drawWaveformTileSegment = (payload: {
    ctx: CanvasRenderingContext2D
    scaledWidth: number
    scaledHeight: number
    entry: HorizontalBrowseWaveformTileCacheEntry
    tileRangeStartSec: number
    tileRangeDurationSec: number
    viewStartSec: number
    visibleDuration: number
  }) => {
    const tileStartSec = payload.tileRangeStartSec
    const tileEndSec = tileStartSec + payload.tileRangeDurationSec
    const viewEndSec = payload.viewStartSec + payload.visibleDuration
    const overlapStartSec = Math.max(payload.viewStartSec, tileStartSec)
    const overlapEndSec = Math.min(viewEndSec, tileEndSec)
    if (overlapEndSec <= overlapStartSec) return false

    waveformTileCacheTick += 1
    payload.entry.used = waveformTileCacheTick
    const srcScaleX =
      payload.entry.width > 0
        ? payload.entry.bitmap.width / payload.entry.width
        : payload.entry.pixelRatio || 1
    const srcLeftPx =
      ((overlapStartSec - tileStartSec) / payload.tileRangeDurationSec) *
      payload.entry.width *
      srcScaleX
    const srcRightPx =
      ((overlapEndSec - tileStartSec) / payload.tileRangeDurationSec) *
      payload.entry.width *
      srcScaleX
    const destLeftPx =
      ((overlapStartSec - payload.viewStartSec) / payload.visibleDuration) * payload.scaledWidth
    const destRightPx =
      ((overlapEndSec - payload.viewStartSec) / payload.visibleDuration) * payload.scaledWidth
    const srcWidth = srcRightPx - srcLeftPx
    const destWidth = destRightPx - destLeftPx
    if (srcWidth <= 0.0001 || destWidth <= 0.0001) return false

    payload.ctx.drawImage(
      payload.entry.bitmap,
      srcLeftPx,
      0,
      srcWidth,
      payload.entry.bitmap.height,
      destLeftPx,
      0,
      destWidth,
      payload.scaledHeight
    )
    return true
  }

  const drawSingleWaveformTile = (
    entry: HorizontalBrowseWaveformTileCacheEntry,
    tileRangeStartSec: number,
    tileRangeDurationSec: number,
    viewStartSec: number,
    visibleDuration: number
  ) => {
    const waveformState = resolveWaveformCanvasMetrics()
    if (!waveformState) return false
    return drawWaveformTileSegment({
      ctx: waveformState.ctx,
      scaledWidth: waveformState.metrics.scaledWidth,
      scaledHeight: waveformState.metrics.scaledHeight,
      entry,
      tileRangeStartSec,
      tileRangeDurationSec,
      viewStartSec,
      visibleDuration
    })
  }

  const flushVisibleTilePaints = () => {
    tilePaintRaf = 0
    if (!pendingVisibleTilePaints.size) return
    const filePath = options.getSongFilePath()
    const duration = options.resolvePreviewDurationSec()
    const visibleDuration = Math.max(
      0.001,
      options.resolveVisibleDurationSec() || duration || 0.001
    )
    if (!filePath || !duration || visibleDuration <= 0) {
      pendingVisibleTilePaints.clear()
      return
    }
    options.previewStartSec.value = options.clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = options.resolvePlaybackDrivenRenderStartSec(visibleDuration)
    let paintedAnyTile = false
    for (const payload of pendingVisibleTilePaints.values()) {
      const entry = waveformTileCache.get(payload.cacheKey)
      if (!entry) continue
      paintedAnyTile =
        drawSingleWaveformTile(
          entry,
          payload.rangeStartSec,
          payload.rangeDurationSec,
          renderStartSec,
          visibleDuration
        ) || paintedAnyTile
    }
    pendingVisibleTilePaints.clear()
    if (!paintedAnyTile) {
      options.scheduleDraw()
      return
    }
    options.displayStartSec.value = renderStartSec
    options.displayReady.value = true
    options.drawGridAndOverlay(renderStartSec, visibleDuration)
  }

  const scheduleVisibleTilePaint = (payload: HorizontalBrowseVisibleTilePaintPayload) => {
    if (options.playing.value) {
      options.scheduleDraw()
      return
    }
    pendingVisibleTilePaints.set(payload.cacheKey, payload)
    if (tilePaintRaf) return
    tilePaintRaf = requestAnimationFrame(() => {
      flushVisibleTilePaints()
    })
  }

  const handleWaveformWorkerMessage = (
    event: MessageEvent<HorizontalBrowseDetailWaveformWorkerOutgoing>
  ) => {
    const message = event.data
    if (message?.type !== 'tileRendered') return
    const { payload } = message
    waveformTilePending.delete(payload.cacheKey)

    const currentFilePath = normalizeHorizontalBrowsePathKey(options.getSongFilePath())
    if (
      payload.requestToken !== waveformRenderToken ||
      normalizeHorizontalBrowsePathKey(payload.filePath) !== currentFilePath ||
      !payload.bitmap
    ) {
      disposeHorizontalBrowseWaveformBitmap(payload.bitmap)
      return
    }

    const existing = waveformTileCache.get(payload.cacheKey)
    if (existing) {
      disposeHorizontalBrowseWaveformBitmap(existing.bitmap)
    }
    waveformTileCacheTick += 1
    waveformTileCache.set(payload.cacheKey, {
      bitmap: payload.bitmap,
      width: payload.width,
      height: payload.height,
      pixelRatio: payload.pixelRatio,
      used: waveformTileCacheTick
    })
    pruneWaveformTileCache()
    if (options.playing.value) {
      options.scheduleDraw()
      return
    }
    scheduleVisibleTilePaint({
      cacheKey: payload.cacheKey,
      rangeStartSec: Number(payload.rangeStartSec) || 0,
      rangeDurationSec: Math.max(0.0001, Number(payload.rangeDurationSec) || 0.0001)
    })
  }

  const ensureWaveformWorker = () => {
    if (waveformWorker) return waveformWorker
    waveformWorker = createHorizontalBrowseDetailWaveformWorker()
    waveformWorker.addEventListener('message', handleWaveformWorkerMessage)
    waveformWorker.addEventListener('error', (event) => {
      const message = event instanceof ErrorEvent ? event.message : 'unknown worker error'
      console.error('[horizontal-browse-waveform-worker] error', {
        message,
        filename: (event as ErrorEvent)?.filename,
        lineno: (event as ErrorEvent)?.lineno,
        colno: (event as ErrorEvent)?.colno
      })
    })
    waveformWorker.addEventListener('messageerror', () => {
      console.error('[horizontal-browse-waveform-worker] messageerror')
    })
    return waveformWorker
  }

  const buildWaveformTileRequests = (request: {
    filePath: string
    zoom: number
    cssWidth: number
    cssHeight: number
    pixelRatio: number
    rangeStartSec: number
    rangeDurationSec: number
    themeVariant: HorizontalBrowseWaveformThemeVariant
    overscanTiles: number
  }): HorizontalBrowseDetailWaveformTileRequest[] => {
    const safeCssWidth = Math.max(1, Math.floor(request.cssWidth))
    const safeCssHeight = Math.max(1, Math.floor(request.cssHeight))
    const tileWidth = Math.max(1, Math.min(WAVEFORM_TILE_WIDTH, safeCssWidth))
    const tileDurationSec = (Math.max(0.0001, request.rangeDurationSec) * tileWidth) / safeCssWidth
    if (!Number.isFinite(tileDurationSec) || tileDurationSec <= 0) return []
    const timeBasisOffsetMs = Math.max(0, Number(options.resolveTimeBasisOffsetMs()) || 0)

    const rangeEndSec = request.rangeStartSec + request.rangeDurationSec
    const firstIndex = Math.max(
      0,
      Math.floor(request.rangeStartSec / tileDurationSec) - Math.max(0, request.overscanTiles)
    )
    const lastIndex =
      Math.max(
        firstIndex,
        Math.floor(Math.max(0, rangeEndSec - Number.EPSILON) / tileDurationSec)
      ) + Math.max(0, request.overscanTiles)

    const requests: HorizontalBrowseDetailWaveformTileRequest[] = []
    for (let tileIndex = firstIndex; tileIndex <= lastIndex; tileIndex += 1) {
      requests.push({
        requestToken: waveformRenderToken,
        filePath: request.filePath,
        cacheKey: buildHorizontalBrowseWaveformTileCacheKey({
          filePath: request.filePath,
          waveformLayout: options.resolveWaveformLayout(),
          themeVariant: request.themeVariant,
          zoom: request.zoom,
          timeScale: options.resolvePreviewTimeScale(),
          cssWidth: safeCssWidth,
          cssHeight: safeCssHeight,
          pixelRatio: request.pixelRatio,
          tileIndex,
          timeBasisOffsetMs
        }),
        width: tileWidth,
        height: safeCssHeight,
        pixelRatio: request.pixelRatio,
        rangeStartSec: tileIndex * tileDurationSec,
        rangeDurationSec: tileDurationSec,
        timeBasisOffsetMs,
        maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
        themeVariant: request.themeVariant,
        waveformLayout: options.resolveWaveformLayout()
      })
    }
    return requests
  }

  const buildWaveformRenderPlan = (request: {
    filePath: string
    cssWidth: number
    cssHeight: number
    pixelRatio: number
    rangeStartSec: number
    themeVariant: HorizontalBrowseWaveformThemeVariant
  }) => {
    const duration = options.resolvePreviewDurationSec()
    const visibleDuration = Math.max(
      0.001,
      options.resolveVisibleDurationSec() || duration || 0.001
    )
    const visibleRequests = buildWaveformTileRequests({
      filePath: request.filePath,
      zoom: options.previewZoom.value,
      cssWidth: request.cssWidth,
      cssHeight: request.cssHeight,
      pixelRatio: request.pixelRatio,
      rangeStartSec: request.rangeStartSec,
      rangeDurationSec: visibleDuration,
      themeVariant: request.themeVariant,
      overscanTiles: WAVEFORM_TILE_OVERSCAN
    })

    const lastZoomAnchor = options.resolveLastZoomAnchor()
    const anchorSec = clampNumber(
      Number.isFinite(lastZoomAnchor.sec) ? lastZoomAnchor.sec : options.resolvePreviewAnchorSec(),
      0,
      Math.max(0, duration)
    )
    const anchorRatio = clampNumber(lastZoomAnchor.ratio, 0, 1)
    const prewarmRequests: HorizontalBrowseDetailWaveformTileRequest[] = []

    for (let step = 1; step <= WAVEFORM_PREWARM_STEP_COUNT; step += 1) {
      const factor = HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR ** step
      for (const nextZoom of [
        clampNumber(
          options.previewZoom.value * factor,
          HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
          HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
        ),
        clampNumber(
          options.previewZoom.value / factor,
          HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
          HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
        )
      ]) {
        if (Math.abs(nextZoom - options.previewZoom.value) <= 0.000001) continue
        const nextVisibleDuration = Math.max(
          0.001,
          (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * options.resolvePreviewTimeScale()) /
            nextZoom
        )
        const nextStartSec = clampHorizontalBrowsePreviewStartByVisibleDuration(
          anchorSec - nextVisibleDuration * anchorRatio,
          duration,
          nextVisibleDuration
        )
        prewarmRequests.push(
          ...buildWaveformTileRequests({
            filePath: request.filePath,
            zoom: nextZoom,
            cssWidth: request.cssWidth,
            cssHeight: request.cssHeight,
            pixelRatio: request.pixelRatio,
            rangeStartSec: nextStartSec,
            rangeDurationSec: nextVisibleDuration,
            themeVariant: request.themeVariant,
            overscanTiles: 0
          })
        )
      }
    }

    return {
      visibleRequests,
      prewarmRequests
    }
  }

  const requestWaveformTileBatch = (requests: HorizontalBrowseDetailWaveformTileRequest[]) => {
    const missingRequests = requests.filter((request) => !waveformTileCache.has(request.cacheKey))
    const signature = missingRequests.map((request) => request.cacheKey).join('\n')
    if (signature === lastWaveformBatchSignature) return
    lastWaveformBatchSignature = signature

    waveformTilePending.clear()
    if (!missingRequests.length) return
    for (const request of missingRequests) {
      waveformTilePending.add(request.cacheKey)
    }

    const worker = ensureWaveformWorker()
    const message: HorizontalBrowseDetailWaveformWorkerIncoming = {
      type: 'renderBatch',
      payload: { requests: missingRequests }
    }
    worker.postMessage(message)
  }

  const drawWaveformTiles = (
    viewStartSec: number,
    visibleDuration: number,
    effectiveMixxxData: MixxxWaveformData | null
  ) => {
    const wrap = options.wrapRef.value
    const canvas = options.waveformCanvasRef.value
    if (!wrap || !canvas) return false

    const ctx = canvas.getContext('2d')
    if (!ctx || !options.rawData.value || !effectiveMixxxData) {
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return false
    }

    const metrics = resolveCanvasScaleMetrics(
      wrap.clientWidth,
      wrap.clientHeight,
      window.devicePixelRatio || 1
    )

    const filePath = options.getSongFilePath()
    const themeVariant = resolveHorizontalBrowseWaveformThemeVariant()
    const { visibleRequests, prewarmRequests } = buildWaveformRenderPlan({
      filePath,
      cssWidth: metrics.cssWidth,
      cssHeight: metrics.cssHeight,
      pixelRatio: metrics.pixelRatio,
      rangeStartSec: viewStartSec,
      themeVariant
    })

    requestWaveformTileBatch([...visibleRequests, ...prewarmRequests])

    const hasAnyCachedTile = visibleRequests.some((request) =>
      waveformTileCache.has(request.cacheKey)
    )
    if (!hasAnyCachedTile) return false

    if (canvas.width !== metrics.scaledWidth) {
      canvas.width = metrics.scaledWidth
    }
    if (canvas.height !== metrics.scaledHeight) {
      canvas.height = metrics.scaledHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
    ctx.imageSmoothingEnabled = false

    let drewAnyTile = false
    for (const request of visibleRequests) {
      const entry = waveformTileCache.get(request.cacheKey)
      if (!entry) continue
      drewAnyTile =
        drawWaveformTileSegment({
          ctx,
          scaledWidth: metrics.scaledWidth,
          scaledHeight: metrics.scaledHeight,
          entry,
          tileRangeStartSec: request.rangeStartSec,
          tileRangeDurationSec: request.rangeDurationSec,
          viewStartSec,
          visibleDuration
        }) || drewAnyTile
    }

    return drewAnyTile
  }

  const cancelVisibleTilePaints = () => {
    pendingVisibleTilePaints.clear()
    if (tilePaintRaf) {
      cancelAnimationFrame(tilePaintRaf)
      tilePaintRaf = 0
    }
  }

  const storeRawWaveform = (filePath: string, data: RawWaveformData) => {
    const worker = ensureWaveformWorker()
    const message: HorizontalBrowseDetailWaveformWorkerIncoming = {
      type: 'storeRaw',
      payload: {
        filePath,
        data: cloneRawWaveformData(data)
      }
    }
    worker.postMessage(message)
  }

  const dispose = () => {
    waveformRenderToken += 1
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
    cancelVisibleTilePaints()
    if (waveformWorker) {
      waveformWorker.removeEventListener('message', handleWaveformWorkerMessage)
      waveformWorker.terminate()
      waveformWorker = null
    }
  }

  return {
    invalidateWaveformTiles,
    drawWaveformTiles,
    cancelVisibleTilePaints,
    storeRawWaveform,
    dispose
  }
}
