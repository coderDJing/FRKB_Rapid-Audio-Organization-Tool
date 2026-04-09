<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import HorizontalBrowseCueMarker from '@renderer/components/HorizontalBrowseCueMarker.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/components/horizontalBrowseDetailMath'
import { createBeatAlignPreviewRenderer } from '@renderer/components/mixtapeBeatAlignPreviewRenderer'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
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
  useHorizontalBrowseGridToolbar,
  type HorizontalBrowseGridToolbarState
} from '@renderer/components/useHorizontalBrowseGridToolbar'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BAR_LINE_HIT_RADIUS_PX,
  PREVIEW_BPM_TAP_RESET_MS,
  PREVIEW_GRID_SHIFT_LARGE_MS,
  PREVIEW_GRID_SHIFT_SMALL_MS,
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  PREVIEW_RAW_TARGET_RATE,
  clampNumber,
  formatPreviewBpm,
  normalizeBeatOffset,
  normalizePreviewBpm
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { pickRawDataByFile } from '@renderer/components/mixtapeBeatAlignRawWaveform'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import type {
  HorizontalBrowseDetailWaveformTileRequest,
  HorizontalBrowseDetailWaveformWorkerIncoming,
  HorizontalBrowseDetailWaveformWorkerOutgoing,
  HorizontalBrowseWaveformThemeVariant
} from '@renderer/workers/horizontalBrowseDetailWaveform.types'
import { createHorizontalBrowseDetailWaveformWorker } from '@renderer/workers/horizontalBrowseDetailWaveform.workerClient'

type HorizontalBrowseRawWaveformDetailExpose = {
  toggleBarLinePicking: () => void
  setBarLineAtPlayhead: () => void
  shiftGridSmallLeft: () => void
  shiftGridLargeLeft: () => void
  shiftGridSmallRight: () => void
  shiftGridLargeRight: () => void
  updateBpmInput: (value: string) => void
  blurBpmInput: () => void
  tapBpm: () => void
}

type HorizontalBrowseSharedZoomState = {
  value: number
  anchorRatio: number
  sourceDirection: 'up' | 'down' | null
  revision: number
}

type HorizontalBrowseDragSessionEndPayload = {
  anchorSec: number
  committed: boolean
}

const props = defineProps<{
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoomState?: HorizontalBrowseSharedZoomState
  currentSeconds?: number
  playing?: boolean
  playbackRate?: number
  gridBpm?: number
  cueSeconds?: number
  deferWaveformLoad?: boolean
  rawLoadPriorityHint?: number
}>()

const emit = defineEmits<{
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (
    event: 'zoom-change',
    value: { value: number; anchorRatio: number; sourceDirection: 'up' | 'down' }
  ): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-end', value: HorizontalBrowseDragSessionEndPayload): void
}>()

