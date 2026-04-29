import { ref, type Ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/components/horizontalBrowseDetailMath'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC
} from '@renderer/components/horizontalBrowseWaveform.constants'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  clampNumber
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { sendHorizontalBrowseWaveformTrace } from '@renderer/components/horizontalBrowseWaveformTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { isRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformData'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/components/horizontalBrowseDetailLiveCanvasBridge'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import type {
  HorizontalBrowseDetailLiveCanvasLoopRange,
  HorizontalBrowseDetailLiveCanvasRawChunk,
  HorizontalBrowseDetailLiveCanvasRawMeta,
  HorizontalBrowseDetailLiveCanvasRawSlot,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

type HorizontalBrowseDirection = 'up' | 'down'
type HorizontalBrowseWaveformLayout = 'top-half' | 'bottom-half'

type UseHorizontalBrowseRawWaveformCanvasOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  deferWaveformLoad: Ref<boolean>
  cueSeconds: () => number | undefined
  hotCues: () => ISongHotCue[] | null | undefined
  memoryCues: () => ISongMemoryCue[] | null | undefined
  loopRange: () => { startSec: number; endSec: number } | null | undefined
  currentSeconds: () => number | undefined
  playbackRate: () => number | undefined
  playing: Ref<boolean>
  playbackSyncRevision: Readonly<Ref<number>>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  previewStartSec: Ref<number>
  previewZoom: Ref<number>
  previewBpm: Readonly<Ref<number>>
  previewFirstBeatMs: Ref<number>
  previewBarBeatOffset: Ref<number>
  previewTimeBasisOffsetMs: Ref<number>
  dragging: Ref<boolean>
  rawStreamActive: Ref<boolean>
}

