<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/components/horizontalBrowseWaveform.constants'
import {
  useHorizontalBrowseGridToolbar,
  type HorizontalBrowseGridToolbarState
} from '@renderer/components/useHorizontalBrowseGridToolbar'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import { useMixtapeBeatAlignMetronome } from '@renderer/components/mixtapeBeatAlignMetronome'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BAR_LINE_HIT_RADIUS_PX,
  PREVIEW_BPM_TAP_RESET_MS,
  clampNumber,
  normalizeBeatOffset,
  normalizePreviewBpm
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { useHorizontalBrowseRawWaveformCanvas } from '@renderer/components/useHorizontalBrowseRawWaveformCanvas'
import { useHorizontalBrowseRawWaveformStream } from '@renderer/components/useHorizontalBrowseRawWaveformStream'
import { HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC } from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'
import { resolveHorizontalBrowseEffectiveTimelineEndSec } from '@renderer/components/horizontalBrowseRawWaveformTimeline'
import {
  useHorizontalBrowseWaveformScrubPreview,
  type HorizontalBrowseScrubPreviewPayload
} from '@renderer/components/useHorizontalBrowseWaveformScrubPreview'
import type {
  HorizontalBrowseDragSessionEndPayload,
  HorizontalBrowseLoopRange,
  HorizontalBrowseRawWaveformDetailExpose,
  HorizontalBrowseSharedZoomState,
  HorizontalBrowseWaveformLayout,
  HorizontalBrowseWaveformRenderStyle
} from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import { buildHorizontalBrowseRawWaveformGridSignature } from '@renderer/components/horizontalBrowseRawWaveformGridSignature'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'

const props = defineProps<{
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoomState?: HorizontalBrowseSharedZoomState
  currentSeconds?: number
  playing?: boolean
  playbackActive?: boolean
  playbackRate?: number
  visualPlaybackRate?: number
  waveformGain?: number
  playbackSyncRevision?: number
  gridBpm?: number
  loopRange?: HorizontalBrowseLoopRange | null
  cueSeconds?: number
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
  deferWaveformLoad?: boolean
  rawLoadPriorityHint?: number
  seekTargetSeconds?: number
  seekRevision?: number
  maxZoom?: number
  waveformLayout?: HorizontalBrowseWaveformLayout
  waveformRenderStyle?: HorizontalBrowseWaveformRenderStyle
  allowNegativeTimeline?: boolean
}>()

const emit = defineEmits<{
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (
    event: 'zoom-change',
    value: { value: number; anchorRatio: number; sourceDirection: 'up' | 'down' }
  ): void
  (event: 'drag-session-start'): void
  (event: 'drag-session-preview', value: HorizontalBrowseScrubPreviewPayload): void
  (event: 'drag-session-end', value: HorizontalBrowseDragSessionEndPayload): void
}>()

