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
import { isRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformData'

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
  startSec: Math.max(0, Number(value.startSec) || 0),
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
  let retainedWaveformFilePath = ''
  let retainedRawData: RawWaveformData | null = null
  let retainedMixxxData: MixxxWaveformData | null = null
  let holdPreviousWaveformFrame = false
  // 记录最近一次 streamWaveformRenderer.draw 成功画过的 rawData 引用。
  // 作用：判断本次要画的 rawData 和 renderer 内部 lastFrame.rawData 是否同一个对象：
  //   * 若相同：canReusePreviousFrame=true，streamWaveformRenderer.draw 会走 scroll reuse
  //     路径，只画右边缘 shift 出来的那一小段——左边旧波形像素保留。此时即使 rawData
  //     整段覆盖还不完整，也可以安全调用 draw：最多右边缘短暂画一条平线，过几帧数据到了
  //     就会被刷新，**波形主体会跟着 playback 滚动**。
  //   * 若不同（刚换了新 rawData 对象）：canReusePreviousFrame=false，draw 会走
  //     clearRect + drawRange 路径，用当前稀疏数据整屏重画，造成大片空白——这就是旧的
  //     "波形消失只剩网格线"bug。这种情况下我们必须等 rawData 覆盖充分再画。
  // 通过它把上面两种情形区分开：引用稳定时宽松允许绘制，引用刚变化时严格等覆盖。
  let lastStreamRenderedRawData: RawWaveformData | null = null

  // displayStartSec 代表"当前 canvas 像素与 DOM 层标记（grid / cue / hotcue / memory cue / loop mask）
  // 统一对应的 start sec"——即 **这一帧真正呈现给用户的可视区起点**。
  // 它和 previewStartSec / renderStartSec 的关系：
  //   * renderStartSec：由 previewStartSec 在本帧决定的"理想显示位置"（随 playback tick 推进、
  //     随 seek 立即跳）。
  //   * displayStartSec：只有在"本帧波形真的画出来了"的分支里才会被更新为 renderStartSec；
  //     如果波形这一帧画不出来（seek 后 rawData 还没覆盖新可视区 / 首批 chunk 未到 / 引用刚换），
  //     displayStartSec 保持上一帧的值 —— canvas 冻结在旧像素，grid / cue / hotcue 等 DOM
  //     层元素也一并冻结在同一起点，视觉上所有元素完全同步。
  //   * 一旦波形重新画出来，这一帧 displayStartSec = renderStartSec，所有元素同步跳到当前位置。
  // 这样 seek 后允许出现短暂的整体冻结（音频仍然立即响应，画面延后统一出现），但杜绝
  // "网格在滚、波形冻结"这种局部错位。
  const displayStartSec = ref(0)
  // displayReady = false 表示"这一帧的可视画面尚不可用"——canvas 上没有对应 displayStartSec 的
  // 有效波形像素（例如 seek 后被 hold 清空、首帧尚未就绪）。DOM 层（grid / cue / hotcue /
  // memory cue / loop mask）在 displayReady=false 时会统一隐藏，呈现整块空白，避免只画 grid
  // 却没波形的错位感。displayReady=true 才表示"canvas + DOM 已全部同步到 displayStartSec"。
  const displayReady = ref(false)

  const waveformTilePending = new Set<string>()
  const waveformTileCache = new Map<string, HorizontalBrowseWaveformTileCacheEntry>()
  const pendingVisibleTilePaints = new Map<string, HorizontalBrowseVisibleTilePaintPayload>()

  const traceHorizontalWaveformRender = (source: string, payload?: Record<string, unknown>) => {
    const filePath = String(options.song()?.filePath || '').trim()
    const signature = [
      options.direction(),
      filePath,
      source,
      String(payload?.mixxxSource ?? ''),
      String(payload?.effectiveRawCoverage ?? ''),
      String(payload?.holdingFrame ?? '')
    ].join('|')
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

  const resetRetainedWaveformData = () => {
    retainedWaveformFilePath = ''
    retainedRawData = null
    retainedMixxxData = null
    holdPreviousWaveformFrame = false
    lastStreamRenderedRawData = null
    // 外部重置 retained（例如切歌、loadWaveform）会清掉 canvas 上所有可用像素，
    // 此时 DOM 层也要同步进入"未就绪"状态；等下一次成功绘制时统一恢复显示。
    displayReady.value = false
  }

  const holdCurrentWaveformFrame = () => {
    holdPreviousWaveformFrame = true
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

  const clearGridCanvas = () => {
    const canvas = gridCanvasRef.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const resolveRawDataCoveredEndSec = (rawData: RawWaveformData | null) => {
    if (!rawData) return 0
    const startSec = Math.max(0, Number(rawData.startSec) || 0)
    const rate = Math.max(0, Number(rawData.rate) || 0)
    if (!rate) return startSec
    const loadedFrames = Math.max(0, Number(rawData.loadedFrames ?? rawData.frames) || 0)
    return startSec + loadedFrames / rate
  }

  const isRawDataCoveringRange = (
    rawData: RawWaveformData | null,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    if (!rawData) return false
    const rawStartSec = Math.max(0, Number(rawData.startSec) || 0)
    const rawEndSec = resolveRawDataCoveredEndSec(rawData)
    const rangeEndSec = rangeStartSec + Math.max(0, rangeDurationSec)
    // 播放头被定位在可视区中间（playheadRatio=0.5），所以歌曲开头时 renderStartSec 会是负值
    // （例如 currentSec=0、visible=12s → renderStartSec=-6），可视区左半边 [-6, 0] 永远
    // 没有音频——不是"数据缺失"，而是"本来就不存在"。同理歌曲结尾也会有右边一段超出 duration。
    // 覆盖判定只需要关心 rawData **实际可产出像素的音频区间**（与歌曲时长的交集），否则会
    // 在播放开头 / 结尾那 leadingPad / trailingPad 秒里永远被判为 coverage=false，
    // stream 分支拒绝绘制，出现"点击播放后波形过几秒才跟上"的症状。
    const songDurationSec = Math.max(0, Number(rawData.duration) || 0)
    const audioEndSec = songDurationSec > 0 ? songDurationSec : Number.POSITIVE_INFINITY
    const audibleStartSec = Math.max(rangeStartSec, 0)
    const audibleEndSec = Math.min(rangeEndSec, audioEndSec)
    if (audibleEndSec <= audibleStartSec) {
      // 可视区完全落在歌曲之外（比如滚到开头前或结尾后），没有像素需要从 rawData 画，
      // 视为"覆盖已满足"。
      return true
    }
    return audibleStartSec >= rawStartSec && audibleEndSec <= rawEndSec
  }

  const isRawDataIntersectingRange = (
    rawData: RawWaveformData | null,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    if (!rawData) return false
    const rawStartSec = Math.max(0, Number(rawData.startSec) || 0)
    const rawEndSec = resolveRawDataCoveredEndSec(rawData)
    const rangeEndSec = rangeStartSec + Math.max(0, rangeDurationSec)
    return rangeEndSec > rawStartSec && rangeStartSec < rawEndSec
  }

  const resolveActiveMixxxSelection = () => {
    const liveMixxxData = options.mixxxData.value
    if (liveMixxxData && !isRawPlaceholderMixxxData(liveMixxxData)) {
      return { data: liveMixxxData, source: 'live' as const }
    }
    if (liveMixxxData) {
      return { data: liveMixxxData, source: 'placeholder' as const }
    }
    return { data: null, source: 'none' as const }
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

  const drawWaveformTiles = (
    viewStartSec: number,
    visibleDuration: number,
    effectiveMixxxData: MixxxWaveformData | null
  ) => {
    const wrap = wrapRef.value
    const canvas = waveformCanvasRef.value
    if (!wrap || !canvas) return false

    const ctx = canvas.getContext('2d')
    if (!ctx || !options.rawData.value || !effectiveMixxxData) {
      clearWaveformCanvas()
      return false
    }

    const metrics = resolveCanvasScaleMetrics(
      wrap.clientWidth,
      wrap.clientHeight,
      window.devicePixelRatio || 1
    )

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

    // 先登记 tile 渲染请求，异步补齐缓存；不阻塞后续判定
    requestWaveformTileBatch([...visibleRequests, ...prewarmRequests])

    // 只有在至少一个 visible tile 已命中缓存时才接管 canvas；
    // 否则直接返回 false，交给调用方的 stream-fallback 渲染器处理，
    // 避免无条件 clearRect 破坏渲染器的滚动复用路径（会导致播放时波形消失只剩网格线）。
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
      displayReady.value = false
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolveSnappedRenderStartSec(visibleDuration)
    const playbackStreamReuse = options.playing.value && !options.dragging.value
    const streamMaxSamplesPerPixel = playbackStreamReuse
      ? PREVIEW_MAX_SAMPLES_PER_PIXEL
      : DRAG_RAW_MAX_SAMPLES_PER_PIXEL
    const currentFilePath = String(options.song()?.filePath || '').trim()
    const activeMixxxSelection = resolveActiveMixxxSelection()
    const canUseRetainedWaveform =
      options.rawStreamActive.value &&
      !!currentFilePath &&
      currentFilePath === retainedWaveformFilePath &&
      !!retainedRawData &&
      !!retainedMixxxData

    // 选择本帧要用来画波形的 rawData 引用：
    //   优先 options.rawData.value（live，代表当前最新的 stream 数据）；
    //   但 seek 重启 stream 后，ensureRawWaveformCapacity 会把 live 换成一个全新的对象
    //   （新的 startSec / 新的 loadedFrames=0），需要等若干个 chunk 积累才能覆盖可视区。
    //   过渡期内如果 live 不覆盖可视区、而 retainedRawData（上一帧成功绘制用的那个引用）
    //   仍然覆盖新位置，就用 retained 画——这样波形能和 grid 保持同步滚动，不会出现
    //   "grid 在动、canvas 冻结成旧像素、零点几秒后突然对齐"那种错位闪烁。
    //   retained 覆盖不了就退回 live（至少保留 intersection 范围内的像素 / 让 canDrawStream
    //   走 hold 分支）。
    const liveRawData = options.rawData.value
    const liveRawCovers = isRawDataCoveringRange(liveRawData, renderStartSec, visibleDuration)
    const retainedRawCovers =
      canUseRetainedWaveform &&
      isRawDataCoveringRange(retainedRawData, renderStartSec, visibleDuration)
    const preferRetainedRaw =
      !!liveRawData && !liveRawCovers && retainedRawCovers && liveRawData !== retainedRawData

    let effectiveRawData: RawWaveformData | null
    let effectiveMixxxSelection: {
      data: MixxxWaveformData | null
      source: 'live' | 'placeholder' | 'retained' | 'retained-placeholder' | 'none'
    }
    if (preferRetainedRaw) {
      effectiveRawData = retainedRawData
      effectiveMixxxSelection = retainedMixxxData
        ? {
            data: retainedMixxxData,
            source: isRawPlaceholderMixxxData(retainedMixxxData)
              ? 'retained-placeholder'
              : 'retained'
          }
        : activeMixxxSelection.data
          ? activeMixxxSelection
          : { data: null, source: 'none' }
    } else if (liveRawData) {
      effectiveRawData = liveRawData
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : canUseRetainedWaveform && retainedMixxxData
          ? {
              data: retainedMixxxData,
              source: isRawPlaceholderMixxxData(retainedMixxxData)
                ? 'retained-placeholder'
                : 'retained'
            }
          : { data: null, source: 'none' }
    } else if (canUseRetainedWaveform && retainedRawData) {
      effectiveRawData = retainedRawData
      effectiveMixxxSelection = retainedMixxxData
        ? {
            data: retainedMixxxData,
            source: isRawPlaceholderMixxxData(retainedMixxxData)
              ? 'retained-placeholder'
              : 'retained'
          }
        : activeMixxxSelection.data
          ? activeMixxxSelection
          : { data: null, source: 'none' }
    } else {
      effectiveRawData = null
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    }

    const effectiveMixxxData = effectiveMixxxSelection.data
    const effectiveRawCoverage = isRawDataCoveringRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const effectiveRawIntersection = isRawDataIntersectingRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage =
      effectiveMixxxSelection.source === 'live' || effectiveMixxxSelection.source === 'retained'

    const commitRetainedFromDrawn = () => {
      // 只在"这一帧真的用 drawableRawData 画出来了"之后更新 retained，且只写实际画的那个引用。
      // 这样 live 被 ensureRawWaveformCapacity 换成新对象、但新对象还没填够数据的窗口期里，
      // retained 会继续保留"上一帧画成功的那个可用引用"，下一帧可以无缝回落到它，
      // 避免 canvas 因为 live 换 ref / 覆盖不足而冻结或清空。
      if (!currentFilePath) return
      if (!drawableRawData) return
      retainedWaveformFilePath = currentFilePath
      retainedRawData = drawableRawData
      // retainedMixxxData 仅在本帧 mixxxData 源是 live 时同步，避免把 placeholder / retained 再写回 retained。
      if (activeMixxxSelection.source === 'live' && activeMixxxSelection.data) {
        retainedMixxxData = activeMixxxSelection.data
      }
    }

    // 注意：retainedRawData / retainedMixxxData 不在这里无条件地从 options.rawData.value 抓快照。
    // seek 刚重启 stream 时 live 会被 ensureRawWaveformCapacity 换成一个尚未覆盖可视区的
    // 新对象；如果这时就把 retained 更新成它，下一帧就没有"还能画的旧数据"可退回了。
    // 所以只在真正成功绘制了一帧（stream-live / stream-fallback / tile-cache）之后，
    // 用那一帧实际画的 rawData（drawableRawData，即 live 或保持的 retained）去更新 retained，
    // 让"已被画过的那个引用"始终是下次过渡期的回落对象。
    // hold 的释放时机同样也只放在成功渲染分支，不在这里投机性重置。

    if (!effectiveMixxxData) {
      traceHorizontalWaveformRender('empty', {
        mixxxSource: effectiveMixxxSelection.source,
        effectiveRawCoverage,
        holdingFrame: holdPreviousWaveformFrame
      })
      clearWaveformCanvas()
      lastStreamRenderedRawData = null
      // 完全无数据可画：通知 DOM 层也整块隐藏，避免只剩 grid/cue 悬在那里。
      displayReady.value = false
    } else if (options.rawStreamActive.value || options.dragging.value) {
      // 判断是否可以把当前这帧交给 streamWaveformRenderer.draw 绘制：
      //   * effectiveRawCoverage=true（rawData 严格覆盖可视区）：无论 renderer 走 scroll reuse
      //     还是 clearRect+drawRange 都能得到完整波形，安全。
      //   * rawDataRefStable=true（rawData 对象引用与 renderer 内部 lastFrame.rawData 一致）：
      //     canReusePreviousFrame 返回 true，renderer 走 scroll reuse：复用当前 canvas 像素 +
      //     只重绘右边缘 shift 出来的一小段。即使 rawData 末尾几帧数据还没填入，右边缘最多
      //     短暂画成平线，左边旧波形像素会被保留——波形主体跟 playback 同步滚动。
      //   * 以上都不满足（rawData 新换 ref 且尚未覆盖可视区）：draw 会走 clearRect+drawRange，
      //     用稀疏数据整屏重画，导致大片空白（历史"波形消失只剩网格线"bug）。必须放弃绘制，
      //     保留 canvas 现状，等下一次 ensureRawWaveformCapacity 填充或同一 ref 稳定后再画。
      const rawDataRefStable =
        drawableRawData != null && drawableRawData === lastStreamRenderedRawData
      const canDrawStream = Boolean(drawableRawData) && (effectiveRawCoverage || rawDataRefStable)
      if (!canDrawStream) {
        traceHorizontalWaveformRender(
          holdPreviousWaveformFrame ? 'stream-hold' : 'stream-await-raw',
          {
            mixxxSource: effectiveMixxxSelection.source,
            effectiveRawCoverage,
            rawDataRefStable,
            holdingFrame: holdPreviousWaveformFrame,
            renderStartSec,
            visibleDuration,
            rawStartSec: effectiveRawData ? Number(effectiveRawData.startSec) || 0 : 0,
            rawEndSec: resolveRawDataCoveredEndSec(effectiveRawData)
          }
        )
        if (holdPreviousWaveformFrame) {
          // seek 情境：清空画布，并通知 DOM 层整块隐藏（grid / cue / hotcue 一起空白），
          // 避免出现"canvas 空、grid 还在旧位置滚动"这种视觉错位；等 rawData 覆盖新位置
          // 再一次性把全部元素一起显示到当前 renderStartSec。
          clearWaveformCanvas()
          streamWaveformRenderer.reset()
          lastStreamRenderedRawData = null
          displayReady.value = false
        }
        // 非 seek：保留 canvas 现有内容，并且 **不** 更新 displayStartSec / displayReady，
        // grid / cue / hotcue 等 DOM 层也保持上一帧的位置——整块画面同步"冻结"在上次成功
        // 绘制出的位置，杜绝"grid 在动、波形停"这种错位感。等下一帧能画出来时再统一推进。
      } else {
        holdPreviousWaveformFrame = false
        traceHorizontalWaveformRender('stream-live', {
          mixxxSource: effectiveMixxxSelection.source,
          effectiveRawCoverage,
          rawDataRefStable,
          holdingFrame: false
        })
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
          mixxxData: effectiveMixxxData,
          rawData: drawableRawData,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          showDetailHighlights: false,
          showCenterLine: false,
          showBackground: false,
          showBeatGrid: false,
          allowScrollReuse: playbackStreamReuse,
          waveformLayout: resolveWaveformLayout(),
          preferRawPeaksOnly: false
        })
        lastStreamRenderedRawData = drawableRawData
        commitRetainedFromDrawn()
        displayStartSec.value = renderStartSec
        displayReady.value = true
        finishTiming()
      }
    } else if (!drawableRawData && !canRenderWithoutRawCoverage) {
      traceHorizontalWaveformRender('await-detail-raw', {
        mixxxSource: effectiveMixxxSelection.source,
        effectiveRawCoverage,
        holdingFrame: holdPreviousWaveformFrame,
        renderStartSec,
        visibleDuration,
        rawStartSec: effectiveRawData ? Number(effectiveRawData.startSec) || 0 : 0,
        rawEndSec: resolveRawDataCoveredEndSec(effectiveRawData)
      })
      // 保留 canvas 现有内容，且不推进 displayStartSec / displayReady——整块画面冻结在
      // 上次成功绘制出的位置，等新数据可用后和波形一起同步推进。
    } else {
      const drewTiles = drawWaveformTiles(renderStartSec, visibleDuration, effectiveMixxxData)
      if (drewTiles) {
        holdPreviousWaveformFrame = false
        traceHorizontalWaveformRender('tile-cache', {
          mixxxSource: effectiveMixxxSelection.source,
          effectiveRawCoverage,
          holdingFrame: false
        })
        commitRetainedFromDrawn()
        displayStartSec.value = renderStartSec
        displayReady.value = true
      } else {
        holdPreviousWaveformFrame = false
        traceHorizontalWaveformRender('stream-fallback', {
          mixxxSource: effectiveMixxxSelection.source,
          effectiveRawCoverage,
          holdingFrame: false
        })
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
          mixxxData: effectiveMixxxData,
          rawData: drawableRawData,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          showDetailHighlights: false,
          showCenterLine: false,
          showBackground: false,
          showBeatGrid: false,
          allowScrollReuse: playbackStreamReuse,
          waveformLayout: resolveWaveformLayout(),
          preferRawPeaksOnly: false
        })
        lastStreamRenderedRawData = drawableRawData
        commitRetainedFromDrawn()
        displayStartSec.value = renderStartSec
        displayReady.value = true
        finishTiming()
      }
    }

    if (!displayReady.value) {
      // 本帧波形/tile 都未能呈现：grid 也一起清空，让整块画面保持统一空白，等下一次
      // 成功绘制时所有元素同步出现在 displayStartSec 上。
      gridRenderer.reset()
      clearGridCanvas()
      return
    }

    // grid 用 displayStartSec（= 本帧成功绘制分支里刚赋的 renderStartSec），与 canvas 像素
    // 和 DOM 层标记统一对齐；这样即使 previewStartSec 在 tick 推进，grid 也绝不会单独跑在
    // 波形之前。
    gridRenderer.draw({
      canvas: gridCanvas,
      wrap,
      bpm: Number(options.previewBpm.value) || 0,
      firstBeatMs: Number(options.previewFirstBeatMs.value) || 0,
      barBeatOffset: Number(options.previewBarBeatOffset.value) || 0,
      rangeStartSec: displayStartSec.value,
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

    // 如果当前整块画面还处于"未就绪"状态（例如 seek 后被 hold 清空、等 stream 补数据），
    // 不能走 dirty 增量路径——那只会在隐藏的 DOM 层下偷偷在 canvas 上画零碎波形，而
    // displayReady 永远没机会被拉回 true，grid / cue / hotcue / playhead 一直处于 v-if=false
    // / v-show=false 状态，表现为"波形停在意外位置、cue/grid 都没有、拖动等交互看起来也无响应"。
    // 这里强制 fallback 到整帧 scheduleDraw，让 drawWaveform 根据最新 rawData 判定是否
    // 可以进入 stream-live / stream-fallback / tile-cache 分支并把 displayReady 恢复为 true。
    if (!displayReady.value) {
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
    resetRetainedWaveformData()
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
    holdCurrentWaveformFrame,
    resetRetainedWaveformData,
    storeRawWaveform,
    setLastZoomAnchor,
    resetLastZoomAnchor,
    displayStartSec,
    displayReady,
    dispose
  }
}
