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
import { resolveHorizontalBrowseEffectiveTimelineEndSec } from '@renderer/components/horizontalBrowseRawWaveformTimeline'
import { useHorizontalBrowseCompactVisualWaveformStrip } from '@renderer/components/useHorizontalBrowseCompactVisualWaveformStrip'
import {
  useHorizontalBrowseWaveformScrubPreview,
  type HorizontalBrowseScrubPreviewPayload
} from '@renderer/components/useHorizontalBrowseWaveformScrubPreview'
import type {
  HorizontalBrowseDragSessionEndPayload,
  HorizontalBrowseLoopRange,
  HorizontalBrowseSharedZoomState,
  HorizontalBrowseWaveformLayout,
  HorizontalBrowseWaveformRenderStyle
} from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import { buildHorizontalBrowseRawWaveformGridSignature } from '@renderer/components/horizontalBrowseRawWaveformGridSignature'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { createHorizontalBrowseRawWaveformDetailExpose } from '@renderer/components/horizontalBrowseRawWaveformDetailExpose'
import {
  HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON,
  createHorizontalBrowsePlaybackDiscontinuityDetector,
  normalizeHorizontalBrowseSharedZoom,
  normalizeHorizontalBrowseTimelineSeconds
} from '@renderer/components/horizontalBrowseRawWaveformDetailMath'
import {
  STABLE_PLAYBACK_POSITION_JUMP_SEC,
  createHorizontalBrowseStablePlaybackReanchorGate,
  prepareHorizontalBrowseStableCanvasJump
} from '@renderer/components/horizontalBrowseStableCanvasJump'
import { createHorizontalBrowseDragReleaseHandoff } from '@renderer/components/horizontalBrowseDragReleaseHandoff'
import { createHorizontalBrowseStableInteractionHandoff } from '@renderer/components/horizontalBrowseStableInteractionHandoff'
import { createHorizontalBrowseWaveformPointerInteraction } from '@renderer/components/horizontalBrowseWaveformPointerInteraction'

const HORIZONTAL_BROWSE_TIMELINE_TAIL_TOLERANCE_SEC = 0.75
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
  (event: 'edit-waveform-loading-change', value: boolean): void
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
const compactVisualWaveformActive = ref(false)
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
const resolveWaveformLayout = () =>
  props.waveformLayout === 'full' ? 'full' : props.direction === 'up' ? 'top-half' : 'bottom-half'

const resolveWaveformRenderStyle = () =>
  props.waveformRenderStyle === 'raw-curve' ? 'raw-curve' : 'columns'

const resolveWaveformCurrentSeconds = () =>
  normalizePreviewTimelineSeconds(
    (Number(props.currentSeconds) || 0) + localGridShiftPhaseOffsetSec.value
  )
const resolveWaveformPlaybackRate = () => Math.max(0.25, Number(props.playbackRate) || 1)

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
const playbackDiscontinuityDetector = createHorizontalBrowsePlaybackDiscontinuityDetector()
let persistTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
let pendingLocalGridSignature = ''
const stablePlaybackReanchorGate = createHorizontalBrowseStablePlaybackReanchorGate()
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
  waveformSurfaceRef,
  waveformCanvasRef,
  overlaySurfaceRef,
  overlayCanvasRef,
  resolvePreviewTimeScale,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  resetWaveformRenderState,
  clearCanvas,
  invalidateWaveformTiles,
  mountWaveformCanvasWorker,
  scheduleDraw,
  scheduleGridOverlayDraw,
  resetGridRenderer,
  resetLiveWaveformData,
  stopLiveWaveformPlayback,
  measureStableCanvasPresentation,
  applyStableCanvasPresentation,
  startStableCanvasPlayback,
  stopStableCanvasPlayback,
  reanchorStableCanvasPlayback,
  hideStableCanvasPresentation,
  replaceLiveWaveformRaw,
  drawWaveformNow,
  beginDragCanvasPresentation,
  applyDragCanvasPresentationOffset,
  endDragCanvasPresentation,
  resolveRenderedCanvasViewportStartSec,
  dragPresentationReleaseActive,
  displayReady,
  placeholderVisible,
  dispose: disposeWaveformCanvas
} = useHorizontalBrowseRawWaveformCanvas({
  song: () => props.song,
  direction: () => props.direction,
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
  previewLoading,
  previewStartSec,
  previewZoom,
  previewBpm: previewRenderBpm,
  previewFirstBeatMs,
  previewBarBeatOffset,
  previewTimeBasisOffsetMs,
  dragging,
  allowNegativeTimeline: () => Boolean(props.allowNegativeTimeline),
  waveformLayout: resolveWaveformLayout,
  waveformRenderStyle: resolveWaveformRenderStyle,
  stableWaveformSource: () => compactVisualWaveformActive.value,
  stableRenderRevision: () => 0,
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
    tailToleranceSec: HORIZONTAL_BROWSE_TIMELINE_TAIL_TOLERANCE_SEC
  })
}

