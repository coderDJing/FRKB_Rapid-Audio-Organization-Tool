import { ref, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/components/horizontalBrowseDetailMath'
import { createBeatAlignPreviewRenderer } from '@renderer/components/mixtapeBeatAlignPreviewRenderer'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  buildHorizontalBrowseWaveformTileCacheKey,
  disposeHorizontalBrowseWaveformBitmap,
  normalizeHorizontalBrowsePathKey,
  resolveHorizontalBrowseWaveformThemeVariant
} from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
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
import { sendHorizontalBrowseWaveformTrace } from '@renderer/components/horizontalBrowseWaveformTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'

type HorizontalBrowseDirection = 'up' | 'down'
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

type UseHorizontalBrowseRawWaveformCanvasOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  playbackRate: () => number | undefined
  playing: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewBpm: Ref<number>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  dragging: Ref<boolean>
  rawStreamActive: Ref<boolean>
}

const WAVEFORM_TILE_WIDTH = 256
const WAVEFORM_TILE_OVERSCAN = 1
const WAVEFORM_TILE_CACHE_LIMIT = 72
const WAVEFORM_PREWARM_STEP_COUNT = 2
const DRAG_RAW_MAX_SAMPLES_PER_PIXEL = 32
const RAW_STREAM_REDRAW_INTERVAL_MS = 80

