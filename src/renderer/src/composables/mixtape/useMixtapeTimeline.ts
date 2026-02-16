import { computed, markRaw, onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'
import type { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import libraryUtils from '@renderer/utils/libraryUtils'
import {
  BASE_PX_PER_SEC,
  FALLBACK_TRACK_WIDTH,
  GRID_BAR_ONLY_ZOOM,
  GRID_BAR_WIDTH_MAX,
  GRID_BAR_WIDTH_MAX_ZOOM,
  GRID_BAR_WIDTH_MIN,
  LANE_GAP,
  LANE_PADDING_TOP,
  MIXXX_MAX_RGB_ENERGY,
  MIXTAPE_SUMMARY_ZOOM,
  MIXTAPE_WAVEFORM_SUPERSAMPLE,
  MIXTAPE_WAVEFORM_Y_OFFSET,
  MIXTAPE_WIDTH_SCALE,
  MIN_TRACK_WIDTH,
  PRE_RENDER_RANGE_BUFFER,
  RAW_WAVEFORM_BATCH_SIZE,
  RAW_WAVEFORM_MIN_ZOOM,
  RAW_WAVEFORM_TARGET_RATE,
  RENDER_X_BUFFER_PX,
  RENDER_ZOOM_STEP,
  SHOW_GRID_LINES,
  WAVEFORM_BATCH_SIZE,
  WAVEFORM_TILE_WIDTH,
  WHEEL_LINE_HEIGHT_PX,
  WHEEL_MAX_STEPS_PER_FRAME,
  WHEEL_ZOOM_BASE_STEP,
  WHEEL_ZOOM_MAX_STEP,
  WHEEL_ZOOM_RATIO_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP
} from '@renderer/composables/mixtape/constants'
import type {
  MinMaxSample,
  MixtapeTrack,
  RawWaveformData,
  RawWaveformLevel,
  TimelineLayoutSnapshot,
  TimelineRenderPayload,
  WaveformPreRenderTask
} from '@renderer/composables/mixtape/types'
import {
  buildRawWaveformPyramid,
  resolveRawWaveformLevel as resolveRawWaveformLevelByMap
} from '@renderer/composables/mixtape/waveformPyramid'
import { drawMixxxRgbWaveform } from '@renderer/composables/mixtape/waveformDraw'
import { createTimelineRenderAndLoadModule } from '@renderer/composables/mixtape/timelineRenderAndLoad'
import { createTimelineInteractionsModule } from '@renderer/composables/mixtape/timelineInteractions'
import { createTimelineHelpersModule } from '@renderer/composables/mixtape/timelineHelpers'
import { createTimelineTransportAndDragModule } from '@renderer/composables/mixtape/timelineTransportAndDrag'
import { createTimelineWorkerBridgeModule } from '@renderer/composables/mixtape/timelineWorkerBridge'
import { createTimelineWatchAndMountModule } from '@renderer/composables/mixtape/timelineWatchAndMount'

type UseMixtapeTimelineOptions = {
  tracks: Ref<MixtapeTrack[]>
  bpmAnalysisActive: Ref<boolean>
  bpmAnalysisFailed: Ref<boolean>
}

export const useMixtapeTimeline = (options: UseMixtapeTimelineOptions) => {
  const { tracks, bpmAnalysisActive, bpmAnalysisFailed } = options
  const zoom = ref(ZOOM_MIN)
  const renderZoom = ref(ZOOM_MIN)
  const zoomTouched = ref(true)
  const timelineScrollRef = ref<InstanceType<typeof OverlayScrollbarsComponent> | null>(null)
  const timelineScrollWrapRef = ref<HTMLElement | null>(null)
  const timelineCanvasRef = ref<HTMLCanvasElement | null>(null)
  const timelineViewport = ref<HTMLElement | null>(null)
  const timelineWidth = ref(0)
  const timelineContentWidth = ref(0)
  const timelineScrollLeft = ref(0)
  const timelineScrollTop = ref(0)
  const timelineViewportWidth = ref(0)
  const timelineViewportHeight = ref(0)
  const timelineWorkerReady = ref(false)
  const isTimelinePanning = ref(false)
  const overviewRef = ref<HTMLElement | null>(null)
  const overviewWidth = ref(0)
  const isOverviewDragging = ref(false)
  let timelineOffscreenCanvas: OffscreenCanvas | null = null
  let timelineObserver: ResizeObserver | null = null
  let timelineViewportObserver: ResizeObserver | null = null
  let overviewObserver: ResizeObserver | null = null
  let waveformLoadTimer: ReturnType<typeof setTimeout> | null = null
  let timelineCanvasRaf = 0
  let waveformPreRenderToken = 0
  let waveformPreRenderCursor = 0
  let waveformPreRenderRaf = 0
  let waveformPreRenderTimer: ReturnType<typeof setTimeout> | null = null
  let waveformWorkerPreRenderTimer: ReturnType<typeof setTimeout> | null = null
  let waveformPreRenderQueue: WaveformPreRenderTask[] = []
  let waveformRenderWorker: Worker | null = null
  const waveformTilePending = new Set<string>()
  const waveformScratch = {
    canvas: null as HTMLCanvasElement | null,
    ctx: null as CanvasRenderingContext2D | null
  }
  const waveformDataMap = markRaw(new Map<string, MixxxWaveformData | null>())
  const waveformMinMaxCache = markRaw(
    new Map<string, { source: MixxxWaveformData; samples: MinMaxSample[] }>()
  )
  const timelineLayoutCache = markRaw(new Map<number, TimelineLayoutSnapshot>())
  const timelineLayoutVersion = ref(0)
  const rawWaveformDataMap = markRaw(new Map<string, RawWaveformData | null>())
  const rawWaveformPyramidMap = markRaw(new Map<string, RawWaveformLevel[]>())
  const waveformInflight = new Set<string>()
  const waveformQueuedMissing = new Set<string>()
  const rawWaveformInflight = new Set<string>()
  const waveformTileCache = markRaw(new Map<string, { source: CanvasImageSource; used: number }>())
  const waveformTileCacheIndex = markRaw(new Map<string, Set<string>>())
  let waveformTileCacheTick = 0
  let waveformTileCacheLimit = 260
  const waveformVersion = ref(0)
  const preRenderState = ref({ active: false, total: 0, done: 0 })
  const preRenderPhase = ref<'idle' | 'tiles' | 'frames'>('idle')
  const preRenderTotals = ref({ tiles: 0, frames: 0 })
  let pendingFramePreRenderTasks: TimelineRenderPayload[] = []
  const waveformTileCacheTickRef = {
    get value() {
      return waveformTileCacheTick
    },
    set value(value: number) {
      waveformTileCacheTick = value
    }
  }
  const waveformTileCacheLimitRef = {
    get value() {
      return waveformTileCacheLimit
    },
    set value(value: number) {
      waveformTileCacheLimit = value
    }
  }
  const {
    clampZoomValue,
    buildZoomLevels,
    quantizeRenderZoom,
    normalizedZoom,
    normalizedRenderZoom,
    resolveRenderZoomLevel,
    alignZoomToRenderLevel,
    resolveGridBarWidth,
    resolveLaneHeightForZoom,
    resolveTimelineBufferId,
    laneHeight,
    laneIndices,
    resolveTrackTitle,
    formatTrackBpm,
    useHalfWaveform,
    resolveRenderPxPerSec,
    renderPxPerSec,
    useRawWaveform,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    resolveTrackFirstBeatMs,
    resolveTrackRenderWidthPx,
    clearTimelineLayoutCache,
    resolveFirstVisibleLayoutIndex,
    forEachVisibleLayoutItem,
    buildSequentialLayoutForZoom,
    resolveTrackBlockStyle,
    resolveOverviewTrackStyle,
    resolveTrackTilesForWidth,
    drawTrackGridLines,
    resolveWaveformListRoot,
    isWaveformReady,
    isRawWaveformLoading,
    resolveWaveformTitle,
    computeTimelineDuration,
    buildMinMaxDataFromMixxx,
    isValidWaveformData,
    getMinMaxSamples,
    decodeRawFloatArray,
    decodeRawWaveformData,
    resolveRawWaveformLevel,
    buildWaveformTileCacheKey,
    touchWaveformTileCache,
    registerWaveformTileCacheKey,
    disposeWaveformCacheEntry,
    pruneWaveformTileCache
  } = createTimelineHelpersModule({
    zoom,
    renderZoom,
    tracks,
    t,
    libraryUtils,
    waveformDataMap,
    rawWaveformDataMap,
    waveformInflight,
    rawWaveformInflight,
    waveformMinMaxCache,
    rawWaveformPyramidMap,
    timelineLayoutCache,
    timelineLayoutVersion,
    overviewWidth,
    waveformTileCache,
    waveformTileCacheIndex,
    waveformTileCacheTickRef,
    waveformTileCacheLimitRef
  })
  const ZOOM_LEVELS = buildZoomLevels()

  const timelineLayout = computed(() => {
    void timelineLayoutVersion.value
    return buildSequentialLayoutForZoom(normalizedRenderZoom.value)
  })
  const laneTracks = computed(() =>
    laneIndices.map((laneIndex) =>
      timelineLayout.value.layout.filter((item) => item.laneIndex === laneIndex)
    )
  )
  const overviewViewportMetrics = computed(() => {
    const totalWidth = Math.max(1, timelineLayout.value.totalWidth)
    const viewportWidth = Math.max(0, timelineViewportWidth.value)
    const overviewTotalWidth = Math.max(0, overviewWidth.value)
    if (!overviewTotalWidth || !viewportWidth) {
      return { left: 0, width: 0 }
    }
    const widthRatio = overviewTotalWidth / totalWidth
    const rawLeft = Math.round(timelineScrollLeft.value * widthRatio)
    const rawWidth = Math.round(viewportWidth * widthRatio)
    const width = Math.max(12, Math.min(overviewTotalWidth, rawWidth))
    const maxLeft = Math.max(0, overviewTotalWidth - width)
    const left = Math.max(0, Math.min(maxLeft, rawLeft))
    return { left, width }
  })
  const overviewViewportLeft = computed(() => overviewViewportMetrics.value.left)
  const overviewViewportWidth = computed(() => overviewViewportMetrics.value.width)
  const overviewViewportStyle = computed(() => ({
    left: `${overviewViewportMetrics.value.left}px`,
    width: `${overviewViewportMetrics.value.width}px`
  }))
  const timelineScrollbarOptions = {
    scrollbars: {
      autoHide: 'leave' as const,
      autoHideDelay: 50,
      clickScroll: true
    },
    overflow: {
      x: 'scroll',
      y: 'scroll'
    } as const
  }

  const preRenderPercent = computed(() => {
    const total = preRenderState.value.total
    const done = preRenderState.value.done
    if (!total || total <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
  })

  // single-canvas renderer no longer uses per-tile DOM canvases

  const renderWaveformTileToCache = (task: WaveformPreRenderTask) => {
    const { ctx: render, tile, cacheKey } = task
    const width = Math.max(1, Math.floor(tile.width))
    const height = Math.max(1, Math.floor(render.laneHeight))
    const cachedCanvas = document.createElement('canvas')
    const cachedCtx = cachedCanvas.getContext('2d')
    if (!cachedCtx) return
    resizeCanvas(cachedCanvas, cachedCtx, width, height)
    renderWaveformTileContents(cachedCtx, width, height, render, tile)
    const existing = waveformTileCache.get(cacheKey)
    if (existing) {
      disposeWaveformCacheEntry(existing)
    }
    waveformTileCacheTick += 1
    waveformTileCache.set(cacheKey, { source: cachedCanvas, used: waveformTileCacheTick })
    registerWaveformTileCacheKey(render.track.filePath, cacheKey)
    pruneWaveformTileCache()
  }

  const resolvePreRenderZoomLevels = () => {
    const levels = new Set<number>()
    levels.add(resolveRenderZoomLevel(normalizedRenderZoom.value))
    if (MIXTAPE_SUMMARY_ZOOM > 0) {
      levels.add(resolveRenderZoomLevel(MIXTAPE_SUMMARY_ZOOM))
    }
    return Array.from(levels)
  }

  const resolvePreRenderRange = (
    currentZoomValue: number,
    targetZoomValue: number,
    totalWidth: number
  ) => {
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    const width = Math.max(0, Math.floor(viewport?.clientWidth || timelineViewportWidth.value))
    const scrollLeft = Math.max(
      0,
      Math.floor(viewport?.scrollLeft || timelineScrollLeft.value || 0)
    )
    const safeTotal = Math.max(0, Math.floor(totalWidth))
    if (!width || !Number.isFinite(width)) {
      return { start: 0, end: safeTotal }
    }
    const buffer = Math.round(width * PRE_RENDER_RANGE_BUFFER)
    const currentPx = resolveRenderPxPerSec(currentZoomValue)
    const targetPx = resolveRenderPxPerSec(targetZoomValue)
    const scale = currentPx > 0 ? targetPx / currentPx : 1
    const start = Math.max(0, Math.floor((scrollLeft - buffer) * scale))
    const end = Math.max(start, Math.ceil((scrollLeft + width + buffer) * scale))
    return { start, end: Math.min(Math.ceil(safeTotal), end) }
  }

  const buildWaveformPreRenderQueue = (): WaveformPreRenderTask[] => {
    const queue: WaveformPreRenderTask[] = []
    if (!tracks.value.length) return queue
    const pixelRatio = window.devicePixelRatio || 1
    const currentZoomValue = normalizedRenderZoom.value
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const renderZoomValue = resolveRenderZoomLevel(level)
      const snapshot = buildSequentialLayoutForZoom(renderZoomValue)
      const { totalWidth } = snapshot
      const range = resolvePreRenderRange(currentZoomValue, renderZoomValue, totalWidth)
      if (range.end <= range.start) continue
      forEachVisibleLayoutItem(snapshot, range.start, range.end, (item) => {
        const track = item.track
        const filePath = track.filePath
        if (!filePath) return
        const data = waveformDataMap.get(filePath)
        const isSummary = renderZoomValue <= MIXTAPE_SUMMARY_ZOOM + 0.0001
        if (!data && !isSummary) return
        if (
          renderZoomValue >= RAW_WAVEFORM_MIN_ZOOM &&
          !rawWaveformDataMap.get(filePath) &&
          !isSummary
        ) {
          return
        }
        const ctx = buildTrackRenderContext(track, renderZoomValue)
        if (!ctx.trackWidth || !Number.isFinite(ctx.trackWidth)) return
        const trackStartX = item.startX
        const trackEndX = trackStartX + ctx.trackWidth
        const visibleStart = Math.max(trackStartX, range.start)
        const visibleEnd = Math.min(trackEndX, range.end)
        if (visibleEnd <= visibleStart) return
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX
        const tileStartIndex = Math.max(0, Math.floor(localStart / WAVEFORM_TILE_WIDTH))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / WAVEFORM_TILE_WIDTH)
        )
        const height = Math.max(1, Math.floor(ctx.laneHeight))
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
          const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, ctx.trackWidth - tileStart))
          if (!tileWidth) continue
          const cacheKey = buildWaveformTileCacheKey(
            filePath,
            tileIndex,
            renderZoomValue,
            Math.max(1, Math.floor(tileWidth)),
            height,
            pixelRatio
          )
          if (waveformTileCache.has(cacheKey) || waveformTilePending.has(cacheKey)) continue
          queue.push({
            ctx,
            tile: { index: tileIndex, start: tileStart, width: tileWidth },
            cacheKey
          })
        }
      })
    }
    return queue
  }

  const processWaveformPreRenderQueue = (token: number) => {
    if (token !== waveformPreRenderToken) return
    const queue = waveformPreRenderQueue
    if (!queue.length) return
    const startTime = performance.now()
    const budget = 12
    while (waveformPreRenderCursor < queue.length && performance.now() - startTime < budget) {
      const task = queue[waveformPreRenderCursor]
      if (waveformRenderWorker) {
        requestWaveformTileRender(task)
      } else {
        renderWaveformTileToCache(task)
      }
      waveformPreRenderCursor += 1
    }
    if (waveformPreRenderCursor < queue.length) {
      waveformPreRenderRaf = requestAnimationFrame(() => processWaveformPreRenderQueue(token))
    } else {
      waveformPreRenderQueue = []
      scheduleTimelineDraw()
    }
  }

  const startFullPreRender = () => {
    waveformPreRenderToken += 1
    waveformPreRenderCursor = 0
    waveformPreRenderQueue = buildWaveformPreRenderQueue()
    if (!waveformPreRenderQueue.length) return
    const targetLimit = waveformTileCache.size + waveformPreRenderQueue.length + 10
    if (targetLimit > waveformTileCacheLimit) {
      waveformTileCacheLimit = targetLimit
    }
    if (waveformPreRenderRaf) cancelAnimationFrame(waveformPreRenderRaf)
    waveformPreRenderRaf = requestAnimationFrame(() =>
      processWaveformPreRenderQueue(waveformPreRenderToken)
    )
  }

  const scheduleFullPreRender = () => {
    if (timelineWorkerReady.value) return
    if (waveformPreRenderTimer) clearTimeout(waveformPreRenderTimer)
    waveformPreRenderTimer = setTimeout(() => {
      waveformPreRenderTimer = null
      startFullPreRender()
    }, 200)
  }

  const buildWorkerPreRenderTasks = () => {
    const tasks: Array<{
      cacheKey: string
      filePath: string
      zoom: number
      tileIndex: number
      tileStart: number
      tileWidth: number
      trackWidth: number
      durationSeconds: number
      laneHeight: number
      pixelRatio: number
    }> = []
    if (!tracks.value.length) return tasks
    const pixelRatio = window.devicePixelRatio || 1
    const currentZoomValue = normalizedRenderZoom.value
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const snapshot = buildSequentialLayoutForZoom(level)
      const { totalWidth } = snapshot
      const range = resolvePreRenderRange(currentZoomValue, level, totalWidth)
      if (range.end <= range.start) continue
      forEachVisibleLayoutItem(snapshot, range.start, range.end, (item) => {
        const track = item.track
        const filePath = track.filePath
        if (!filePath) return
        const data = waveformDataMap.get(filePath)
        const isSummary = level <= MIXTAPE_SUMMARY_ZOOM + 0.0001
        if (!data && !isSummary) return
        if (level >= RAW_WAVEFORM_MIN_ZOOM && !rawWaveformDataMap.get(filePath) && !isSummary) {
          return
        }
        const ctx = buildTrackRenderContext(track, level)
        if (!ctx.trackWidth || !Number.isFinite(ctx.trackWidth)) return
        const trackStartX = item.startX
        const trackEndX = trackStartX + ctx.trackWidth
        const visibleStart = Math.max(trackStartX, range.start)
        const visibleEnd = Math.min(trackEndX, range.end)
        if (visibleEnd <= visibleStart) return
        const localStart = visibleStart - trackStartX
        const localEnd = visibleEnd - trackStartX
        const tileStartIndex = Math.max(0, Math.floor(localStart / WAVEFORM_TILE_WIDTH))
        const tileEndIndex = Math.max(
          tileStartIndex,
          Math.floor(Math.max(0, localEnd - 1) / WAVEFORM_TILE_WIDTH)
        )
        const height = Math.max(1, Math.floor(ctx.laneHeight))
        for (let tileIndex = tileStartIndex; tileIndex <= tileEndIndex; tileIndex += 1) {
          const tileStart = tileIndex * WAVEFORM_TILE_WIDTH
          const tileWidth = Math.max(0, Math.min(WAVEFORM_TILE_WIDTH, ctx.trackWidth - tileStart))
          if (!tileWidth) continue
          const cacheKey = buildWaveformTileCacheKey(
            filePath,
            tileIndex,
            level,
            Math.max(1, Math.floor(tileWidth)),
            height,
            pixelRatio
          )
          tasks.push({
            cacheKey,
            filePath,
            zoom: level,
            tileIndex,
            tileStart,
            tileWidth,
            trackWidth: ctx.trackWidth,
            durationSeconds: ctx.sourceDurationSeconds,
            laneHeight: ctx.laneHeight,
            pixelRatio
          })
        }
      })
    }
    return tasks
  }

  const buildWorkerFramePreRenderTasks = () => {
    const tasks: TimelineRenderPayload[] = []
    if (!tracks.value.length) return tasks
    const viewport =
      (timelineScrollRef.value?.osInstance()?.elements().viewport as HTMLElement | undefined) ||
      null
    const widthPx = Math.max(0, Math.floor(viewport?.clientWidth || timelineViewportWidth.value))
    const heightPx = Math.max(0, Math.floor(viewport?.clientHeight || timelineViewportHeight.value))
    if (!widthPx || !heightPx) return tasks
    const startX = Math.round(viewport?.scrollLeft || timelineScrollLeft.value || 0)
    const startY = Math.round(viewport?.scrollTop || timelineScrollTop.value || 0)
    const levels = resolvePreRenderZoomLevels()
    for (const level of levels) {
      const payload = buildTimelineRenderPayload(widthPx, heightPx, startX, startY, level)
      if (payload) tasks.push(payload)
    }
    return tasks
  }

  const startWorkerPreRender = () => {
    if (!timelineWorkerReady.value || !waveformRenderWorker) return
    if (!tracks.value.length) return
    if (preRenderState.value.active) {
      cancelWorkerPreRender()
    }
    const tileTasks = buildWorkerPreRenderTasks()
    const frameTasks = buildWorkerFramePreRenderTasks()
    if (!tileTasks.length && !frameTasks.length) return
    pendingFramePreRenderTasks = frameTasks
    preRenderTotals.value = { tiles: tileTasks.length, frames: frameTasks.length }
    preRenderState.value = {
      active: true,
      total: tileTasks.length + frameTasks.length,
      done: 0
    }
    if (tileTasks.length) {
      preRenderPhase.value = 'tiles'
      postWaveformWorkerMessage({ type: 'preRenderTiles', payload: { tasks: tileTasks } })
    } else {
      preRenderPhase.value = 'frames'
      postWaveformWorkerMessage({ type: 'preRenderFrames', payload: { tasks: frameTasks } })
    }
  }

  const scheduleWorkerPreRender = () => {
    if (!timelineWorkerReady.value || !waveformRenderWorker) return
    if (waveformWorkerPreRenderTimer) clearTimeout(waveformWorkerPreRenderTimer)
    waveformWorkerPreRenderTimer = setTimeout(() => {
      waveformWorkerPreRenderTimer = null
      startWorkerPreRender()
    }, 300)
  }

  const cancelWorkerPreRender = () => {
    if (waveformWorkerPreRenderTimer) {
      clearTimeout(waveformWorkerPreRenderTimer)
      waveformWorkerPreRenderTimer = null
    }
    preRenderState.value = { active: false, total: 0, done: 0 }
    preRenderPhase.value = 'idle'
    preRenderTotals.value = { tiles: 0, frames: 0 }
    pendingFramePreRenderTasks = []
    postWaveformWorkerMessage({ type: 'cancelPreRender' })
  }

  const markTimelineInteracting = () => {}

  const {
    isTrackDragging,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadSec,
    playheadVisible,
    transportError,
    timelineDurationSec,
    playheadTimeLabel,
    overviewPlayheadStyle,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    stopTransportForTrackChange,
    handleTrackDragStart,
    scheduleTransportPreload,
    cleanupTransportAndDrag
  } = createTimelineTransportAndDragModule({
    tracks,
    timelineLayout,
    normalizedRenderZoom,
    timelineScrollLeft,
    timelineViewportWidth,
    buildSequentialLayoutForZoom,
    resolveRenderPxPerSec,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackTempoRatio,
    resolveTrackFirstBeatSeconds,
    computeTimelineDuration,
    scheduleFullPreRender,
    scheduleWorkerPreRender
  })

  const scheduleTimelineDrawBridgeRef: { value: null | (() => void) } = { value: null }
  const createBridgeRef = <T>(getter: () => T, setter: (value: T) => void) => ({
    get value() {
      return getter()
    },
    set value(value: T) {
      setter(value)
    }
  })
  const waveformRenderWorkerRef = createBridgeRef(
    () => waveformRenderWorker,
    (value: Worker | null) => (waveformRenderWorker = value)
  )
  const timelineOffscreenCanvasRef = createBridgeRef(
    () => timelineOffscreenCanvas,
    (value: OffscreenCanvas | null) => (timelineOffscreenCanvas = value)
  )
  const timelineObserverRef = createBridgeRef(
    () => timelineObserver,
    (value: ResizeObserver | null) => (timelineObserver = value)
  )
  const timelineViewportObserverRef = createBridgeRef(
    () => timelineViewportObserver,
    (value: ResizeObserver | null) => (timelineViewportObserver = value)
  )
  const overviewObserverRef = createBridgeRef(
    () => overviewObserver,
    (value: ResizeObserver | null) => (overviewObserver = value)
  )
  const pendingFramePreRenderTasksRef = createBridgeRef(
    () => pendingFramePreRenderTasks,
    (value: TimelineRenderPayload[]) => (pendingFramePreRenderTasks = value)
  )
  const waveformPreRenderRafRef = createBridgeRef(
    () => waveformPreRenderRaf,
    (value: number) => (waveformPreRenderRaf = value)
  )
  const waveformPreRenderCursorRef = createBridgeRef(
    () => waveformPreRenderCursor,
    (value: number) => (waveformPreRenderCursor = value)
  )
  const waveformPreRenderQueueRef = createBridgeRef(
    () => waveformPreRenderQueue,
    (value: WaveformPreRenderTask[]) => (waveformPreRenderQueue = value)
  )
  const {
    postWaveformWorkerMessage,
    clearWaveformTileCacheForFile,
    pushMixxxWaveformToWorker,
    pushRawWaveformToWorker,
    handleWaveformWorkerMessage,
    requestWaveformTileRender,
    initTimelineWorkerRenderer,
    buildTimelineRenderPayload,
    requestTimelineWorkerRender
  } = createTimelineWorkerBridgeModule({
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
    getScheduleTimelineDraw: () => scheduleTimelineDrawBridgeRef.value,
    buildSequentialLayoutForZoom,
    forEachVisibleLayoutItem,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatMs,
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
  })
  const timelineCanvasRafRef = createBridgeRef(
    () => timelineCanvasRaf,
    (value: number) => (timelineCanvasRaf = value)
  )
  const waveformLoadTimerRef = createBridgeRef(
    () => waveformLoadTimer,
    (value: ReturnType<typeof setTimeout> | null) => (waveformLoadTimer = value)
  )
  const {
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
  } = createTimelineRenderAndLoadModule({
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
  })
  scheduleTimelineDrawBridgeRef.value = scheduleTimelineDraw
  const {
    applyRenderZoomImmediate,
    setZoomValue,
    autoFitZoom,
    updateTimelineWidth,
    syncTimelineScrollState,
    startTimelineScrollSampler,
    resolveTimelineViewportEl,
    normalizeWheelDeltaY,
    flushPendingWheelZoom,
    scheduleWheelZoomFlush,
    isWheelInsideTimeline,
    handleTimelineWheel,
    handleTimelinePanStart,
    handleTimelinePanMove,
    handleTimelinePanEnd,
    updateOverviewWidth,
    resolveOverviewPointer,
    scrollTimelineToRatio,
    scrollTimelineToCenterRatio,
    handleOverviewMouseDown,
    handleOverviewMouseMove,
    handleOverviewMouseUp,
    handleOverviewClick,
    setTimelineWheelTarget,
    cleanupInteractions
  } = createTimelineInteractionsModule({
    zoom,
    renderZoom,
    zoomTouched,
    normalizedZoom,
    normalizedRenderZoom,
    resolveRenderZoomLevel,
    tracks,
    timelineScrollRef,
    timelineViewportWidth,
    timelineContentWidth,
    timelineScrollLeft,
    timelineScrollTop,
    timelineViewportHeight,
    timelineLayout,
    timelineWidth,
    isTimelinePanning,
    isOverviewDragging,
    overviewRef,
    overviewWidth,
    overviewViewportLeft,
    overviewViewportWidth,
    alignZoomToRenderLevel,
    clampZoomValue,
    resolveTrackDurationSeconds,
    resolveRenderPxPerSec,
    computeTimelineDuration,
    renderPxPerSec,
    clearTimelineLayoutCache,
    scheduleTimelineDraw,
    scheduleWaveformLoad,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    markTimelineInteracting
  })
  createTimelineWatchAndMountModule({
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
    initTimelineWorkerRenderer,
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
  })

  onBeforeUnmount(() => {
    cleanupTransportAndDrag()
    try {
      timelineObserver?.disconnect()
    } catch {}
    try {
      timelineViewportObserver?.disconnect()
    } catch {}
    try {
      overviewObserver?.disconnect()
    } catch {}
    setTimelineWheelTarget(null)
    try {
      if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
        window.electron.ipcRenderer.removeListener(
          'mixtape-waveform-updated',
          handleWaveformUpdated
        )
      }
    } catch {}
    if (waveformLoadTimer) {
      clearTimeout(waveformLoadTimer)
      waveformLoadTimer = null
    }
    if (waveformPreRenderTimer) {
      clearTimeout(waveformPreRenderTimer)
      waveformPreRenderTimer = null
    }
    cancelWorkerPreRender()
    if (waveformPreRenderRaf) {
      cancelAnimationFrame(waveformPreRenderRaf)
      waveformPreRenderRaf = 0
    }
    waveformPreRenderQueue = []
    if (waveformRenderWorker) {
      try {
        postWaveformWorkerMessage({ type: 'clearAllCaches' })
        waveformRenderWorker.terminate()
      } catch {}
      waveformRenderWorker = null
    }
    timelineWorkerReady.value = false
    timelineOffscreenCanvas = null
    if (timelineCanvasRaf) {
      cancelAnimationFrame(timelineCanvasRaf)
      timelineCanvasRaf = 0
    }
    cleanupInteractions()
  })

  return {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    scheduleWaveformDraw,
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadSec,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    transportError
  }
}