const runtime = useRuntimeStore()
const rawData = ref<RawWaveformData | null>(null)
const mixxxData = ref<MixxxWaveformData | null>(null)
const previewLoading = ref(false)
const previewStartSec = ref(0)
const dragging = ref(false)
const previewBarBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewTimeBasisOffsetMs = ref(0)
const previewBpm = ref(0)
const previewBpmInput = ref('')
const bpmTapTimestamps = ref<number[]>([])
const previewZoom = ref(HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
const rawStreamActive = ref(false)
const previewPlaying = ref(false)
const localGridShiftPhaseOffsetSec = ref(0)
const playbackSyncRevision = computed(() =>
  Math.max(0, Math.floor(Number(props.playbackSyncRevision) || 0))
)
const waveformPlaybackActive = computed(() => Boolean(props.playbackActive ?? props.playing))
const previewMaxZoom = computed(() => {
  const value = Number(props.maxZoom)
  return Number.isFinite(value) && value > HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
    ? value
    : HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM
})
const deferredWaveformLoad = computed(
  () => Boolean(props.deferWaveformLoad) && !previewPlaying.value
)
const resolveWaveformLayout = () =>
  props.waveformLayout === 'full' ? 'full' : props.direction === 'up' ? 'top-half' : 'bottom-half'

const resolveWaveformRenderStyle = () =>
  props.waveformRenderStyle === 'raw-curve' ? 'raw-curve' : 'columns'

const resolveWaveformCurrentSeconds = () =>
  normalizePreviewTimelineSeconds(
    (Number(props.currentSeconds) || 0) + localGridShiftPhaseOffsetSec.value
  )

const HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MIN_MS = 4
const HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MIN_MS = 10
const HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_PX = 1
const HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_PX = 2.5
const HORIZONTAL_BROWSE_BOOTSTRAP_OVERSCAN = 8
const HORIZONTAL_BROWSE_DEFERRED_BOOTSTRAP_OVERSCAN = 1.5
const HORIZONTAL_BROWSE_PLAYBACK_RESYNC_THRESHOLD_SEC = 0.04
const HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON = 0.0005

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let dragStartClientX = 0
let dragStartSec = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
let pendingLocalGridSignature = ''
let lastPlaybackPositionSample: {
  songKey: string
  seconds: number
  atMs: number
  playbackRate: number
  playing: boolean
} | null = null

const resolveDisplayGridBpm = () =>
  Number.isFinite(Number(props.song?.bpm)) && Number(props.song?.bpm) > 0
    ? normalizePreviewBpm(Number(props.song?.bpm))
    : 0

const previewRenderBpm = computed(() => {
  const localBpm = Number(previewBpm.value)
  if (
    Number.isFinite(localBpm) &&
    localBpm > 0 &&
    Math.abs(localBpm - resolveDisplayGridBpm()) > HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON
  ) {
    return normalizePreviewBpm(localBpm)
  }
  const gridBpm = Number(props.gridBpm)
  if (Number.isFinite(gridBpm) && gridBpm > 0) {
    return normalizePreviewBpm(gridBpm)
  }
  return localBpm || 0
})

const {
  wrapRef,
  waveformCanvasRef,
  gridCanvasRef,
  overlayCanvasRef,
  resolvePreviewTimeScale,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  scheduleRawStreamDirtyDraw,
  scheduleRawStreamCoverageDraw,
  resetRawStreamDrawState,
  clearStreamDrawScheduling,
  clearCanvas,
  invalidateWaveformTiles,
  mountWaveformCanvasWorker,
  scheduleDraw,
  scheduleGridOverlayDraw,
  resetGridRenderer,
  holdCurrentWaveformFrame,
  beginSeekWaveformTransition,
  resetRetainedWaveformData,
  resetLiveWaveformRaw,
  ensureLiveWaveformRawCapacity,
  applyLiveWaveformRawChunk,
  replaceLiveWaveformRaw,
  updateLiveWaveformRawMeta,
  storeRawWaveform,
  displayReady,
  dispose: disposeWaveformCanvas
} = useHorizontalBrowseRawWaveformCanvas({
  song: () => props.song,
  direction: () => props.direction,
  deferWaveformLoad: deferredWaveformLoad,
  cueSeconds: () => props.cueSeconds,
  hotCues: () => props.hotCues,
  memoryCues: () => props.memoryCues,
  loopRange: () => props.loopRange,
  currentSeconds: resolveWaveformCurrentSeconds,
  playbackRate: () => props.playbackRate,
  visualPlaybackRate: () => props.visualPlaybackRate,
  waveformGain: () => props.waveformGain,
  playing: previewPlaying,
  playbackSyncRevision,
  rawData,
  mixxxData,
  previewStartSec,
  previewZoom,
  previewBpm: previewRenderBpm,
  previewFirstBeatMs,
  previewBarBeatOffset,
  previewTimeBasisOffsetMs,
  dragging,
  rawStreamActive,
  allowNegativeTimeline: () => Boolean(props.allowNegativeTimeline),
  waveformLayout: resolveWaveformLayout,
  waveformRenderStyle: resolveWaveformRenderStyle,
  phaseAwareScrollReuse: () => Math.abs(localGridShiftPhaseOffsetSec.value) > 0.000001
})
const applyLocalGridShiftPhaseCompensation = (deltaMs: number) => {
  const deltaSec = Number(deltaMs) / 1000
  if (!Number.isFinite(deltaSec) || Math.abs(deltaSec) <= 0) return
  localGridShiftPhaseOffsetSec.value += deltaSec
  if (!previewPlaying.value || dragging.value) {
    const compensatedSeconds = resolveWaveformCurrentSeconds()
    previewStartSec.value = resolvePlaybackAlignedStart(compensatedSeconds)
  }
}
const scrubPreview = useHorizontalBrowseWaveformScrubPreview({
  dragging,
  resolveAnchorSec: resolvePreviewAnchorSec,
  emitPreview: (payload) => emit('drag-session-preview', payload)
})
const resolveGridShiftMs = (targetPx: number, minMs: number) => {
  const visibleDurationMs = Math.max(1, resolveVisibleDurationSec() * 1000)
  const wrapWidth = Math.max(1, Number(wrapRef.value?.clientWidth || 0))
  const msPerPixel = visibleDurationMs / wrapWidth
  return Math.max(minMs, Math.round(msPerPixel * targetPx))
}

const normalizeSharedZoom = (value: unknown) => {
  const numeric =
    typeof value === 'object' && value !== null && 'value' in value
      ? Number((value as { value?: unknown }).value)
      : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
  return clampNumber(numeric, HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM, previewMaxZoom.value)
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

const buildPreviewGridSignature = () =>
  buildHorizontalBrowseRawWaveformGridSignature({
    bpm: previewBpm.value,
    firstBeatMs: previewFirstBeatMs.value,
    barBeatOffset: previewBarBeatOffset.value,
    timeBasisOffsetMs: previewTimeBasisOffsetMs.value
  })

const buildSongGridSignature = () =>
  buildHorizontalBrowseRawWaveformGridSignature({
    bpm: props.song?.bpm,
    firstBeatMs: props.song?.firstBeatMs,
    barBeatOffset: props.song?.barBeatOffset,
    timeBasisOffsetMs: props.song?.timeBasisOffsetMs
  })

function resolveEffectiveTimelineEndSec() {
  return resolveHorizontalBrowseEffectiveTimelineEndSec({
    rawData: rawData.value,
    durationSec: resolvePreviewDurationSec(),
    timeBasisOffsetMs: previewTimeBasisOffsetMs.value,
    tailToleranceSec: HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC
  })
}

function normalizePreviewTimelineSeconds(seconds: number) {
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric)) return 0
  const duration = resolveEffectiveTimelineEndSec()
  if (duration > 0) {
    return props.allowNegativeTimeline
      ? Math.min(numeric, duration)
      : clampNumber(numeric, 0, duration)
  }
  return props.allowNegativeTimeline ? numeric : Math.max(0, numeric)
}