const normalizePreviewTimelineSeconds = (seconds: number) =>
  normalizeHorizontalBrowseTimelineSeconds(
    seconds,
    resolveEffectiveTimelineEndSec(),
    Boolean(props.allowNegativeTimeline)
  )

const dragReleaseHandoff = createHorizontalBrowseDragReleaseHandoff({
  normalizeSeconds: normalizePreviewTimelineSeconds
})

const {
  applyPreviewPlaybackPosition,
  shouldRenderStableCanvasForPlaybackToggle,
  freezeStableCanvasPlaybackTogglePosition,
  holdStablePlaybackToggleRender,
  isStablePlaybackToggleRenderHeld,
  startStableSeekSyncHandoff,
  isStableSeekSyncHandoffActive,
  forceRenderStableSeekTarget,
  clearStableSeekRenderRaf
} = createHorizontalBrowseStableInteractionHandoff({
  previewStartSec,
  compactVisualWaveformActive,
  normalizeSeconds: normalizePreviewTimelineSeconds,
  clampPreviewStart,
  resolvePlaybackAlignedStart,
  resolveVisibleDurationSec,
  resolveRenderedCanvasViewportStartSec,
  suppressStablePlaybackReanchor: stablePlaybackReanchorGate.suppress,
  stopStableCanvasPlayback,
  hideStableCanvasPresentation,
  drawWaveformNow,
  scheduleDraw,
  playheadRatio: HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
})

const consumeDragReleaseStablePresentationOffsetLimit = (seconds: number) => {
  const consumed = dragReleaseHandoff.consume('stable-presentation', seconds)
  return consumed ? Number.POSITIVE_INFINITY : undefined
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
watch(
  () => previewLoading.value,
  () => emit('edit-waveform-loading-change', false),
  {
    immediate: true
  }
)

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
  requestCompactVisualWaveformStrip,
  maybeContinueCompactVisualWaveformStrip,
  resetCompactVisualWaveformStrip,
  disposeCompactVisualWaveformStrip
} = useHorizontalBrowseCompactVisualWaveformStrip({
  song: () => props.song,
  active: compactVisualWaveformActive,
  rawData,
  mixxxData,
  previewLoading,
  previewZoom,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
  replaceLiveWaveformRaw,
  resetPlaybackRenderState: () => resetWaveformRenderState({ preserveDisplay: true }),
  scheduleDraw
})

const maybeContinueWaveformSource = (anchorSec?: number) =>
  maybeContinueCompactVisualWaveformStrip(anchorSec)