const runtime = useRuntimeStore()
const wrapRef = ref<HTMLDivElement | null>(null)
const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
const rawData = ref<RawWaveformData | null>(null)
const mixxxData = ref<MixxxWaveformData | null>(null)
const previewLoading = ref(false)
const previewStartSec = ref(0)
const dragging = ref(false)
const previewBarBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewBpm = ref(0)
const previewBpmInput = ref('')
const bpmTapTimestamps = ref<number[]>([])
const previewZoom = ref(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
const gridRenderer = createBeatAlignPreviewRenderer()
const streamWaveformRenderer = createBeatAlignPreviewRenderer()

const WAVEFORM_TILE_WIDTH = 256
const WAVEFORM_TILE_OVERSCAN = 1
const WAVEFORM_TILE_CACHE_LIMIT = 72
const WAVEFORM_PREWARM_STEP_COUNT = 2
const HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE = Math.min(PREVIEW_RAW_TARGET_RATE, 2400)
const DRAG_RAW_MAX_SAMPLES_PER_PIXEL = 32
const RAW_STREAM_REDRAW_INTERVAL_MS = 80
let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let drawRaf = 0
let dragStartClientX = 0
let dragStartSec = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
let waveformWorker: Worker | null = null
let waveformTileCacheTick = 0
let lastWaveformBatchSignature = ''
let lastZoomAnchorSec = 0
let lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
let rawStreamRequestId = ''
const rawStreamActive = ref(false)
let rawStreamStartedAt = 0
let rawStreamChunkCount = 0
let streamDrawTimer: ReturnType<typeof setTimeout> | null = null
let streamDrawRaf = 0
let nextAllowedStreamDrawAt = 0
let pendingRawStreamDirtyStartSec: number | null = null
let pendingRawStreamDirtyEndSec: number | null = null
let tilePaintRaf = 0

const waveformTilePending = new Set<string>()
const waveformTileCache = new Map<
  string,
  {
    bitmap: ImageBitmap
    width: number
    height: number
    pixelRatio: number
    used: number
  }
>()
const pendingVisibleTilePaints = new Map<
  string,
  {
    cacheKey: string
    rangeStartSec: number
    rangeDurationSec: number
  }
>()
const resolvePreviewDurationSec = () => {
  const duration = Number(
    rawData.value?.duration ||
      mixxxData.value?.duration ||
      parseHorizontalBrowseDurationToSeconds(props.song?.duration) ||
      0
  )
  return Number.isFinite(duration) && duration > 0 ? duration : 0
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

const toFloat32Array = (value: unknown) => {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

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

const ensureRawWaveformCapacity = (
  requiredFrames: number,
  meta: { duration: number; sampleRate: number; rate: number }
) => {
  const nextFrames = Math.max(0, Math.floor(requiredFrames))
  if (!nextFrames) return
  const current = rawData.value
  if (!current) {
    rawData.value = {
      duration: meta.duration,
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: nextFrames,
      minLeft: new Float32Array(nextFrames),
      maxLeft: new Float32Array(nextFrames),
      minRight: new Float32Array(nextFrames),
      maxRight: new Float32Array(nextFrames)
    }
    mixxxData.value = createRawPlaceholderMixxxData(rawData.value)
    return
  }
  if (
    current.frames >= nextFrames &&
    current.sampleRate === meta.sampleRate &&
    current.rate === meta.rate &&
    Math.abs(current.duration - meta.duration) <= 0.0001
  ) {
    return
  }
  const grownFrames = Math.max(nextFrames, current.frames)
  const grow = (source: Float32Array) => {
    const target = new Float32Array(grownFrames)
    target.set(source.subarray(0, Math.min(source.length, grownFrames)))
    return target
  }
  rawData.value = {
    duration: Math.max(current.duration, meta.duration),
    sampleRate: meta.sampleRate,
    rate: meta.rate,
    frames: grownFrames,
    minLeft: grow(current.minLeft),
    maxLeft: grow(current.maxLeft),
    minRight: grow(current.minRight),
    maxRight: grow(current.maxRight)
  }
  mixxxData.value = createRawPlaceholderMixxxData(rawData.value)
}

const normalizeRawWaveformData = (value: any): RawWaveformData | null => {
  if (!value) return null
  const frames = Math.max(0, Number(value.frames) || 0)
  const duration = Math.max(0, Number(value.duration) || 0)
  const sampleRate = Math.max(0, Number(value.sampleRate) || 0)
  const rate = Math.max(0, Number(value.rate) || 0)
  const minLeft = toFloat32Array(value.minLeft)
  const maxLeft = toFloat32Array(value.maxLeft)
  const minRight = toFloat32Array(value.minRight)
  const maxRight = toFloat32Array(value.maxRight)
  if (!frames || !duration || !sampleRate || !rate) return null
  return {
    duration,
    sampleRate,
    rate,
    frames,
    minLeft: new Float32Array(minLeft),
    maxLeft: new Float32Array(maxLeft),
    minRight: new Float32Array(minRight),
    maxRight: new Float32Array(maxRight)
  }
}

const cancelRawWaveformStream = () => {
  if (!rawStreamRequestId) return
  window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', {
    requestId: rawStreamRequestId
  })
  rawStreamRequestId = ''
  rawStreamActive.value = false
  clearStreamDrawScheduling()
}

const resolveRawLoadPriorityHint = () =>
  Math.max(0, Math.floor(Number(props.rawLoadPriorityHint) || 0))

const beginRawWaveformStream = (filePath: string, targetRate: number) => {
  cancelRawWaveformStream()
  rawStreamRequestId = `horizontal-raw-${props.direction}-${Date.now()}-${loadToken}`
  rawStreamActive.value = true
  rawStreamStartedAt = performance.now()
  rawStreamChunkCount = 0
  window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
    requestId: rawStreamRequestId,
    filePath,
    priorityHint: resolveRawLoadPriorityHint(),
    targetRate,
    chunkFrames: 32768,
    expectedDurationSec: parseHorizontalBrowseDurationToSeconds(props.song?.duration)
  })
}

const resolvePreviewTimeScale = () => Math.max(0.25, Number(props.playbackRate) || 1)