const applyPreviewPlaybackPosition = (seconds: number, scheduleFrame = true) => {
  const safeSeconds = normalizePreviewTimelineSeconds(seconds)
  const nextStartSec = resolvePlaybackAlignedStart(safeSeconds)
  const changed = Math.abs(nextStartSec - previewStartSec.value) > 0.0001
  if (changed) {
    previewStartSec.value = nextStartSec
  }
  if (scheduleFrame) {
    scheduleDraw()
  }
}

const resolvePlaybackPositionDiscontinuity = (
  songKey: string,
  seconds: number,
  playing: boolean
) => {
  const nowMs = performance.now()
  const playbackRate = Math.max(0.25, Number(props.playbackRate) || 1)
  const previous = lastPlaybackPositionSample
  lastPlaybackPositionSample = {
    songKey,
    seconds,
    atMs: nowMs,
    playbackRate,
    playing
  }

  if (!playing || !previous?.playing || previous.songKey !== songKey) return false
  const elapsedSec = Math.max(0, nowMs - previous.atMs) / 1000
  const expectedSeconds = previous.seconds + elapsedSec * previous.playbackRate
  const boundedExpectedSeconds = normalizePreviewTimelineSeconds(expectedSeconds)
  return (
    Math.abs(seconds - boundedExpectedSeconds) > HORIZONTAL_BROWSE_PLAYBACK_RESYNC_THRESHOLD_SEC
  )
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
  pendingLocalGridSignature = buildPreviewGridSignature()
  const firstBeatMs = Number(previewFirstBeatMs.value)
  const payload = {
    filePath,
    bpm: Number(previewBpm.value) || 0,
    firstBeatMs: Number.isFinite(firstBeatMs) ? firstBeatMs : 0,
    barBeatOffset: normalizeBeatOffset(previewBarBeatOffset.value, PREVIEW_BAR_BEAT_INTERVAL)
  }
  try {
    await window.electron.ipcRenderer.invoke('mixtape:update-grid-definition', payload)
  } catch (error) {
    console.error('[horizontal-browse] persist grid definition failed', error)
  }
}