const { stopDragging, handlePointerDown, handleWheel } =
  createHorizontalBrowseWaveformPointerInteraction({
    wrapRef,
    dragging,
    previewStartSec,
    previewZoom,
    previewMaxZoom,
    direction: () => props.direction,
    hasSong: () => Boolean(props.song?.filePath),
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    beginDragCanvasPresentation,
    applyDragCanvasPresentationOffset,
    endDragCanvasPresentation,
    clearDragReleaseHandoff: dragReleaseHandoff.clear,
    beginDragReleaseHandoff: dragReleaseHandoff.begin,
    scrubPreview,
    handlePreviewMouseDownForBarLinePicking,
    emitToolbarState,
    schedulePersistGridDefinition,
    emitDragSessionStart: () => emit('drag-session-start'),
    emitDragSessionEnd: (payload) => emit('drag-session-end', payload),
    emitZoomChange: (payload) => emit('zoom-change', payload),
    maybeContinueWaveformSource,
    drawWaveformNow,
    scheduleDraw,
    zoomStepFactor: HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR,
    minZoom: HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
    clampNumber
  })

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  pendingLocalGridSignature = ''
  dragReleaseHandoff.clear()

  clearPersistTimer()
  resetCompactVisualWaveformStrip()
  invalidateWaveformTiles()
  previewLoading.value = false
  compactVisualWaveformActive.value = false
  rawData.value = null
  mixxxData.value = null
  replaceLiveWaveformRaw(null)
  previewStartSec.value = 0
  resetLiveWaveformData()
  resetGridRenderer()
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSong()
    return
  }

  try {
    previewLoading.value = true
    syncGridStateFromSong()
    previewStartSec.value = resolvePlaybackAlignedStart(resolveWaveformCurrentSeconds())
    compactVisualWaveformActive.value = true
    await requestCompactVisualWaveformStrip(resolveWaveformCurrentSeconds(), {
      force: true,
      clearIfOutside: true
    })
    if (currentToken !== loadToken) return
  } catch {
    if (currentToken !== loadToken) return
    previewLoading.value = false
    compactVisualWaveformActive.value = true
    rawData.value = null
    mixxxData.value = null
    replaceLiveWaveformRaw(null)
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
  () => [resolveWaveformLayout(), resolveWaveformRenderStyle()] as const,
  ([layout, renderStyle], previous) => {
    if (previous && layout === previous[0] && renderStyle === previous[1]) return
    void loadWaveform()
  }
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
  () => props.sharedZoomState,
  (state) => {
    const nextZoom = normalizeHorizontalBrowseSharedZoom(state, previewMaxZoom.value)
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
    maybeContinueWaveformSource(resolvePreviewAnchorSec())
    scheduleDraw()
  },
  { immediate: true }
)

watch(
  () => waveformPlaybackActive.value,
  (playing, previousPlaying) => {
    previewPlaying.value = playing
    if (dragging.value) {
      if (!playing && previousPlaying === true) {
        const stableWaveformSource = compactVisualWaveformActive.value
        stopLiveWaveformPlayback(stableWaveformSource)
        if (stableWaveformSource) {
          stopStableCanvasPlayback()
        }
      }
      return
    }
    const toggleAnchorSec = resolveWaveformCurrentSeconds()
    if (playing) {
      const anchorSec = toggleAnchorSec
      if (compactVisualWaveformActive.value) {
        stablePlaybackReanchorGate.suppress()
        const measured = measureStableCanvasPresentation(anchorSec)
        const refreshFrame = shouldRenderStableCanvasForPlaybackToggle(measured)
        if (refreshFrame) {
          holdStablePlaybackToggleRender()
          applyPreviewPlaybackPosition(anchorSec, true, true, false)
          return
        }
        const visualAnchorSec = freezeStableCanvasPlaybackTogglePosition(anchorSec)
        holdStablePlaybackToggleRender()
        startStableCanvasPlayback(visualAnchorSec, resolveWaveformPlaybackRate())
        return
      } else {
        applyPreviewPlaybackPosition(anchorSec, true)
      }
      maybeContinueWaveformSource(anchorSec)
      return
    }
    if (!playing) {
      const stableWaveformSource = compactVisualWaveformActive.value
      const anchorSec = toggleAnchorSec
      if (previousPlaying === true) stopLiveWaveformPlayback(stableWaveformSource)
      if (stableWaveformSource) {
        stopStableCanvasPlayback()
        const measured = measureStableCanvasPresentation(anchorSec)
        const refreshFrame = shouldRenderStableCanvasForPlaybackToggle(measured)
        if (refreshFrame) {
          holdStablePlaybackToggleRender()
          applyPreviewPlaybackPosition(anchorSec, true, true, false)
          return
        }
        const visualAnchorSec = freezeStableCanvasPlaybackTogglePosition(anchorSec)
        holdStablePlaybackToggleRender()
        return
      }
      applyPreviewPlaybackPosition(anchorSec, true)
      maybeContinueWaveformSource(anchorSec)
    }
  },
  { immediate: true, flush: 'sync' }
)