const cloneRawWaveformData = (value: RawWaveformData): RawWaveformData => ({
  duration: Number(value.duration) || 0,
  sampleRate: Number(value.sampleRate) || 0,
  rate: Number(value.rate) || 0,
  frames: Math.max(0, Number(value.frames) || 0),
  minLeft: new Float32Array(value.minLeft),
  maxLeft: new Float32Array(value.maxLeft),
  minRight: new Float32Array(value.minRight),
  maxRight: new Float32Array(value.maxRight)
})

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const gridRenderer = createBeatAlignPreviewRenderer()
  const streamWaveformRenderer = createBeatAlignPreviewRenderer()

  let waveformWorker: Worker | null = null
  let waveformRenderToken = 0
  let waveformTileCacheTick = 0
  let lastWaveformBatchSignature = ''
  let lastZoomAnchorSec = 0
  let lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  let drawRaf = 0
  let streamDrawRaf = 0
  let tilePaintRaf = 0
  let streamDrawTimer: ReturnType<typeof setTimeout> | null = null
  let nextAllowedStreamDrawAt = 0
  let pendingRawStreamDirtyStartSec: number | null = null
  let pendingRawStreamDirtyEndSec: number | null = null
  let lastRenderTraceSignature = ''

  const waveformTilePending = new Set<string>()
  const waveformTileCache = new Map<string, HorizontalBrowseWaveformTileCacheEntry>()
  const pendingVisibleTilePaints = new Map<string, HorizontalBrowseVisibleTilePaintPayload>()

  const traceHorizontalWaveformRender = (source: string, payload?: Record<string, unknown>) => {
    const filePath = String(options.song()?.filePath || '').trim()
    const signature = `${options.direction()}|${filePath}|${source}`
    if (lastRenderTraceSignature === signature) return
    lastRenderTraceSignature = signature
    sendHorizontalBrowseWaveformTrace('render', source, {
      deck: options.direction(),
      filePath,
      rawStreamActive: options.rawStreamActive.value,
      dragging: options.dragging.value,
      hasRawData: Boolean(options.rawData.value),
      hasMixxxData: Boolean(options.mixxxData.value),
      ...payload
    })
  }

  const resolvePreviewTimeScale = () => Math.max(0.25, Number(options.playbackRate()) || 1)

  const resolvePreviewDurationSec = () => {
    const duration = Number(
      options.rawData.value?.duration ||
        options.mixxxData.value?.duration ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  const resolveVisibleDurationSec = () =>
    Math.max(
      0.001,
      (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
        Number(options.previewZoom.value || HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
    )

  const resolvePreviewAnchorSec = () => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    if (!duration || !visibleDuration) return 0
    return clampNumber(
      options.previewStartSec.value + visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
      0,
      duration
    )
  }

  const clampPreviewStart = (value: number) => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    return clampHorizontalBrowsePreviewStartByVisibleDuration(value, duration, visibleDuration)
  }

  const resolveSnappedRenderStartSec = (visibleDuration: number) => {
    const wrap = wrapRef.value
    const clampedStart = clampPreviewStart(options.previewStartSec.value)
    if (!wrap || visibleDuration <= 0) return clampedStart
    const cssWidth = Math.max(1, Math.floor(wrap.clientWidth))
    const pixelRatio = window.devicePixelRatio || 1
    const scaledWidth = Math.max(1, Math.round(cssWidth * pixelRatio))
    const secPerPixel = visibleDuration / scaledWidth
    if (!Number.isFinite(secPerPixel) || secPerPixel <= 0) return clampedStart
    return clampPreviewStart(Math.round(clampedStart / secPerPixel) * secPerPixel)
  }

  const resolveWaveformLayout = (): HorizontalBrowseWaveformLayout =>
    options.direction() === 'up' ? 'top-half' : 'bottom-half'

  const resolvePlaybackAlignedStart = (seconds: number) =>
    resolveHorizontalBrowsePlaybackAlignedStart(
      seconds,
      resolvePreviewDurationSec(),
      resolveVisibleDurationSec()
    )

  const setLastZoomAnchor = (
    anchorSec: number,
    anchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  ) => {
    lastZoomAnchorSec = Number.isFinite(anchorSec) ? anchorSec : 0
    lastZoomAnchorRatio = clampNumber(anchorRatio, 0, 1)
  }

  const resetLastZoomAnchor = () => {
    setLastZoomAnchor(0, HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO)
  }

  const clearRawStreamDirtyRange = () => {
    pendingRawStreamDirtyStartSec = null
    pendingRawStreamDirtyEndSec = null
  }

  const clearStreamDrawScheduling = () => {
    if (streamDrawTimer) {
      clearTimeout(streamDrawTimer)
      streamDrawTimer = null
    }
    if (streamDrawRaf) {
      cancelAnimationFrame(streamDrawRaf)
      streamDrawRaf = 0
    }
    clearRawStreamDirtyRange()
  }

  const clearCanvas = () => {
    for (const canvas of [waveformCanvasRef.value, gridCanvasRef.value]) {
      if (!canvas) continue
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }

  const clearWaveformCanvas = () => {
    const canvas = waveformCanvasRef.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

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
    const wrap = wrapRef.value
    const canvas = waveformCanvasRef.value
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
    const srcLeftPx = Math.round(
      ((overlapStartSec - tileStartSec) / payload.tileRangeDurationSec) *
        payload.entry.width *
        srcScaleX
    )
    const srcRightPx = Math.round(
      ((overlapEndSec - tileStartSec) / payload.tileRangeDurationSec) *
        payload.entry.width *
        srcScaleX
    )
    const destLeftPx = Math.round(
      ((overlapStartSec - payload.viewStartSec) / payload.visibleDuration) * payload.scaledWidth
    )
    const destRightPx = Math.round(
      ((overlapEndSec - payload.viewStartSec) / payload.visibleDuration) * payload.scaledWidth
    )
    const srcWidth = srcRightPx - srcLeftPx
    const destWidth = destRightPx - destLeftPx
    if (srcWidth <= 0 || destWidth <= 0) return false

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
    const filePath = String(options.song()?.filePath || '').trim()
    const duration = resolvePreviewDurationSec()
    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    if (!filePath || !duration || visibleDuration <= 0) {
      pendingVisibleTilePaints.clear()
      return
    }
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
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
      scheduleDraw()
    }
  }

  const scheduleVisibleTilePaint = (payload: HorizontalBrowseVisibleTilePaintPayload) => {
    pendingVisibleTilePaints.set(payload.cacheKey, payload)
    if (drawRaf || tilePaintRaf) return
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

    const currentFilePath = normalizeHorizontalBrowsePathKey(options.song()?.filePath)
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
      try {
        window.electron.ipcRenderer.send(
          'outputLog',
          `[horizontal-browse-waveform-worker] error: ${message}`
        )
      } catch {}
    })
    waveformWorker.addEventListener('messageerror', () => {
      console.error('[horizontal-browse-waveform-worker] messageerror')
      try {
        window.electron.ipcRenderer.send(
          'outputLog',
          '[horizontal-browse-waveform-worker] messageerror'
        )
      } catch {}
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
          waveformLayout: resolveWaveformLayout(),
          themeVariant: request.themeVariant,
          zoom: request.zoom,
          timeScale: resolvePreviewTimeScale(),
          cssWidth: safeCssWidth,
          cssHeight: safeCssHeight,
          pixelRatio: request.pixelRatio,
          tileIndex
        }),
        width: tileWidth,
        height: safeCssHeight,
        pixelRatio: request.pixelRatio,
        rangeStartSec: tileIndex * tileDurationSec,
        rangeDurationSec: tileDurationSec,
        maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
        themeVariant: request.themeVariant,
        waveformLayout: resolveWaveformLayout()
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
    const duration = resolvePreviewDurationSec()
    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
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

    const anchorSec = clampNumber(
      Number.isFinite(lastZoomAnchorSec) ? lastZoomAnchorSec : resolvePreviewAnchorSec(),
      0,
      Math.max(0, duration)
    )
    const anchorRatio = clampNumber(lastZoomAnchorRatio, 0, 1)
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
          (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
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

  const drawWaveformTiles = (viewStartSec: number, visibleDuration: number) => {
    const wrap = wrapRef.value
    const canvas = waveformCanvasRef.value
    if (!wrap || !canvas) return false

    const ctx = canvas.getContext('2d')
    if (!ctx || !options.rawData.value || !options.mixxxData.value) {
      clearWaveformCanvas()
      return false
    }

    const metrics = resolveCanvasScaleMetrics(
      wrap.clientWidth,
      wrap.clientHeight,
      window.devicePixelRatio || 1
    )
    if (canvas.width !== metrics.scaledWidth) {
      canvas.width = metrics.scaledWidth
    }
    if (canvas.height !== metrics.scaledHeight) {
      canvas.height = metrics.scaledHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
    ctx.imageSmoothingEnabled = false

    const filePath = String(options.song()?.filePath || '').trim()
    const themeVariant = resolveHorizontalBrowseWaveformThemeVariant()
    const { visibleRequests, prewarmRequests } = buildWaveformRenderPlan({
      filePath,
      cssWidth: metrics.cssWidth,
      cssHeight: metrics.cssHeight,
      pixelRatio: metrics.pixelRatio,
      rangeStartSec: viewStartSec,
      themeVariant
    })

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

    requestWaveformTileBatch([...visibleRequests, ...prewarmRequests])
    return drewAnyTile
  }

  const drawWaveform = () => {
    const wrap = wrapRef.value
    const waveformCanvas = waveformCanvasRef.value
    const gridCanvas = gridCanvasRef.value
    if (!wrap || !gridCanvas || !waveformCanvas) return

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      traceHorizontalWaveformRender('none')
      gridRenderer.reset()
      clearCanvas()
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
    const playbackStreamReuse = options.playing.value && !options.dragging.value
    const streamMaxSamplesPerPixel = playbackStreamReuse
      ? PREVIEW_MAX_SAMPLES_PER_PIXEL
      : DRAG_RAW_MAX_SAMPLES_PER_PIXEL

    if (!options.rawData.value || !options.mixxxData.value) {
      traceHorizontalWaveformRender('empty')
      clearWaveformCanvas()
    } else if (options.rawStreamActive.value || options.dragging.value) {
      traceHorizontalWaveformRender('stream-live')
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:stream-live:${options.direction()}`
      )
      streamWaveformRenderer.draw({
        canvas: waveformCanvas,
        wrap,
        bpm: 0,
        firstBeatMs: 0,
        barBeatOffset: 0,
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        mixxxData: options.mixxxData.value,
        rawData: options.rawData.value,
        maxSamplesPerPixel: streamMaxSamplesPerPixel,
        showDetailHighlights: false,
        showCenterLine: false,
        showBackground: false,
        showBeatGrid: false,
        allowScrollReuse: playbackStreamReuse,
        waveformLayout: resolveWaveformLayout(),
        preferRawPeaksOnly: false
      })
      finishTiming()
    } else {
      const drewTiles = drawWaveformTiles(renderStartSec, visibleDuration)
      if (drewTiles) {
        traceHorizontalWaveformRender('tile-cache')
      } else {
        traceHorizontalWaveformRender('stream-fallback')
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:stream-fallback:${options.direction()}`
        )
        streamWaveformRenderer.draw({
          canvas: waveformCanvas,
          wrap,
          bpm: 0,
          firstBeatMs: 0,
          barBeatOffset: 0,
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          mixxxData: options.mixxxData.value,
          rawData: options.rawData.value,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          showDetailHighlights: false,
          showCenterLine: false,
          showBackground: false,
          showBeatGrid: false,
          allowScrollReuse: playbackStreamReuse,
          waveformLayout: resolveWaveformLayout(),
          preferRawPeaksOnly: false
        })
        finishTiming()
      }
    }

    gridRenderer.draw({
      canvas: gridCanvas,
      wrap,
      bpm: Number(options.previewBpm.value) || 0,
      firstBeatMs: Number(options.previewFirstBeatMs.value) || 0,
      barBeatOffset: Number(options.previewBarBeatOffset.value) || 0,
      rangeStartSec: renderStartSec,
      rangeDurationSec: visibleDuration,
      mixxxData: null,
      rawData: null,
      maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid: Number(options.previewBpm.value) > 0,
      allowScrollReuse: false,
      waveformLayout: resolveWaveformLayout()
    })
  }

  const flushRawStreamDirtyDraw = () => {
    if (streamDrawTimer) {
      clearTimeout(streamDrawTimer)
      streamDrawTimer = null
    }
    streamDrawRaf = 0
    const dirtyStartSec = pendingRawStreamDirtyStartSec
    const dirtyEndSec = pendingRawStreamDirtyEndSec
    clearRawStreamDirtyRange()
    nextAllowedStreamDrawAt = performance.now() + RAW_STREAM_REDRAW_INTERVAL_MS

    if (
      dirtyStartSec === null ||
      dirtyEndSec === null ||
      !options.rawStreamActive.value ||
      options.playing.value ||
      options.dragging.value ||
      !options.rawData.value ||
      !options.mixxxData.value ||
      !waveformCanvasRef.value ||
      !wrapRef.value
    ) {
      scheduleDraw()
      return
    }

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      scheduleDraw()
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
    traceHorizontalWaveformRender('stream-dirty')
    const finishTiming = startHorizontalBrowseUserTiming(
      `frkb:hb:canvas:stream-dirty:${options.direction()}`
    )

    streamWaveformRenderer.drawDirtyRange(
      {
        canvas: waveformCanvasRef.value,
        wrap: wrapRef.value,
        bpm: 0,
        firstBeatMs: 0,
        barBeatOffset: 0,
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        mixxxData: options.mixxxData.value,
        rawData: options.rawData.value,
        maxSamplesPerPixel: DRAG_RAW_MAX_SAMPLES_PER_PIXEL,
        showDetailHighlights: false,
        showCenterLine: false,
        showBackground: false,
        showBeatGrid: false,
        allowScrollReuse: true,
        waveformLayout: resolveWaveformLayout(),
        preferRawPeaksOnly: false
      },
      dirtyStartSec,
      dirtyEndSec
    )
    finishTiming()
  }

  const scheduleRawStreamDirtyDraw = (dirtyStartSec: number, dirtyEndSec: number) => {
    if (options.playing.value) {
      scheduleDraw()
      return
    }
    const safeStartSec = Math.max(0, Math.min(dirtyStartSec, dirtyEndSec))
    const safeEndSec = Math.max(safeStartSec, dirtyEndSec)
    pendingRawStreamDirtyStartSec =
      pendingRawStreamDirtyStartSec === null
        ? safeStartSec
        : Math.min(pendingRawStreamDirtyStartSec, safeStartSec)
    pendingRawStreamDirtyEndSec =
      pendingRawStreamDirtyEndSec === null
        ? safeEndSec
        : Math.max(pendingRawStreamDirtyEndSec, safeEndSec)

    if (drawRaf || streamDrawRaf || streamDrawTimer) return
    const now = performance.now()
    const delayMs = Math.max(0, nextAllowedStreamDrawAt - now)
    if (delayMs <= 0) {
      streamDrawRaf = requestAnimationFrame(() => {
        flushRawStreamDirtyDraw()
      })
      return
    }

    streamDrawTimer = setTimeout(() => {
      streamDrawTimer = null
      if (streamDrawRaf) return
      streamDrawRaf = requestAnimationFrame(() => {
        flushRawStreamDirtyDraw()
      })
    }, delayMs)
  }

  const scheduleDraw = () => {
    clearStreamDrawScheduling()
    pendingVisibleTilePaints.clear()
    if (tilePaintRaf) {
      cancelAnimationFrame(tilePaintRaf)
      tilePaintRaf = 0
    }
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      drawWaveform()
    })
  }

  const resetGridRenderer = () => {
    gridRenderer.reset()
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
    clearStreamDrawScheduling()
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
    gridRenderer.dispose()
    if (waveformWorker) {
      waveformWorker.removeEventListener('message', handleWaveformWorkerMessage)
      waveformWorker.terminate()
      waveformWorker = null
    }
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    if (tilePaintRaf) {
      cancelAnimationFrame(tilePaintRaf)
      tilePaintRaf = 0
    }
    streamWaveformRenderer.dispose()
  }

  return {
    wrapRef,
    waveformCanvasRef,
    gridCanvasRef,
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackAlignedStart,
    scheduleRawStreamDirtyDraw,
    clearStreamDrawScheduling,
    clearCanvas,
    invalidateWaveformTiles,
    scheduleDraw,
    resetGridRenderer,
    storeRawWaveform,
    setLastZoomAnchor,
    resetLastZoomAnchor,
    dispose
  }
}