const schedulePersistGridDefinition = () => {
  clearPersistTimer()
  pendingLocalGridSignature = buildPreviewGridSignature()
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistGridDefinition()
  }, 120)
}

const stopDragging = (commitPlayhead = false) => {
  if (!dragging.value) return
  const finalAnchorSec = resolvePreviewAnchorSec()
  dragging.value = false
  scrubPreview.stop()
  window.removeEventListener('mousemove', handleDragMove)
  window.removeEventListener('mouseup', handleWindowMouseUp)
  emit('drag-session-end', {
    anchorSec: finalAnchorSec,
    committed: commitPlayhead && Boolean(props.song)
  })
}

const handleWindowMouseUp = (event: MouseEvent) => {
  handleDragMove(event)
  stopDragging(true)
}

function handleDragMove(event: MouseEvent) {
  if (!dragging.value) return
  const wrap = wrapRef.value
  if (!wrap) return
  const visibleDuration = resolveVisibleDurationSec()
  if (!visibleDuration) return
  const deltaX = event.clientX - dragStartClientX
  const deltaSec = (deltaX / Math.max(1, wrap.clientWidth)) * visibleDuration
  previewStartSec.value = clampPreviewStart(dragStartSec - deltaSec)
  const anchorSec = resolvePreviewAnchorSec()
  maybeContinueRawWaveformStream(anchorSec)
  scrubPreview.update(anchorSec)
  scheduleDraw()
}

const handleMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) return
  if (!props.song?.filePath || !resolvePreviewDurationSec()) return
  if (handlePreviewMouseDownForBarLinePicking(event)) {
    emitToolbarState()
    schedulePersistGridDefinition()
    return
  }
  dragging.value = true
  dragStartClientX = event.clientX
  dragStartSec = previewStartSec.value
  const anchorSec = resolvePreviewAnchorSec()
  emit('drag-session-start')
  scrubPreview.start(anchorSec)
  maybeContinueRawWaveformStream(anchorSec)
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
    previewMaxZoom.value
  )
  if (Math.abs(nextZoom - previewZoom.value) <= 0.000001) return

  previewZoom.value = nextZoom
  const nextVisible = resolveVisibleDurationSec()
  previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * ratio)
  emit('zoom-change', {
    value: previewZoom.value,
    anchorRatio: ratio,
    sourceDirection: props.direction
  })
  maybeContinueRawWaveformStream(resolvePreviewAnchorSec())
  scheduleDraw()
}