const resolveVisibleDurationSec = () =>
  Math.max(
    0.001,
    (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
      Number(previewZoom.value || HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
  )

const resolveDisplayGridBpm = () =>
  Number.isFinite(Number(props.gridBpm)) && Number(props.gridBpm) > 0
    ? normalizePreviewBpm(Number(props.gridBpm))
    : Number.isFinite(Number(props.song?.bpm)) && Number(props.song?.bpm) > 0
      ? normalizePreviewBpm(Number(props.song?.bpm))
      : 0

const resolvePreviewAnchorSec = () => {
  const duration = resolvePreviewDurationSec()
  const visibleDuration = resolveVisibleDurationSec()
  if (!duration || !visibleDuration) return 0
  return clampNumber(
    previewStartSec.value + visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
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
  const clampedStart = clampPreviewStart(previewStartSec.value)
  if (!wrap || visibleDuration <= 0) return clampedStart
  const cssWidth = Math.max(1, Math.floor(wrap.clientWidth))
  const pixelRatio = window.devicePixelRatio || 1
  const scaledWidth = Math.max(1, Math.round(cssWidth * pixelRatio))
  const secPerPixel = visibleDuration / scaledWidth
  if (!Number.isFinite(secPerPixel) || secPerPixel <= 0) return clampedStart
  return clampPreviewStart(Math.round(clampedStart / secPerPixel) * secPerPixel)
}

const normalizeSharedZoom = (value: unknown) => {
  const numeric =
    typeof value === 'object' && value !== null && 'value' in value
      ? Number((value as { value?: unknown }).value)
      : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
  return clampNumber(numeric, HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM, HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM)
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

const flushVisibleTilePaints = () => {
  tilePaintRaf = 0
  if (!pendingVisibleTilePaints.size) return
  const filePath = String(props.song?.filePath || '').trim()
  const duration = resolvePreviewDurationSec()
  const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
  if (!filePath || !duration || visibleDuration <= 0) {
    pendingVisibleTilePaints.clear()
    return
  }
  previewStartSec.value = clampPreviewStart(previewStartSec.value)
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

const scheduleVisibleTilePaint = (payload: {
  cacheKey: string
  rangeStartSec: number
  rangeDurationSec: number
}) => {
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

  const currentFilePath = normalizeHorizontalBrowsePathKey(props.song?.filePath)
  if (
    payload.requestToken !== loadToken ||
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

const drawSingleWaveformTile = (
  entry: {
    bitmap: ImageBitmap
    width: number
    height: number
    pixelRatio: number
    used: number
  },
  tileRangeStartSec: number,
  tileRangeDurationSec: number,
  viewStartSec: number,
  visibleDuration: number
) => {
  const waveformState = resolveWaveformCanvasMetrics()
  if (!waveformState) return false
  const { ctx, metrics } = waveformState
  const tileStartSec = tileRangeStartSec
  const tileEndSec = tileStartSec + tileRangeDurationSec
  const viewEndSec = viewStartSec + visibleDuration
  const overlapStartSec = Math.max(viewStartSec, tileStartSec)
  const overlapEndSec = Math.min(viewEndSec, tileEndSec)
  if (overlapEndSec <= overlapStartSec) return false

  waveformTileCacheTick += 1
  entry.used = waveformTileCacheTick
  const srcScaleX = entry.width > 0 ? entry.bitmap.width / entry.width : entry.pixelRatio || 1
  const srcLeftPx = Math.round(
    ((overlapStartSec - tileStartSec) / tileRangeDurationSec) * entry.width * srcScaleX
  )
  const srcRightPx = Math.round(
    ((overlapEndSec - tileStartSec) / tileRangeDurationSec) * entry.width * srcScaleX
  )
  const destLeftPx = Math.round(
    ((overlapStartSec - viewStartSec) / visibleDuration) * metrics.scaledWidth
  )
  const destRightPx = Math.round(
    ((overlapEndSec - viewStartSec) / visibleDuration) * metrics.scaledWidth
  )
  const srcWidth = srcRightPx - srcLeftPx
  const destWidth = destRightPx - destLeftPx
  if (srcWidth <= 0 || destWidth <= 0) return false
  ctx.drawImage(
    entry.bitmap,
    srcLeftPx,
    0,
    srcWidth,
    entry.bitmap.height,
    destLeftPx,
    0,
    destWidth,
    metrics.scaledHeight
  )
  return true
}

const resolveWaveformLayout = () =>
  props.direction === 'up' ? ('top-half' as const) : ('bottom-half' as const)

const resolvePlaybackAlignedStart = (seconds: number) =>
  resolveHorizontalBrowsePlaybackAlignedStart(
    seconds,
    resolvePreviewDurationSec(),
    resolveVisibleDurationSec()
  )

const buildWaveformTileRequests = (options: {
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
  const safeCssWidth = Math.max(1, Math.floor(options.cssWidth))
  const safeCssHeight = Math.max(1, Math.floor(options.cssHeight))
  const tileWidth = Math.max(1, Math.min(WAVEFORM_TILE_WIDTH, safeCssWidth))
  const tileDurationSec = (Math.max(0.0001, options.rangeDurationSec) * tileWidth) / safeCssWidth
  if (!Number.isFinite(tileDurationSec) || tileDurationSec <= 0) return []
  const rangeEndSec = options.rangeStartSec + options.rangeDurationSec
  const firstIndex = Math.max(
    0,
    Math.floor(options.rangeStartSec / tileDurationSec) - Math.max(0, options.overscanTiles)
  )
  const lastIndex =
    Math.max(firstIndex, Math.floor(Math.max(0, rangeEndSec - Number.EPSILON) / tileDurationSec)) +
    Math.max(0, options.overscanTiles)
  const requests: HorizontalBrowseDetailWaveformTileRequest[] = []
  for (let tileIndex = firstIndex; tileIndex <= lastIndex; tileIndex += 1) {
    requests.push({
      requestToken: loadToken,
      filePath: options.filePath,
      cacheKey: buildHorizontalBrowseWaveformTileCacheKey({
        filePath: options.filePath,
        waveformLayout: resolveWaveformLayout(),
        themeVariant: options.themeVariant,
        zoom: options.zoom,
        timeScale: resolvePreviewTimeScale(),
        cssWidth: safeCssWidth,
        cssHeight: safeCssHeight,
        pixelRatio: options.pixelRatio,
        tileIndex
      }),
      width: tileWidth,
      height: safeCssHeight,
      pixelRatio: options.pixelRatio,
      rangeStartSec: tileIndex * tileDurationSec,
      rangeDurationSec: tileDurationSec,
      maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
      themeVariant: options.themeVariant,
      waveformLayout: resolveWaveformLayout()
    })
  }
  return requests
}

const buildWaveformRenderPlan = (options: {
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
    filePath: options.filePath,
    zoom: previewZoom.value,
    cssWidth: options.cssWidth,
    cssHeight: options.cssHeight,
    pixelRatio: options.pixelRatio,
    rangeStartSec: options.rangeStartSec,
    rangeDurationSec: visibleDuration,
    themeVariant: options.themeVariant,
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
        previewZoom.value * factor,
        HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
        HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
      ),
      clampNumber(
        previewZoom.value / factor,
        HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
        HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
      )
    ]) {
      if (Math.abs(nextZoom - previewZoom.value) <= 0.000001) continue
      const nextVisibleDuration = Math.max(
        0.001,
        (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) / nextZoom
      )
      const nextStartSec = clampHorizontalBrowsePreviewStartByVisibleDuration(
        anchorSec - nextVisibleDuration * anchorRatio,
        duration,
        nextVisibleDuration
      )
      prewarmRequests.push(
        ...buildWaveformTileRequests({
          filePath: options.filePath,
          zoom: nextZoom,
          cssWidth: options.cssWidth,
          cssHeight: options.cssHeight,
          pixelRatio: options.pixelRatio,
          rangeStartSec: nextStartSec,
          rangeDurationSec: nextVisibleDuration,
          themeVariant: options.themeVariant,
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
  if (!ctx || !rawData.value || !mixxxData.value) {
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

  const filePath = String(props.song?.filePath || '').trim()
  const themeVariant = resolveHorizontalBrowseWaveformThemeVariant()
  const { visibleRequests, prewarmRequests } = buildWaveformRenderPlan({
    filePath,
    cssWidth: metrics.cssWidth,
    cssHeight: metrics.cssHeight,
    pixelRatio: metrics.pixelRatio,
    rangeStartSec: viewStartSec,
    themeVariant
  })

  const viewEndSec = viewStartSec + visibleDuration
  let drewAnyTile = false
  for (const request of visibleRequests) {
    const entry = waveformTileCache.get(request.cacheKey)
    if (!entry) continue
    const tileStartSec = request.rangeStartSec
    const tileEndSec = tileStartSec + request.rangeDurationSec
    const overlapStartSec = Math.max(viewStartSec, tileStartSec)
    const overlapEndSec = Math.min(viewEndSec, tileEndSec)
    if (overlapEndSec <= overlapStartSec) continue

    waveformTileCacheTick += 1
    entry.used = waveformTileCacheTick
    const srcScaleX = entry.width > 0 ? entry.bitmap.width / entry.width : entry.pixelRatio || 1
    const srcLeftPx = Math.round(
      ((overlapStartSec - tileStartSec) / request.rangeDurationSec) * entry.width * srcScaleX
    )
    const srcRightPx = Math.round(
      ((overlapEndSec - tileStartSec) / request.rangeDurationSec) * entry.width * srcScaleX
    )
    const destLeftPx = Math.round(
      ((overlapStartSec - viewStartSec) / visibleDuration) * metrics.scaledWidth
    )
    const destRightPx = Math.round(
      ((overlapEndSec - viewStartSec) / visibleDuration) * metrics.scaledWidth
    )
    const srcWidth = srcRightPx - srcLeftPx
    const destWidth = destRightPx - destLeftPx
    if (srcWidth <= 0 || destWidth <= 0) continue
    drewAnyTile = true
    ctx.drawImage(
      entry.bitmap,
      srcLeftPx,
      0,
      srcWidth,
      entry.bitmap.height,
      destLeftPx,
      0,
      destWidth,
      metrics.scaledHeight
    )
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
    gridRenderer.reset()
    clearCanvas()
    return
  }
  const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
  previewStartSec.value = clampPreviewStart(previewStartSec.value)
  const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
  let waveformUpdated = false

  if (!rawData.value || !mixxxData.value) {
    clearWaveformCanvas()
  } else if (rawStreamActive.value || dragging.value) {
    streamWaveformRenderer.draw({
      canvas: waveformCanvas,
      wrap,
      bpm: 0,
      firstBeatMs: 0,
      barBeatOffset: 0,
      rangeStartSec: renderStartSec,
      rangeDurationSec: visibleDuration,
      mixxxData: mixxxData.value,
      rawData: rawData.value,
      maxSamplesPerPixel: DRAG_RAW_MAX_SAMPLES_PER_PIXEL,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid: false,
      allowScrollReuse: true,
      waveformLayout: resolveWaveformLayout(),
      preferRawPeaksOnly: false
    })
    waveformUpdated = true
  } else {
    const drewTiles = drawWaveformTiles(renderStartSec, visibleDuration)
    if (!drewTiles) {
      if (dragging.value) {
        waveformUpdated = false
      } else {
        streamWaveformRenderer.draw({
          canvas: waveformCanvas,
          wrap,
          bpm: 0,
          firstBeatMs: 0,
          barBeatOffset: 0,
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          mixxxData: mixxxData.value,
          rawData: rawData.value,
          maxSamplesPerPixel: DRAG_RAW_MAX_SAMPLES_PER_PIXEL,
          showDetailHighlights: false,
          showCenterLine: false,
          showBackground: false,
          showBeatGrid: false,
          allowScrollReuse: true,
          waveformLayout: resolveWaveformLayout(),
          preferRawPeaksOnly: false
        })
        waveformUpdated = true
      }
    } else {
      waveformUpdated = true
    }
  }

  gridRenderer.draw({
    canvas: gridCanvas,
    wrap,
    bpm: Number(previewBpm.value) || 0,
    firstBeatMs: Number(previewFirstBeatMs.value) || 0,
    barBeatOffset: Number(previewBarBeatOffset.value) || 0,
    rangeStartSec: renderStartSec,
    rangeDurationSec: visibleDuration,
    mixxxData: null,
    rawData: null,
    maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
    showDetailHighlights: false,
    showCenterLine: false,
    showBackground: false,
    showBeatGrid: Number(previewBpm.value) > 0,
    allowScrollReuse: false,
    waveformLayout: resolveWaveformLayout()
  })
}

const clearPersistTimer = () => {
  if (!persistTimer) return
  clearTimeout(persistTimer)
  persistTimer = null
}
const clearBpmTapResetTimer = () => {
  if (!bpmTapResetTimer) return
  clearTimeout(bpmTapResetTimer)
  bpmTapResetTimer = null
}

const resetPreviewBpmTap = () => {
  clearBpmTapResetTimer()
  bpmTapTimestamps.value = []
}

const schedulePreviewBpmTapReset = () => {
  clearBpmTapResetTimer()
  bpmTapResetTimer = setTimeout(() => {
    bpmTapResetTimer = null
    bpmTapTimestamps.value = []
  }, PREVIEW_BPM_TAP_RESET_MS)
}

const persistGridDefinition = async () => {
  clearPersistTimer()
  const filePath = String(props.song?.filePath || '').trim()
  if (!filePath) return
  try {
    await window.electron.ipcRenderer.invoke('mixtape:update-grid-definition', {
      filePath,
      bpm: Number(previewBpm.value) || 0,
      firstBeatMs: Math.max(0, Number(previewFirstBeatMs.value) || 0),
      barBeatOffset: normalizeBeatOffset(previewBarBeatOffset.value, PREVIEW_BAR_BEAT_INTERVAL)
    })
  } catch {}
}

const schedulePersistGridDefinition = () => {
  clearPersistTimer()
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistGridDefinition()
  }, 120)
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
    !rawStreamActive.value ||
    dragging.value ||
    !rawData.value ||
    !mixxxData.value ||
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
  previewStartSec.value = clampPreviewStart(previewStartSec.value)
  const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
  streamWaveformRenderer.drawDirtyRange(
    {
      canvas: waveformCanvasRef.value,
      wrap: wrapRef.value,
      bpm: 0,
      firstBeatMs: 0,
      barBeatOffset: 0,
      rangeStartSec: renderStartSec,
      rangeDurationSec: visibleDuration,
      mixxxData: mixxxData.value,
      rawData: rawData.value,
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
}

const scheduleRawStreamDirtyDraw = (dirtyStartSec: number, dirtyEndSec: number) => {
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

const stopDragging = (commitPlayhead = false) => {
  if (!dragging.value) return
  const finalAnchorSec = resolvePreviewAnchorSec()
  dragging.value = false
  window.removeEventListener('mousemove', handleDragMove)
  window.removeEventListener('mouseup', handleWindowMouseUp)
  emit('drag-session-end', {
    anchorSec: finalAnchorSec,
    committed: commitPlayhead && Boolean(props.song)
  })
}

const handleWindowMouseUp = () => stopDragging(true)

function handleDragMove(event: MouseEvent) {
  if (!dragging.value) return
  const wrap = wrapRef.value
  if (!wrap) return
  const visibleDuration = resolveVisibleDurationSec()
  if (!visibleDuration) return
  const deltaX = event.clientX - dragStartClientX
  const deltaSec = (deltaX / Math.max(1, wrap.clientWidth)) * visibleDuration
  previewStartSec.value = clampPreviewStart(dragStartSec - deltaSec)
  lastZoomAnchorSec = resolvePreviewAnchorSec()
  lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  scheduleDraw()
}

const handleMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) return
  if (!rawData.value || !mixxxData.value) return
  if (handlePreviewMouseDownForBarLinePicking(event)) {
    emitToolbarState()
    schedulePersistGridDefinition()
    return
  }
  dragging.value = true
  dragStartClientX = event.clientX
  dragStartSec = previewStartSec.value
  emit('drag-session-start')
  window.addEventListener('mousemove', handleDragMove, { passive: false })
  window.addEventListener('mouseup', handleWindowMouseUp, { passive: true })
  event.preventDefault()
}

const handleWheel = (event: WheelEvent) => {
  const wrap = wrapRef.value
  const duration = resolvePreviewDurationSec()
  if (!wrap || !duration) return

  event.preventDefault()
  const rect = wrap.getBoundingClientRect()
  const ratio = rect.width > 0 ? clampNumber((event.clientX - rect.left) / rect.width, 0, 1) : 0.5
  const beforeVisible = resolveVisibleDurationSec()
  const anchorSec = previewStartSec.value + beforeVisible * ratio
  const factor =
    event.deltaY < 0
      ? HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
      : 1 / HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
  const nextZoom = clampNumber(
    previewZoom.value * factor,
    HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
    HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
  )
  if (Math.abs(nextZoom - previewZoom.value) <= 0.000001) return
  lastZoomAnchorSec = anchorSec
  lastZoomAnchorRatio = ratio
  previewZoom.value = nextZoom
  const nextVisible = resolveVisibleDurationSec()
  previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * ratio)
  emit('zoom-change', {
    value: previewZoom.value,
    anchorRatio: ratio,
    sourceDirection: props.direction
  })
  scheduleDraw()
}

const canAdjustGrid = computed(() => !previewLoading.value && !!mixxxData.value)

const previewFirstBeatMsComputed = computed(() => Number(previewFirstBeatMs.value) || 0)
const previewPlaying = ref(false)

const {
  previewBarLinePicking,
  previewBarLineHoverVisible,
  previewBarLineGlowStyle,
  handleBarLinePickingToggle,
  handlePreviewMouseMoveForBarLinePicking,
  handlePreviewMouseLeaveForBarLinePicking,
  handlePreviewMouseDownForBarLinePicking,
  handleSetBarLineAtPlayhead,
  handleGridShift,
  resetBarLinePicking
} = useMixtapeBeatAlignGridAdjust({
  previewWrapRef: wrapRef,
  previewLoading,
  previewMixxxData: mixxxData,
  previewPlaying,
  previewBarBeatOffset,
  previewFirstBeatMs,
  previewStartSec,
  bpm: previewBpm,
  firstBeatMs: previewFirstBeatMsComputed,
  resolvePreviewAnchorSec,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  clampPreviewStart,
  getPreviewPlaybackSec: resolvePreviewAnchorSec,
  schedulePreviewDraw: scheduleDraw,
  barBeatInterval: PREVIEW_BAR_BEAT_INTERVAL,
  barLineHitRadiusPx: PREVIEW_BAR_LINE_HIT_RADIUS_PX
})

const {
  emitToolbarState,
  syncGridStateFromSong,
  handlePreviewBpmInputUpdate,
  handlePreviewBpmInputBlur,
  handlePreviewBpmTap,
  toggleBarLinePicking,
  setBarLineAtPlayhead,
  shiftGrid
} = useHorizontalBrowseGridToolbar({
  canAdjustGrid,
  previewLoading,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewBarBeatOffset,
  bpmTapTimestamps,
  previewBarLinePicking,
  emitToolbarStateChange: (value) => emit('toolbar-state-change', value),
  resolveDisplayGridBpm,
  resolveSongFirstBeatMs: () => Number(props.song?.firstBeatMs) || 0,
  resolveSongBarBeatOffset: () => Number(props.song?.barBeatOffset) || 0,
  scheduleDraw,
  schedulePreviewBpmTapReset,
  persistGridDefinition,
  schedulePersistGridDefinition,
  resetPreviewBpmTap,
  resetBarLinePicking,
  handleBarLinePickingToggle,
  handleSetBarLineAtPlayhead,
  handleGridShift
})

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  clearPersistTimer()
  clearStreamDrawScheduling()
  cancelRawWaveformStream()
  clearWaveformWorkerQueue()
  clearWaveformTileCache()
  previewLoading.value = false
  rawStreamActive.value = false
  rawData.value = null
  mixxxData.value = null
  previewStartSec.value = 0
  gridRenderer.reset()
  clearCanvas()
  lastZoomAnchorSec = 0
  lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSong()
    return
  }

  try {
    previewLoading.value = true
    const targetRate = props.deferWaveformLoad
      ? HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE
      : PREVIEW_RAW_TARGET_RATE
    const response = await window.electron.ipcRenderer.invoke('mixtape-waveform-raw:batch', {
      filePaths: [filePath],
      targetRate,
      preferSharedDecode: false,
      cacheOnly: true
    })

    if (currentToken !== loadToken) return
    const picked = pickRawDataByFile(
      response,
      normalizeHorizontalBrowsePathKey(filePath),
      normalizeHorizontalBrowsePathKey
    )
    rawData.value = picked
    mixxxData.value = picked ? createRawPlaceholderMixxxData(picked) : null
    if (picked) {
      const worker = ensureWaveformWorker()
      const message: HorizontalBrowseDetailWaveformWorkerIncoming = {
        type: 'storeRaw',
        payload: {
          filePath,
          data: cloneRawWaveformData(picked)
        }
      }
      worker.postMessage(message)
      rawStreamActive.value = false
    } else {
      beginRawWaveformStream(filePath, targetRate)
    }
    previewLoading.value = false
    syncGridStateFromSong()
    previewStartSec.value = resolvePlaybackAlignedStart(0)
    scheduleDraw()
  } catch {
    if (currentToken !== loadToken) return
    previewLoading.value = false
    rawStreamActive.value = false
    rawData.value = null
    mixxxData.value = null
    gridRenderer.reset()
    clearCanvas()
    syncGridStateFromSong()
  }
}

watch(
  () => props.song?.filePath ?? '',
  () => {
    void loadWaveform()
  },
  { immediate: true }
)

watch(
  () =>
    [props.song?.bpm, props.song?.firstBeatMs, props.song?.barBeatOffset, props.gridBpm] as const,
  () => {
    syncGridStateFromSong()
    gridRenderer.reset()
    scheduleDraw()
  }
)

watch(
  () => props.direction,
  () => {
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
    gridRenderer.reset()
    scheduleDraw()
  }
)

watch(
  () => resolvePreviewTimeScale(),
  () => {
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
    gridRenderer.reset()
    scheduleDraw()
  }
)

watch(
  () => !!props.deferWaveformLoad,
  (deferred, previous) => {
    if (!previous || deferred) return
    if (!props.song?.filePath) return
    const currentRate = Number(rawData.value?.rate) || 0
    if (rawData.value && currentRate >= PREVIEW_RAW_TARGET_RATE) return
    void loadWaveform()
  }
)

watch(
  () => resolveRawLoadPriorityHint(),
  (priorityHint, previousPriorityHint) => {
    if (!rawStreamRequestId) return
    if (priorityHint === previousPriorityHint) return
    window.electron.ipcRenderer.send('mixtape-waveform-raw:update-priority', {
      requestId: rawStreamRequestId,
      priorityHint
    })
  }
)

watch(
  () => props.sharedZoomState,
  (state) => {
    const nextZoom = normalizeSharedZoom(state)
    if (
      state?.sourceDirection === props.direction &&
      Math.abs(nextZoom - previewZoom.value) <= 0.000001
    ) {
      return
    }
    const anchorRatio = clampNumber(
      Number(state?.anchorRatio ?? HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO),
      0,
      1
    )
    const anchorSec = previewStartSec.value + resolveVisibleDurationSec() * anchorRatio
    lastZoomAnchorSec = anchorSec
    lastZoomAnchorRatio = anchorRatio
    previewZoom.value = nextZoom
    const nextVisible = resolveVisibleDurationSec()
    previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * anchorRatio)
    gridRenderer.reset()
    scheduleDraw()
  },
  { immediate: true }
)

watch(
  () => !!props.playing,
  (playing) => {
    previewPlaying.value = playing
  },
  { immediate: true }
)

watch(
  () => [Number(props.currentSeconds) || 0, !!props.playing, props.song?.filePath ?? ''] as const,
  ([seconds, playing, songKey]) => {
    if (dragging.value) return
    const safeSongKey = String(songKey || '').trim()
    const safeSeconds = Math.max(0, seconds)
    if (!safeSongKey) {
      previewStartSec.value = resolvePlaybackAlignedStart(0)
      scheduleDraw()
      return
    }
    if (!playing) {
      previewStartSec.value = resolvePlaybackAlignedStart(safeSeconds)
      lastZoomAnchorSec = safeSeconds
      lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
      scheduleDraw()
      return
    }
    previewStartSec.value = resolvePlaybackAlignedStart(safeSeconds)
    lastZoomAnchorSec = safeSeconds
    lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    scheduleDraw()
  }
)

watch(
  () => [previewBpm.value, previewFirstBeatMs.value, previewBarBeatOffset.value] as const,
  () => {
    gridRenderer.reset()
    scheduleDraw()
    emitToolbarState()
  }
)

watch(
  () => runtime.setting?.themeMode,
  () => {
    clearWaveformWorkerQueue()
    clearWaveformTileCache()
    gridRenderer.reset()
    scheduleDraw()
  }
)

const handleRawWaveformStreamChunk = (
  _event: unknown,
  payload?: {
    requestId?: string
    filePath?: string
    startFrame?: number
    frames?: number
    totalFrames?: number
    duration?: number
    sampleRate?: number
    rate?: number
    minLeft?: unknown
    maxLeft?: unknown
    minRight?: unknown
    maxRight?: unknown
  }
) => {
  if (String(payload?.requestId || '') !== rawStreamRequestId) return
  if (
    normalizeHorizontalBrowsePathKey(payload?.filePath) !==
    normalizeHorizontalBrowsePathKey(props.song?.filePath)
  ) {
    return
  }
  const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
  const duration = Math.max(0, Number(payload?.duration) || 0)
  const sampleRate = Math.max(0, Number(payload?.sampleRate) || 0)
  const rate = Math.max(0, Number(payload?.rate) || 0)
  const startFrame = Math.max(0, Number(payload?.startFrame) || 0)
  const frames = Math.max(0, Number(payload?.frames) || 0)
  if (!totalFrames || !duration || !sampleRate || !rate || !frames) return
  rawStreamChunkCount += 1

  ensureRawWaveformCapacity(Math.max(totalFrames, startFrame + frames), {
    duration,
    sampleRate,
    rate
  })
  const target = rawData.value
  if (!target) return
  const minLeftChunk = toFloat32Array(payload?.minLeft)
  const maxLeftChunk = toFloat32Array(payload?.maxLeft)
  const minRightChunk = toFloat32Array(payload?.minRight)
  const maxRightChunk = toFloat32Array(payload?.maxRight)
  if (startFrame + minLeftChunk.length > target.minLeft.length) return
  target.minLeft.set(minLeftChunk, startFrame)
  target.maxLeft.set(maxLeftChunk, startFrame)
  target.minRight.set(minRightChunk, startFrame)
  target.maxRight.set(maxRightChunk, startFrame)
  if (rawStreamChunkCount === 1) {
    console.info('[horizontal-raw-stream] first chunk', {
      filePath: props.song?.filePath,
      elapsedMs: Number((performance.now() - rawStreamStartedAt).toFixed(1)),
      totalFrames,
      frames
    })
  }
  const dirtyStartSec = startFrame / rate
  const dirtyEndSec = (startFrame + frames) / rate
  scheduleRawStreamDirtyDraw(dirtyStartSec, dirtyEndSec)
}

const handleRawWaveformStreamDone = (
  _event: unknown,
  payload?: {
    requestId?: string
    filePath?: string
    data?: unknown
    error?: string
    fromCache?: boolean
    streamed?: boolean
  }
) => {
  if (String(payload?.requestId || '') !== rawStreamRequestId) return
  if (
    normalizeHorizontalBrowsePathKey(payload?.filePath) !==
    normalizeHorizontalBrowsePathKey(props.song?.filePath)
  ) {
    return
  }
  rawStreamRequestId = ''
  previewLoading.value = false
  rawStreamActive.value = false
  console.info('[horizontal-raw-stream] done', {
    filePath: props.song?.filePath,
    elapsedMs: Number((performance.now() - rawStreamStartedAt).toFixed(1)),
    chunkCount: rawStreamChunkCount,
    fromCache: payload?.fromCache === true,
    error: payload?.error
  })

  if (payload?.data) {
    const normalized = normalizeRawWaveformData(payload.data)
    if (normalized) {
      rawData.value = normalized
      mixxxData.value = createRawPlaceholderMixxxData(normalized)
    }
  }

  if (rawData.value) {
    const duration = Math.max(0, Number((payload as any)?.duration) || 0)
    const totalFrames = Math.max(0, Number((payload as any)?.totalFrames) || 0)
    if (duration > 0) {
      rawData.value.duration = duration
    }
    if (totalFrames > 0 && totalFrames <= rawData.value.frames) {
      rawData.value.frames = totalFrames
    }
  }

  if (rawData.value && props.song?.filePath) {
    const worker = ensureWaveformWorker()
    const message: HorizontalBrowseDetailWaveformWorkerIncoming = {
      type: 'storeRaw',
      payload: {
        filePath: String(props.song.filePath || '').trim(),
        data: cloneRawWaveformData(rawData.value)
      }
    }
    worker.postMessage(message)
  }

  scheduleDraw()
}

onMounted(() => {
  if (wrapRef.value) {
    resizeObserver = new ResizeObserver(() => {
      clearWaveformWorkerQueue()
      clearWaveformTileCache()
      gridRenderer.reset()
      scheduleDraw()
    })
    resizeObserver.observe(wrapRef.value)
  }
  window.electron.ipcRenderer.on('mixtape-waveform-raw:stream-chunk', handleRawWaveformStreamChunk)
  window.electron.ipcRenderer.on('mixtape-waveform-raw:stream-done', handleRawWaveformStreamDone)
  emitToolbarState()
  scheduleDraw()
})

onUnmounted(() => {
  loadToken += 1
  clearPersistTimer()
  clearBpmTapResetTimer()
  clearStreamDrawScheduling()
  stopDragging()
  cancelRawWaveformStream()
  clearWaveformWorkerQueue()
  clearWaveformTileCache()
  gridRenderer.dispose()
  if (waveformWorker) {
    waveformWorker.removeEventListener('message', handleWaveformWorkerMessage)
    waveformWorker.terminate()
    waveformWorker = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (drawRaf) {
    cancelAnimationFrame(drawRaf)
    drawRaf = 0
  }
  if (tilePaintRaf) {
    cancelAnimationFrame(tilePaintRaf)
    tilePaintRaf = 0
  }
  window.electron.ipcRenderer.removeListener(
    'mixtape-waveform-raw:stream-chunk',
    handleRawWaveformStreamChunk
  )
  window.electron.ipcRenderer.removeListener(
    'mixtape-waveform-raw:stream-done',
    handleRawWaveformStreamDone
  )
  streamWaveformRenderer.dispose()
})

defineExpose<HorizontalBrowseRawWaveformDetailExpose>({
  toggleBarLinePicking,
  setBarLineAtPlayhead,
  shiftGridSmallLeft: () => shiftGrid(-PREVIEW_GRID_SHIFT_SMALL_MS),
  shiftGridLargeLeft: () => shiftGrid(-PREVIEW_GRID_SHIFT_LARGE_MS),
  shiftGridSmallRight: () => shiftGrid(PREVIEW_GRID_SHIFT_SMALL_MS),
  shiftGridLargeRight: () => shiftGrid(PREVIEW_GRID_SHIFT_LARGE_MS),
  updateBpmInput: handlePreviewBpmInputUpdate,
  blurBpmInput: handlePreviewBpmInputBlur,
  tapBpm: handlePreviewBpmTap
})
</script>

<template>
  <div
    ref="wrapRef"
    :class="[
      'raw-detail-waveform',
      `raw-detail-waveform--${props.direction}`,
      { 'is-dragging': dragging, 'is-bar-selecting': previewBarLinePicking }
    ]"
    @mousedown.stop="handleMouseDown"
    @mousemove="handlePreviewMouseMoveForBarLinePicking"
    @mouseleave="handlePreviewMouseLeaveForBarLinePicking"
    @wheel.prevent.stop="handleWheel"
  >
    <canvas ref="waveformCanvasRef" class="raw-detail-waveform__canvas"></canvas>
    <canvas
      ref="gridCanvasRef"
      class="raw-detail-waveform__canvas raw-detail-waveform__canvas--grid"
    ></canvas>
    <div class="raw-detail-waveform__playhead"></div>
    <HorizontalBrowseCueMarker
      v-if="props.song"
      :cue-seconds="props.cueSeconds"
      :preview-start-sec="previewStartSec"
      :visible-duration-sec="resolveVisibleDurationSec()"
      :direction="props.direction"
    />
    <div
      v-if="previewBarLineHoverVisible"
      class="raw-detail-waveform__barline-glow"
      :style="previewBarLineGlowStyle"
    ></div>
  </div>
</template>

<style scoped lang="scss">
.raw-detail-waveform {
  position: relative;
  width: 100%;
  height: 84%;
  min-width: 0;
  min-height: 0;
  cursor: default;
}

.raw-detail-waveform--up {
  margin-top: auto;
}

.raw-detail-waveform--down {
  margin-bottom: auto;
}

.raw-detail-waveform__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.raw-detail-waveform__canvas--grid {
  pointer-events: none;
}

.raw-detail-waveform__playhead {
  position: absolute;
  top: -1px;
  bottom: -1px;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
  pointer-events: none;
  z-index: 2;
}

:global(.theme-light) .raw-detail-waveform__playhead {
  background: rgba(22, 22, 22, 0.92);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2);
}

.raw-detail-waveform.is-bar-selecting {
  cursor: crosshair;
}

.raw-detail-waveform__barline-glow {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: rgba(255, 214, 92, 0.88);
  box-shadow: 0 0 0 1px rgba(255, 214, 92, 0.2);
  pointer-events: none;
}
</style>