watch(
  () =>
    [
      Number(props.currentSeconds) || 0,
      waveformPlaybackActive.value,
      props.song?.filePath ?? '',
      playbackSyncRevision.value,
      Number(props.seekRevision) || 0,
      Number(props.seekTargetSeconds) || 0
    ] as const,
  ([seconds, playing, songKey, syncRevision, seekRevision, seekTargetSeconds], previousValue) => {
    const finishTiming = startHorizontalBrowseUserTiming(
      `frkb:hb:detail:current-seconds:${props.direction}`
    )
    try {
      if (dragging.value) return
      const safeSongKey = String(songKey || '').trim()
      const safeSeconds = normalizePreviewTimelineSeconds(seconds)
      if (!safeSongKey) {
        playbackDiscontinuityDetector.reset()
        applyPreviewPlaybackPosition(0)
        return
      }
      const previousPlaying = Boolean(previousValue?.[1])
      const previousSongKey = String(previousValue?.[2] || '').trim()
      const previousSyncRevision = Math.max(0, Math.floor(Number(previousValue?.[3]) || 0))
      const previousSeekRevision = Math.max(0, Math.floor(Number(previousValue?.[4]) || 0))
      const playbackSyncChanged = syncRevision !== previousSyncRevision
      const safeSeekRevision = Math.max(0, Math.floor(Number(seekRevision) || 0))
      const safeSeekTargetSeconds = normalizePreviewTimelineSeconds(seekTargetSeconds)
      const seekRevisionChanged =
        previousValue !== undefined &&
        safeSeekRevision > 0 &&
        safeSeekRevision !== previousSeekRevision
      if (playbackSyncChanged || safeSongKey !== previousSongKey) {
        localGridShiftPhaseOffsetSec.value = 0
      }
      if (playbackSyncChanged && dragReleaseHandoff.consume('playback-sync', safeSeconds)) {
        applyPreviewPlaybackPosition(safeSeconds, false)
        return
      }
      if (
        seekRevisionChanged &&
        compactVisualWaveformActive.value &&
        !dragReleaseHandoff.matches(safeSeekTargetSeconds)
      ) {
        startStableSeekSyncHandoff(safeSeekRevision, safeSeekTargetSeconds)
        forceRenderStableSeekTarget(safeSeekTargetSeconds)
        return
      }
      const stableSeekSyncHandoffActive =
        compactVisualWaveformActive.value &&
        isStableSeekSyncHandoffActive(safeSeekRevision, safeSeconds)
      if (dragPresentationReleaseActive.value) {
        applyPreviewPlaybackPosition(safeSeconds, false)
        return
      }
      const previousSeconds = normalizePreviewTimelineSeconds(Number(previousValue?.[0]) || 0)
      const playbackPositionChanged =
        previousValue === undefined || Math.abs(safeSeconds - previousSeconds) > 0.0001
      const playbackClockJumped = playbackDiscontinuityDetector.check(
        safeSongKey,
        safeSeconds,
        playing,
        props.playbackRate,
        normalizePreviewTimelineSeconds
      )
      const pausedPositionJumped =
        !playing &&
        previousValue !== undefined &&
        Math.abs(safeSeconds - previousSeconds) > STABLE_PLAYBACK_POSITION_JUMP_SEC
      const playbackPositionJumped = playbackClockJumped || pausedPositionJumped
      if (
        stableSeekSyncHandoffActive &&
        (playbackSyncChanged || playbackPositionJumped || safeSongKey !== previousSongKey)
      ) {
        forceRenderStableSeekTarget(safeSeconds)
        return
      }
      if (compactVisualWaveformActive.value && isStablePlaybackToggleRenderHeld()) {
        return
      }
      const stablePresentationActive = compactVisualWaveformActive.value && playing
      if (stablePresentationActive) {
        const allowReanchor =
          previousPlaying === true &&
          !playbackSyncChanged &&
          !playbackPositionJumped &&
          stablePlaybackReanchorGate.canReanchor()
        const requirePresentable =
          playbackSyncChanged || playbackPositionJumped || safeSongKey !== previousSongKey
        if (requirePresentable) {
          const maxOffsetCssPx = consumeDragReleaseStablePresentationOffsetLimit(safeSeconds)
          const canReuseStableFrame = prepareHorizontalBrowseStableCanvasJump({
            seconds: safeSeconds,
            measure: measureStableCanvasPresentation,
            hide: hideStableCanvasPresentation,
            maxOffsetCssPx
          })
          if (!canReuseStableFrame) {
            stopStableCanvasPlayback()
            applyPreviewPlaybackPosition(safeSeconds, true, true)
            return
          }
        }
        if (requirePresentable) {
          const result = applyStableCanvasPresentation(safeSeconds, {
            allowReanchor,
            requirePresentable
          })
          if (result.applied) {
            reanchorStableCanvasPlayback(safeSeconds, resolveWaveformPlaybackRate())
          }
          applyPreviewPlaybackPosition(safeSeconds, !result.applied, true)
        }
        return
      }
      if (compactVisualWaveformActive.value) {
        stopStableCanvasPlayback()
        const requirePresentable =
          playbackSyncChanged || playbackPositionJumped || safeSongKey !== previousSongKey
        if (requirePresentable) {
          const maxOffsetCssPx = consumeDragReleaseStablePresentationOffsetLimit(safeSeconds)
          const canReuseStableFrame = prepareHorizontalBrowseStableCanvasJump({
            seconds: safeSeconds,
            measure: measureStableCanvasPresentation,
            hide: hideStableCanvasPresentation,
            maxOffsetCssPx
          })
          if (!canReuseStableFrame) {
            applyPreviewPlaybackPosition(safeSeconds, true, true)
            return
          }
        }
        const result = applyStableCanvasPresentation(safeSeconds)
        applyPreviewPlaybackPosition(safeSeconds, !result.applied)
        return
      }
      maybeContinueWaveformSource(safeSeconds)
      const shouldScheduleFrame =
        (!playing && playbackPositionChanged) ||
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
    if (dragReleaseHandoff.consume('seek-revision', safeTargetSeconds)) {
      applyPreviewPlaybackPosition(safeTargetSeconds, false)
      return
    }
    if (compactVisualWaveformActive.value) {
      startStableSeekSyncHandoff(revision, safeTargetSeconds)
      forceRenderStableSeekTarget(safeTargetSeconds)
      return
    }
    applyPreviewPlaybackPosition(safeTargetSeconds, true, true)
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
  resetCompactVisualWaveformStrip()
  clearPersistTimer()
  clearBpmTapResetTimer()
  clearStableSeekRenderRaf()
  stopDragging(false, false)
  disposeWaveformCanvas()
  disposeCompactVisualWaveformStrip()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

defineExpose(
  createHorizontalBrowseRawWaveformDetailExpose({
    toggleBarLinePicking,
    setBarLineAtPlayhead,
    shiftGrid,
    updateBpmInput: handlePreviewBpmInputUpdate,
    blurBpmInput: handlePreviewBpmInputBlur,
    tapBpm: handlePreviewBpmTap,
    cycleMetronomeState,
    resolveVisibleDurationSec,
    resolveWrapWidth: () => Number(wrapRef.value?.getBoundingClientRect().width || 0)
  })
)
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
        'is-loading': previewLoading
      }
    ]"
    @pointerdown.stop="handlePointerDown"
    @mousemove="handlePreviewMouseMoveForBarLinePicking"
    @mouseleave="handlePreviewMouseLeaveForBarLinePicking"
    @wheel.prevent.stop="handleWheel"
  >
    <div ref="waveformSurfaceRef" class="raw-detail-waveform__surface">
      <canvas
        ref="waveformCanvasRef"
        class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform"
      />
    </div>
    <div ref="overlaySurfaceRef" class="raw-detail-waveform__overlay-surface">
      <canvas
        ref="overlayCanvasRef"
        class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay"
      />
    </div>
    <div
      v-if="previewBarLineHoverVisible"
      class="raw-detail-waveform__barline-glow"
      :style="previewBarLineGlowStyle"
    ></div>
  </div>
</template>
<style scoped lang="scss" src="./HorizontalBrowseRawWaveformDetail.scss"></style>