const canAdjustGrid = computed(() => {
  if (previewLoading.value) return false
  return !!props.song?.filePath && resolvePreviewDurationSec() > 0
})
const previewFirstBeatMsComputed = computed(() => Number(previewFirstBeatMs.value) || 0)
const metronomePlaybackRate = computed(() => Math.max(0.25, Number(props.playbackRate) || 1))
const metronomeResetKey = computed(
  () => `${String(props.song?.filePath || '')}:${Number(props.seekRevision) || 0}`
)
const resolveNativeMetronomeDeck = () => (props.direction === 'up' ? 'top' : 'bottom')
const syncNativeMetronomeState = (state: { enabled: boolean; volumeLevel: 1 | 2 | 3 }) => {
  void window.electron.ipcRenderer
    .invoke(
      'horizontal-browse-transport:set-metronome',
      resolveNativeMetronomeDeck(),
      state.enabled,
      state.volumeLevel
    )
    .catch((error) => {
      console.error('[horizontal-browse-metronome] sync native state failed', error)
    })
}
const detailVisible = computed(() => true)

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
  canAdjustGrid,
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
  schedulePreviewDraw: scheduleGridOverlayDraw,
  applyPlaybackPhaseCompensation: applyLocalGridShiftPhaseCompensation,
  barBeatInterval: PREVIEW_BAR_BEAT_INTERVAL,
  barLineHitRadiusPx: PREVIEW_BAR_LINE_HIT_RADIUS_PX
})

const {
  metronomeEnabled,
  metronomeVolumeLevel,
  metronomeSupported,
  cycleMetronomeState: cycleMetronomeRuntimeState
} = useMixtapeBeatAlignMetronome({
  dialogVisible: detailVisible,
  previewPlaying,
  bpm: previewBpm,
  firstBeatMs: previewFirstBeatMsComputed,
  playbackRate: metronomePlaybackRate,
  resetKey: metronomeResetKey,
  outputMode: 'external',
  syncExternalState: syncNativeMetronomeState,
  resolveAnchorSec: () => Math.max(0, Number(props.currentSeconds) || 0)
})

const canToggleMetronome = computed(() => canAdjustGrid.value && metronomeSupported.value)

const {
  emitToolbarState,
  syncGridStateFromSong,
  handlePreviewBpmInputUpdate,
  handlePreviewBpmInputBlur,
  handlePreviewBpmTap,
  toggleBarLinePicking,
  setBarLineAtPlayhead,
  shiftGrid,
  cycleMetronomeState
} = useHorizontalBrowseGridToolbar({
  canAdjustGrid,
  previewLoading,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewBarBeatOffset,
  previewTimeBasisOffsetMs,
  bpmTapTimestamps,
  previewBarLinePicking,
  metronomeEnabled,
  metronomeVolumeLevel,
  canToggleMetronome,
  emitToolbarStateChange: (value) => emit('toolbar-state-change', value),
  resolveDisplayGridBpm,
  resolveSongFirstBeatMs: () => Number(props.song?.firstBeatMs) || 0,
  resolveSongBarBeatOffset: () => Number(props.song?.barBeatOffset) || 0,
  resolveSongTimeBasisOffsetMs: () => Number(props.song?.timeBasisOffsetMs) || 0,
  scheduleDraw: scheduleGridOverlayDraw,
  schedulePreviewBpmTapReset,
  persistGridDefinition,
  schedulePersistGridDefinition,
  resetPreviewBpmTap,
  resetBarLinePicking,
  handleBarLinePickingToggle,
  handleSetBarLineAtPlayhead,
  handleGridShift,
  handleMetronomeStateCycle: cycleMetronomeRuntimeState
})