const DRAG_RAW_MAX_SAMPLES_PER_PIXEL = 32
const RAW_STREAM_REDRAW_INTERVAL_MS = 80
const DEFERRED_RAW_STREAM_REDRAW_INTERVAL_MS = 160
const DEFERRED_RAW_MAX_SAMPLES_PER_PIXEL = 12
const DEFAULT_CUE_ACCENT_COLOR = '#d98921'

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = ref<HTMLCanvasElement | null>(null)

  let lastZoomAnchorSec = 0
  let lastZoomAnchorRatio = HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  let drawRaf = 0
  let streamDrawRaf = 0
  let streamDrawTimer: ReturnType<typeof setTimeout> | null = null
  let nextAllowedStreamDrawAt = 0
  let pendingRawStreamDirtyStartSec: number | null = null
  let pendingRawStreamDirtyEndSec: number | null = null
  let lastRenderTraceSignature = ''
  let liveCanvasRenderToken = 0
  let liveCanvasAttached = false
  let retainedWaveformFilePath = ''
  let retainedRawData: RawWaveformData | null = null
  let retainedMixxxData: MixxxWaveformData | null = null
  let holdPreviousWaveformFrame = false
  // 从"空白/冻结"恢复的第一帧先整帧落位，紧接着再禁一次 scroll reuse，
  // 避免首帧 full redraw 和下一帧 reuse 紧挨着出现，肉眼看到抽两下。
  let suppressNextPlaybackScrollReuse = false
  // 记录最近一次成功画过的 rawData 引用。
  // 作用：判断本次要画的 rawData 和上一帧真正落到 waveform canvas 上的是不是同一个对象：
  //   * 若相同：worker 侧可以走 scroll reuse
  //     路径，只画右边缘 shift 出来的那一小段——左边旧波形像素保留。此时即使 rawData
  //     整段覆盖还不完整，也可以安全调用 draw：最多右边缘短暂画一条平线，过几帧数据到了
  //     就会被刷新，**波形主体会跟着 playback 滚动**。
  //   * 若不同（刚换了新 rawData 对象）：worker 会走
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

  const liveCanvasBridge = createHorizontalBrowseDetailLiveCanvasBridge({
    onRendered: (payload) => handleLiveCanvasRendered(payload)
  })

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
    const clampedStart = clampPreviewStart(options.previewStartSec.value)
    if (visibleDuration <= 0) return clampedStart
    // 这里不能再按像素步长把时间轴量化了。
    // 旧逻辑会把 renderStartSec snap 到整像素对应的秒数，真实位移不是"每帧整像素"
    // 时就会出现 0px / 1px / 2px 交替跳，肉眼看起来就是"规律性滚一下卡一下"。
    // 保留连续时间，再交给 renderer 用亚像素 scroll reuse 处理，视觉上才是连续滚动。
    return clampedStart
  }

  const resolvePlaybackDrivenRenderStartSec = (visibleDuration: number) => {
    if (!options.playing.value || options.dragging.value) {
      return resolveSnappedRenderStartSec(visibleDuration)
    }
    const playbackSeconds = Math.max(0, Number(options.currentSeconds()) || 0)
    return resolvePlaybackAlignedStart(playbackSeconds)
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

  const resolveDeferredVisualProtection = () =>
    options.deferWaveformLoad.value && !options.playing.value

  const resolveCueAccentColor = () => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--shell-cue-accent')
      .trim()
    return value || DEFAULT_CUE_ACCENT_COLOR
  }

  const resolveWorkerLoopRange = (): HorizontalBrowseDetailLiveCanvasLoopRange | null => {
    const loopRange = options.loopRange()
    if (!loopRange) return null
    const startSec = Math.max(0, Number(loopRange.startSec) || 0)
    const endSec = Math.max(startSec, Number(loopRange.endSec ?? loopRange.startSec) || startSec)
    return {
      startSec,
      endSec
    }
  }

  const resetRetainedWaveformData = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    retainedWaveformFilePath = ''
    retainedRawData = null
    retainedMixxxData = null
    holdPreviousWaveformFrame = false
    suppressNextPlaybackScrollReuse = false
    lastStreamRenderedRawData = null
    // 外部重置 retained（例如切歌、loadWaveform）会清掉 canvas 上所有可用像素，
    // 此时 DOM 层也要同步进入"未就绪"状态；等下一次成功绘制时统一恢复显示。
    displayReady.value = false
  }

  const holdCurrentWaveformFrame = () => {
    holdPreviousWaveformFrame = true
    suppressNextPlaybackScrollReuse = false
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
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    for (const canvas of [gridCanvasRef.value]) {
      if (!canvas) continue
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }

  const clearWaveformCanvas = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
  }

  const clearGridCanvas = () => {
    const canvas = gridCanvasRef.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const ensureLiveCanvasMounted = () => {
    if (liveCanvasAttached) return true
    liveCanvasAttached = liveCanvasBridge.mount(waveformCanvasRef.value, overlayCanvasRef.value)
    return liveCanvasAttached
  }

  const resolveRawSlotForRender = (
    rawData: RawWaveformData | null
  ): HorizontalBrowseDetailLiveCanvasRawSlot | null => {
    if (!rawData) return null
    if (rawData === retainedRawData) return 'retained'
    return 'live'
  }

  const handleLiveCanvasRendered = (
    payload: Extract<
      HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
      { type: 'rendered' }
    >['payload']
  ) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    if (!payload.ready) {
      displayReady.value = false
      clearGridCanvas()
      return
    }
    displayStartSec.value = payload.rangeStartSec
    displayReady.value = true
  }

  const queueLiveWaveformRender = (payload: {
    rangeStartSec: number
    rangeDurationSec: number
    rawData: RawWaveformData | null
    maxSamplesPerPixel: number
    allowScrollReuse: boolean
    preferRawPeaksOnly: boolean
    dirtyStartSec?: number
    dirtyEndSec?: number
  }) => {
    const wrap = wrapRef.value
    if (!wrap || !ensureLiveCanvasMounted()) return false
    const renderToken = liveCanvasRenderToken + 1
    liveCanvasRenderToken = renderToken
    liveCanvasBridge.render({
      renderToken,
      width: Math.max(1, Math.floor(wrap.clientWidth)),
      height: Math.max(1, Math.floor(wrap.clientHeight)),
      pixelRatio: window.devicePixelRatio || 1,
      bpm: Number(options.previewBpm.value) || 0,
      firstBeatMs: Number(options.previewFirstBeatMs.value) || 0,
      barBeatOffset: Number(options.previewBarBeatOffset.value) || 0,
      timeBasisOffsetMs: Number(options.previewTimeBasisOffsetMs.value) || 0,
      rangeStartSec: payload.rangeStartSec,
      rangeDurationSec: payload.rangeDurationSec,
      maxSamplesPerPixel: payload.maxSamplesPerPixel,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid: Number(options.previewBpm.value) > 0,
      allowScrollReuse: payload.allowScrollReuse,
      phaseAwareScrollReuse: payload.allowScrollReuse,
      waveformLayout: resolveWaveformLayout(),
      preferRawPeaksOnly: payload.preferRawPeaksOnly,
      themeVariant: resolveHorizontalBrowseWaveformThemeVariant(),
      rawSlot: resolveRawSlotForRender(payload.rawData),
      direction: options.direction(),
      cueSeconds: Number.isFinite(Number(options.cueSeconds()))
        ? Number(options.cueSeconds())
        : null,
      hotCues: normalizeSongHotCues(options.hotCues()),
      memoryCues: normalizeSongMemoryCues(options.memoryCues()),
      loopRange: resolveWorkerLoopRange(),
      cueAccentColor: resolveCueAccentColor(),
      playbackActive: options.playing.value && !options.dragging.value,
      playbackSeconds: Math.max(0, Number(options.currentSeconds()) || 0),
      playbackSyncRevision: Math.max(
        0,
        Math.floor(Number(options.playbackSyncRevision.value) || 0)
      ),
      playbackRate: Math.max(0.25, Number(options.playbackRate()) || 1),
      playbackDurationSec: resolvePreviewDurationSec(),
      dirtyStartSec: payload.dirtyStartSec,
      dirtyEndSec: payload.dirtyEndSec
    })
    return true
  }

  const resolveTimeBasisOffsetSec = () =>
    Math.max(0, Number(options.previewTimeBasisOffsetMs.value) || 0) / 1000

  const resolveRawDataStartSec = (rawData: RawWaveformData | null) => {
    if (!rawData) return 0
    return Math.max(0, Number(rawData.startSec) || 0) + resolveTimeBasisOffsetSec()
  }

  const resolveRawDataCoverageStartSec = (rawData: RawWaveformData | null) => {
    if (!rawData) return 0
    const audioStartSec = Math.max(0, Number(rawData.startSec) || 0)
    if (audioStartSec <= 0.0001) return 0
    return resolveRawDataStartSec(rawData)
  }

  const resolveRawDataCoveredEndSec = (rawData: RawWaveformData | null) => {
    if (!rawData) return 0
    const startSec = resolveRawDataStartSec(rawData)
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
    const rawStartSec = resolveRawDataCoverageStartSec(rawData)
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
    const rawStartSec = resolveRawDataCoverageStartSec(rawData)
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

  const invalidateWaveformTiles = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
  }

  const storeRawWaveform = (filePath: string, data: RawWaveformData) => {
    void filePath
    void data
  }

  const drawWaveform = () => {
    const wrap = wrapRef.value
    const waveformCanvas = waveformCanvasRef.value
    if (!wrap || !waveformCanvas) return

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      traceHorizontalWaveformRender('none')
      clearCanvas()
      displayReady.value = false
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const wasDisplayReady = displayReady.value
    const playbackStreamReuse = options.playing.value && !options.dragging.value
    const allowPlaybackScrollReuse =
      playbackStreamReuse && wasDisplayReady && !suppressNextPlaybackScrollReuse
    const deferredVisualProtection = resolveDeferredVisualProtection()
    const streamMaxSamplesPerPixel = playbackStreamReuse
      ? PREVIEW_MAX_SAMPLES_PER_PIXEL
      : deferredVisualProtection
        ? DEFERRED_RAW_MAX_SAMPLES_PER_PIXEL
        : DRAG_RAW_MAX_SAMPLES_PER_PIXEL
    const currentFilePath = String(options.song()?.filePath || '').trim()
    const activeMixxxSelection = resolveActiveMixxxSelection()
    const canUseRetainedWaveform =
      options.rawStreamActive.value &&
      !!currentFilePath &&
      currentFilePath === retainedWaveformFilePath &&
      !!retainedRawData

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

    if (!effectiveMixxxData && !drawableRawData) {
      traceHorizontalWaveformRender('empty', {
        mixxxSource: effectiveMixxxSelection.source,
        effectiveRawCoverage,
        holdingFrame: holdPreviousWaveformFrame
      })
      clearWaveformCanvas()
      lastStreamRenderedRawData = null
      // 完全无数据可画：通知 DOM 层也整块隐藏，避免只剩 grid/cue 悬在那里。
      displayReady.value = false
    } else if (options.playing.value || options.rawStreamActive.value || options.dragging.value) {
      // 判断是否可以把当前这帧交给 live canvas worker 绘制：
      //   * effectiveRawCoverage=true（rawData 严格覆盖可视区）：无论 worker 走 scroll reuse
      //     还是 clearRect+drawRange 都能得到完整波形，安全。
      //   * rawDataRefStable=true（rawData 对象引用与上一帧一致）：
      //     worker 走 scroll reuse：复用当前 canvas 像素 +
      //     只重绘右边缘 shift 出来的一小段。即使 rawData 末尾几帧数据还没填入，右边缘最多
      //     短暂画成平线，左边旧波形像素会被保留——波形主体跟 playback 同步滚动。
      //   * allowPartialFirstPaint=true：首屏尚未 ready、且不是 seek-hold 场景时，允许用
      //     当前已到达的 partial rawData 先画出可见部分。这样 deck 初次载入时不会整块空白
      //     到第二个 chunk 才出现波形；后续 chunk 再通过 dirty draw 把右侧补齐。
      //   * 以上都不满足（rawData 新换 ref 且尚未覆盖可视区）：draw 会走 clearRect+drawRange，
      //     用稀疏数据整屏重画，导致大片空白（历史"波形消失只剩网格线"bug）。必须放弃绘制，
      //     保留 canvas 现状，等下一次 ensureRawWaveformCapacity 填充或同一 ref 稳定后再画。
      const rawDataRefStable =
        drawableRawData != null && drawableRawData === lastStreamRenderedRawData
      const allowPartialFirstPaint =
        Boolean(drawableRawData) && !wasDisplayReady && !holdPreviousWaveformFrame
      const canDrawStream =
        Boolean(drawableRawData) &&
        (effectiveRawCoverage || rawDataRefStable || allowPartialFirstPaint)
      if (!canDrawStream) {
        traceHorizontalWaveformRender(
          holdPreviousWaveformFrame ? 'stream-hold' : 'stream-await-raw',
          {
            mixxxSource: effectiveMixxxSelection.source,
            effectiveRawCoverage,
            rawDataRefStable,
            allowPartialFirstPaint,
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
          lastStreamRenderedRawData = null
          displayReady.value = false
        }
        // 非 seek：保留 canvas 现有内容，并且 **不** 更新 displayStartSec / displayReady，
        // grid / cue / hotcue 等 DOM 层也保持上一帧的位置——整块画面同步"冻结"在上次成功
        // 绘制出的位置，杜绝"grid 在动、波形停"这种错位感。等下一帧能画出来时再统一推进。
      } else {
        holdPreviousWaveformFrame = false
        const shouldSuppressNextPlaybackScrollReuse = playbackStreamReuse && !wasDisplayReady
        traceHorizontalWaveformRender('stream-live', {
          mixxxSource: effectiveMixxxSelection.source,
          effectiveRawCoverage,
          rawDataRefStable,
          allowPartialFirstPaint,
          holdingFrame: false
        })
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:stream-live:${options.direction()}`
        )
        const queued = queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: drawableRawData,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          allowScrollReuse: allowPlaybackScrollReuse,
          preferRawPeaksOnly: false
        })
        if (queued) {
          lastStreamRenderedRawData = drawableRawData
          commitRetainedFromDrawn()
        }
        suppressNextPlaybackScrollReuse = shouldSuppressNextPlaybackScrollReuse
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
      holdPreviousWaveformFrame = false
      const shouldSuppressNextPlaybackScrollReuse = playbackStreamReuse && !wasDisplayReady
      traceHorizontalWaveformRender('worker-live', {
        mixxxSource: effectiveMixxxSelection.source,
        effectiveRawCoverage,
        holdingFrame: false
      })
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:worker-live:${options.direction()}`
      )
      const queued = queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: drawableRawData,
        maxSamplesPerPixel: streamMaxSamplesPerPixel,
        allowScrollReuse: allowPlaybackScrollReuse,
        preferRawPeaksOnly: false
      })
      if (queued) {
        lastStreamRenderedRawData = drawableRawData
        commitRetainedFromDrawn()
      }
      suppressNextPlaybackScrollReuse = shouldSuppressNextPlaybackScrollReuse
      finishTiming()
    }
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
    nextAllowedStreamDrawAt =
      performance.now() +
      (resolveDeferredVisualProtection()
        ? DEFERRED_RAW_STREAM_REDRAW_INTERVAL_MS
        : RAW_STREAM_REDRAW_INTERVAL_MS)

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
    const renderStartSec = resolvePlaybackDrivenRenderStartSec(visibleDuration)
    traceHorizontalWaveformRender('stream-dirty')
    const finishTiming = startHorizontalBrowseUserTiming(
      `frkb:hb:canvas:stream-dirty:${options.direction()}`
    )

    queueLiveWaveformRender({
      rangeStartSec: renderStartSec,
      rangeDurationSec: visibleDuration,
      rawData: options.rawData.value,
      maxSamplesPerPixel: DRAG_RAW_MAX_SAMPLES_PER_PIXEL,
      allowScrollReuse: true,
      preferRawPeaksOnly: false,
      dirtyStartSec,
      dirtyEndSec
    })
    finishTiming()
  }

  const scheduleRawStreamDirtyDraw = (dirtyStartSec: number, dirtyEndSec: number) => {
    if (options.playing.value) {
      if (!displayReady.value) {
        scheduleDraw()
      }
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
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      drawWaveform()
    })
  }

  const scheduleGridOverlayDraw = () => {
    scheduleDraw()
  }

  const resetGridRenderer = () => {
    clearGridCanvas()
  }

  const mountWaveformCanvasWorker = () => {
    ensureLiveCanvasMounted()
  }

  const resetLiveWaveformRaw = (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => {
    liveCanvasBridge.resetRaw(meta)
  }

  const ensureLiveWaveformRawCapacity = (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => {
    liveCanvasBridge.ensureRawCapacity(meta)
  }

  const applyLiveWaveformRawChunk = (
    chunk: HorizontalBrowseDetailLiveCanvasRawChunk,
    transferOwnership = false
  ) => {
    liveCanvasBridge.applyRawChunk(chunk, transferOwnership)
  }

  const replaceLiveWaveformRaw = (data: RawWaveformData | null) => {
    liveCanvasBridge.replaceRaw(data)
  }

  const updateLiveWaveformRawMeta = (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => {
    liveCanvasBridge.updateRawMeta(meta)
  }

  const dispose = () => {
    clearStreamDrawScheduling()
    resetRetainedWaveformData()
    liveCanvasAttached = false
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    liveCanvasBridge.dispose()
  }

  return {
    wrapRef,
    waveformCanvasRef,
    gridCanvasRef,
    overlayCanvasRef,
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
    mountWaveformCanvasWorker,
    scheduleDraw,
    scheduleGridOverlayDraw,
    resetGridRenderer,
    holdCurrentWaveformFrame,
    resetRetainedWaveformData,
    resetLiveWaveformRaw,
    ensureLiveWaveformRawCapacity,
    applyLiveWaveformRawChunk,
    replaceLiveWaveformRaw,
    updateLiveWaveformRawMeta,
    storeRawWaveform,
    setLastZoomAnchor,
    resetLastZoomAnchor,
    displayStartSec,
    displayReady,
    dispose
  }
}