const {
  resolveWaveformTargetRate,
  cancelRawWaveformStream,
  beginRawWaveformStream,
  maybeContinueRawWaveformStream,
  restartRawWaveformStreamAt,
  flushDeferredRawWaveformStore,
  handleRawLoadPriorityHintChange,
  mount: mountRawWaveformStream,
  dispose: disposeRawWaveformStream
} = useHorizontalBrowseRawWaveformStream({
  song: () => props.song,
  direction: () => props.direction,
  deferWaveformLoad: () => deferredWaveformLoad.value,
  rawLoadPriorityHint: () => props.rawLoadPriorityHint,
  bootstrapDurationSec: () =>
    Math.max(
      deferredWaveformLoad.value ? 1.5 : 4,
      resolveVisibleDurationSec() *
        (deferredWaveformLoad.value
          ? HORIZONTAL_BROWSE_DEFERRED_BOOTSTRAP_OVERSCAN
          : HORIZONTAL_BROWSE_BOOTSTRAP_OVERSCAN)
    ),
  timeBasisOffsetMs: () => Number(previewTimeBasisOffsetMs.value) || 0,
  playing: () => previewPlaying.value,
  currentSeconds: resolveWaveformCurrentSeconds,
  viewportAnchorSec: resolvePreviewAnchorSec,
  visibleDurationSec: resolveVisibleDurationSec,
  previewLoading,
  rawStreamActive,
  rawData,
  mixxxData,
  clearStreamDrawScheduling,
  scheduleRawStreamDirtyDraw,
  scheduleRawStreamCoverageDraw,
  resetRawStreamDrawState,
  scheduleDraw,
  holdCurrentWaveformFrame,
  storeRawWaveform,
  resetLiveWaveformRaw,
  ensureLiveWaveformRawCapacity,
  applyLiveWaveformRawChunk,
  replaceLiveWaveformRaw,
  updateLiveWaveformRawMeta
})

mountRawWaveformStream()

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  pendingLocalGridSignature = ''

  clearPersistTimer()
  clearStreamDrawScheduling()
  cancelRawWaveformStream()
  invalidateWaveformTiles()
  previewLoading.value = false
  rawStreamActive.value = false
  rawData.value = null
  mixxxData.value = null
  previewStartSec.value = 0
  resetRetainedWaveformData()
  resetGridRenderer()
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSong()
    return
  }

  try {
    previewLoading.value = true
    const targetRate = resolveWaveformTargetRate(!!props.deferWaveformLoad)
    beginRawWaveformStream(filePath, targetRate, currentToken)
    syncGridStateFromSong()
    previewStartSec.value = resolvePlaybackAlignedStart(0)
    scheduleDraw()
  } catch {
    if (currentToken !== loadToken) return
    previewLoading.value = false
    rawStreamActive.value = false
    rawData.value = null
    mixxxData.value = null
    resetGridRenderer()
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
    [
      props.song?.bpm,
      props.song?.firstBeatMs,
      props.song?.barBeatOffset,
      props.song?.timeBasisOffsetMs
    ] as const,
  () => {
    const songGridSignature = buildSongGridSignature()
    if (pendingLocalGridSignature) {
      if (songGridSignature !== pendingLocalGridSignature) {
        return
      }
      pendingLocalGridSignature = ''
    }
    syncGridStateFromSong()
    scheduleGridOverlayDraw()
  }
)

watch(
  () =>
    [
      Number(props.cueSeconds) || 0,
      props.loopRange?.startSec ?? null,
      props.loopRange?.endSec ?? null
    ] as const,
  () => {
    scheduleDraw()
  }
)

watch(
  () => props.hotCues,
  () => {
    scheduleDraw()
  },
  { deep: true }
)

watch(
  () => props.memoryCues,
  () => {
    scheduleDraw()
  },
  { deep: true }
)

watch(
  () => props.direction,
  () => {
    invalidateWaveformTiles()
    resetGridRenderer()
    scheduleDraw()
  }
)

watch(
  () => resolvePreviewTimeScale(),
  () => {
    invalidateWaveformTiles()
    resetGridRenderer()
    scheduleDraw()
  }
)

watch(
  () => {
    const numeric = Number(props.waveformGain)
    if (!Number.isFinite(numeric)) return 1
    return clampNumber(numeric, 0, 16)
  },
  () => {
    invalidateWaveformTiles()
    scheduleDraw()
  }
)

watch(
  () => !!props.deferWaveformLoad,
  (deferred, previous) => {
    if (!previous || deferred) return
    if (!props.song?.filePath) return
    const currentRate = Number(rawData.value?.rate) || 0
    if (rawData.value && currentRate >= resolveWaveformTargetRate(false)) return
    void loadWaveform()
  }
)

watch(
  () => Math.max(0, Math.floor(Number(props.rawLoadPriorityHint) || 0)),
  (priorityHint, previousPriorityHint) => {
    handleRawLoadPriorityHintChange(priorityHint, previousPriorityHint)
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
    previewZoom.value = nextZoom
    const nextVisible = resolveVisibleDurationSec()
    previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * anchorRatio)
    resetGridRenderer()
    maybeContinueRawWaveformStream(resolvePreviewAnchorSec())
    scheduleDraw()
  },
  { immediate: true }
)

watch(
  () => waveformPlaybackActive.value,
  (playing) => {
    previewPlaying.value = playing
    if (!playing) {
      const anchorSec = resolveWaveformCurrentSeconds()
      applyPreviewPlaybackPosition(anchorSec, false)
      flushDeferredRawWaveformStore()
      maybeContinueRawWaveformStream(anchorSec)
    }
  },
  { immediate: true }
)

watch(
  () =>
    [
      Number(props.currentSeconds) || 0,
      waveformPlaybackActive.value,
      props.song?.filePath ?? '',
      playbackSyncRevision.value
    ] as const,
  ([seconds, playing, songKey, syncRevision], previousValue) => {
    const finishTiming = startHorizontalBrowseUserTiming(
      `frkb:hb:detail:current-seconds:${props.direction}`
    )
    try {
      if (dragging.value) return
      const safeSongKey = String(songKey || '').trim()
      const safeSeconds = normalizePreviewTimelineSeconds(seconds)
      maybeContinueRawWaveformStream(safeSeconds)
      if (!safeSongKey) {
        lastPlaybackPositionSample = null
        applyPreviewPlaybackPosition(0)
        return
      }
      const playbackPositionJumped = resolvePlaybackPositionDiscontinuity(
        safeSongKey,
        safeSeconds,
        playing
      )
      const previousPlaying = Boolean(previousValue?.[1])
      const previousSongKey = String(previousValue?.[2] || '').trim()
      const previousSyncRevision = Math.max(0, Math.floor(Number(previousValue?.[3]) || 0))
      const playbackSyncChanged = syncRevision !== previousSyncRevision
      if (playbackSyncChanged || safeSongKey !== previousSongKey) {
        localGridShiftPhaseOffsetSec.value = 0
      }
      const shouldScheduleFrame =
        !playing ||
        dragging.value ||
        playing !== previousPlaying ||
        safeSongKey !== previousSongKey ||
        playbackSyncChanged ||
        playbackPositionJumped
      applyPreviewPlaybackPosition(safeSeconds, shouldScheduleFrame)
    } finally {
      finishTiming()
    }
  }
)

watch(
  () => [Number(props.seekRevision) || 0, Number(props.seekTargetSeconds) || 0] as const,
  ([revision, targetSeconds]) => {
    if (!revision) return
    if (!props.song?.filePath) return
    const safeTargetSeconds = normalizePreviewTimelineSeconds(targetSeconds)
    beginSeekWaveformTransition(safeTargetSeconds)
    restartRawWaveformStreamAt(safeTargetSeconds, true, {
      preserveDisplay: true,
      preferFastInitialCoverage: true
    })
    applyPreviewPlaybackPosition(safeTargetSeconds, true)
  }
)

watch(
  () => canAdjustGrid.value,
  () => {
    emitToolbarState()
  }
)

watch(
  () =>
    [
      previewBpm.value,
      previewRenderBpm.value,
      previewFirstBeatMs.value,
      previewBarBeatOffset.value,
      previewTimeBasisOffsetMs.value
    ] as const,
  () => {
    scheduleGridOverlayDraw()
    emitToolbarState()
  }
)

watch(
  () => [metronomeEnabled.value, metronomeVolumeLevel.value, canToggleMetronome.value] as const,
  () => {
    emitToolbarState()
  }
)

watch(
  () => runtime.setting?.themeMode,
  () => {
    invalidateWaveformTiles()
    resetGridRenderer()
    scheduleDraw()
  }
)

onMounted(() => {
  mountWaveformCanvasWorker()
  if (wrapRef.value) {
    resizeObserver = new ResizeObserver(() => {
      invalidateWaveformTiles()
      resetGridRenderer()
      scheduleDraw()
    })
    resizeObserver.observe(wrapRef.value)
  }
  emitToolbarState()
  scheduleDraw()
})

onUnmounted(() => {
  loadToken += 1
  clearPersistTimer()
  clearBpmTapResetTimer()
  clearStreamDrawScheduling()
  stopDragging()
  disposeRawWaveformStream()
  disposeWaveformCanvas()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

defineExpose<HorizontalBrowseRawWaveformDetailExpose>({
  toggleBarLinePicking,
  setBarLineAtPlayhead,
  shiftGridSmallLeft: (options) =>
    shiftGrid(
      -resolveGridShiftMs(
        HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_PX,
        HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MIN_MS
      ),
      options
    ),
  shiftGridLargeLeft: (options) =>
    shiftGrid(
      -resolveGridShiftMs(
        HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_PX,
        HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MIN_MS
      ),
      options
    ),
  shiftGridSmallRight: (options) =>
    shiftGrid(
      resolveGridShiftMs(
        HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_TARGET_PX,
        HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MIN_MS
      ),
      options
    ),
  shiftGridLargeRight: (options) =>
    shiftGrid(
      resolveGridShiftMs(
        HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_TARGET_PX,
        HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MIN_MS
      ),
      options
    ),
  updateBpmInput: handlePreviewBpmInputUpdate,
  blurBpmInput: handlePreviewBpmInputBlur,
  tapBpm: handlePreviewBpmTap,
  cycleMetronomeState
})
</script>

<template>
  <div
    ref="wrapRef"
    :class="[
      'raw-detail-waveform',
      `raw-detail-waveform--${props.direction}`,
      {
        'is-dragging': dragging,
        'is-bar-selecting': previewBarLinePicking,
        'is-waveform-ready': displayReady
      }
    ]"
    @mousedown.stop="handleMouseDown"
    @mousemove="handlePreviewMouseMoveForBarLinePicking"
    @mouseleave="handlePreviewMouseLeaveForBarLinePicking"
    @wheel.prevent.stop="handleWheel"
  >
    <canvas
      ref="waveformCanvasRef"
      class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform"
    ></canvas>
    <canvas
      ref="gridCanvasRef"
      class="raw-detail-waveform__canvas raw-detail-waveform__canvas--grid"
    ></canvas>
    <canvas
      ref="overlayCanvasRef"
      class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay"
    ></canvas>
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
  background: var(--shell-waveform-bg, var(--waveform-bg));
  overflow: visible;
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
  transform-origin: 0 0;
  will-change: transform;
  backface-visibility: hidden;
}

.raw-detail-waveform__canvas--waveform,
.raw-detail-waveform__canvas--grid {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.raw-detail-waveform__canvas--waveform {
  opacity: 0;
  transition: opacity 100ms linear;
}

.raw-detail-waveform.is-waveform-ready .raw-detail-waveform__canvas--waveform {
  opacity: 1;
}

.raw-detail-waveform__canvas--grid {
  pointer-events: none;
}
.raw-detail-waveform__canvas--overlay {
  inset: -12px 0;
  height: calc(100% + 24px);
  pointer-events: none;
  z-index: 3;
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
  z-index: 5;
}
</style>
