<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/components/horizontalBrowseWaveform.constants'
import { useHorizontalBrowseGridToolbar } from '@renderer/components/useHorizontalBrowseGridToolbar'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import { useMixtapeBeatAlignMetronome } from '@renderer/components/mixtapeBeatAlignMetronome'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BAR_LINE_HIT_RADIUS_PX,
  clampNumber
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { useHorizontalBrowseRawWaveformCanvas } from '@renderer/components/useHorizontalBrowseRawWaveformCanvas'
import { resolveHorizontalBrowseEffectiveTimelineEndSec } from '@renderer/components/horizontalBrowseRawWaveformTimeline'
import { useHorizontalBrowseCompactVisualWaveformStrip } from '@renderer/components/useHorizontalBrowseCompactVisualWaveformStrip'
import { useHorizontalBrowseWaveformScrubPreview } from '@renderer/components/useHorizontalBrowseWaveformScrubPreview'
import type {
  HorizontalBrowseRawWaveformDetailEmit,
  HorizontalBrowseRawWaveformDetailProps
} from '@renderer/components/horizontalBrowseRawWaveformDetailTypes'
import { createHorizontalBrowseRawWaveformDetailExpose } from '@renderer/components/horizontalBrowseRawWaveformDetailExpose'
import {
  createHorizontalBrowsePlaybackDiscontinuityDetector,
  normalizeHorizontalBrowseTimelineSeconds
} from '@renderer/components/horizontalBrowseRawWaveformDetailMath'
import { createHorizontalBrowseStablePlaybackReanchorGate } from '@renderer/components/horizontalBrowseStableCanvasJump'
import { createHorizontalBrowseDragReleaseHandoff } from '@renderer/components/horizontalBrowseDragReleaseHandoff'
import { createHorizontalBrowseStableInteractionHandoff } from '@renderer/components/horizontalBrowseStableInteractionHandoff'
import { createHorizontalBrowseWaveformPointerInteraction } from '@renderer/components/horizontalBrowseWaveformPointerInteraction'
import { createHorizontalBrowseDetailPresentationState } from '@renderer/components/horizontalBrowseDetailPresentationState'
import { createHorizontalBrowseDetailPresentationActions } from '@renderer/components/horizontalBrowseDetailPresentationActions'
import { createHorizontalBrowseDetailGridPersistence } from '@renderer/components/horizontalBrowseDetailGridPersistence'
import { createHorizontalBrowseDetailPresentationConsumer } from '@renderer/components/horizontalBrowseDetailPresentationConsumer'
import { watchHorizontalBrowseDetailPlaybackPosition } from '@renderer/components/horizontalBrowseDetailPlaybackPositionWatch'

const HORIZONTAL_BROWSE_TIMELINE_TAIL_TOLERANCE_SEC = 0.75
const props = defineProps<HorizontalBrowseRawWaveformDetailProps>()
const emit = defineEmits<HorizontalBrowseRawWaveformDetailEmit>()
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
const presentationLinkedDragActive = computed(
  () => Boolean(props.linkedDragActive) || props.presentationState?.owner === 'linked-drag'
)
const presentationLinkedDragAnchorSec = computed(() => {
  const stateAnchor = Number(props.presentationState?.anchorSec)
  if (props.presentationState?.owner === 'linked-drag' && Number.isFinite(stateAnchor)) {
    return stateAnchor
  }
  return props.linkedDragAnchorSec ?? null
})
const presentationLinkedGridActive = computed(
  () => props.linkedGridActive === true || props.presentationState?.linked === true
)
const presentationLinkedGridVisualPending = computed(
  () =>
    props.linkedGridVisualPending === true ||
    props.presentationState?.visualPending === true ||
    props.presentationState?.owner === 'sync-transaction'
)
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
const resolveDetailDeck = () => (props.direction === 'up' ? 'top' : 'bottom')

const resolveWaveformCurrentSeconds = () =>
  normalizePreviewTimelineSeconds(
    (Number(props.currentSeconds) || 0) + localGridShiftPhaseOffsetSec.value
  )
const resolveWaveformPlaybackRate = () => Math.max(0.25, Number(props.playbackRate) || 1)

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
const playbackDiscontinuityDetector = createHorizontalBrowsePlaybackDiscontinuityDetector()
let linkedGridVisualTransactionCommitted = false
const stablePlaybackReanchorGate = createHorizontalBrowseStablePlaybackReanchorGate()
const presentationState = createHorizontalBrowseDetailPresentationState({
  song: () => props.song,
  direction: () => props.direction,
  gridBpm: () => props.gridBpm,
  playbackRate: () => props.playbackRate,
  visualPlaybackRate: () => props.visualPlaybackRate,
  linkedGridActive: () => presentationLinkedGridActive.value,
  linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
  waveformLayout: resolveWaveformLayout,
  waveformPlaybackActive: () => waveformPlaybackActive.value,
  resolveWaveformCurrentSeconds,
  resolveWaveformPlaybackRate,
  previewBpm,
  previewFirstBeatMs,
  previewBarBeatOffset,
  previewTimeBasisOffsetMs
})
const {
  previewRenderBpm,
  visualGridBpm,
  visualGridFirstBeatMs,
  visualGridBarBeatOffset,
  visualGridTimeBasisOffsetMs,
  visualGridRenderBpm,
  resolveDisplayGridBpm,
  resolveIncomingPreviewTimeScale,
  resolveCanvasVisualPlaybackRate,
  syncVisualGridStateFromPreview,
  publishLinkedGridVisualPhaseSample
} = presentationState

const {
  wrapRef,
  waveformSurfaceRef,
  waveformCanvasRef,
  waveformCanvasBackRef,
  overlaySurfaceRef,
  overlayCanvasRef,
  overlayCanvasBackRef,
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
  visualPlaybackRate: resolveCanvasVisualPlaybackRate,
  waveformGain: () => props.waveformGain,
  playing: previewPlaying,
  playbackSyncRevision,
  rawData,
  mixxxData,
  previewLoading,
  previewStartSec,
  previewZoom,
  previewBpm: visualGridRenderBpm,
  previewFirstBeatMs: visualGridFirstBeatMs,
  previewBarBeatOffset: visualGridBarBeatOffset,
  previewTimeBasisOffsetMs: visualGridTimeBasisOffsetMs,
  dragging,
  allowNegativeTimeline: () => Boolean(props.allowNegativeTimeline),
  waveformLayout: resolveWaveformLayout,
  waveformRenderStyle: resolveWaveformRenderStyle,
  stableWaveformSource: () => compactVisualWaveformActive.value,
  stableRenderRevision: () => 0,
  linkedGridActive: () => presentationLinkedGridActive.value,
  phaseAwareScrollReuse: () => Math.abs(localGridShiftPhaseOffsetSec.value) > 0.000001
})
presentationState.setLastAppliedPreviewTimeScale(
  Math.max(0.25, Number(resolvePreviewTimeScale()) || 1)
)

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

function resolveEffectiveTimelineEndSec() {
  return resolveHorizontalBrowseEffectiveTimelineEndSec({
    rawData: rawData.value,
    durationSec: resolvePreviewDurationSec(),
    timeBasisOffsetMs: visualGridTimeBasisOffsetMs.value,
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

const applyStablePresentationSeekTarget = (seconds: number) => {
  if (!compactVisualWaveformActive.value) return false
  const result = applyStableCanvasPresentation(seconds, {
    allowReanchor: false,
    requirePresentable: true
  })
  if (!result.applied) return false
  applyPreviewPlaybackPosition(seconds, false)
  if (waveformPlaybackActive.value) {
    reanchorStableCanvasPlayback(seconds, resolveWaveformPlaybackRate())
  } else {
    stopStableCanvasPlayback()
  }
  return true
}

const applyPresentationSeekTarget = (targetSeconds: number, revision: number) => {
  if (!props.song?.filePath) return
  const safeTargetSeconds = normalizePreviewTimelineSeconds(targetSeconds)
  if (dragReleaseHandoff.consume('seek-revision', safeTargetSeconds)) {
    applyPreviewPlaybackPosition(safeTargetSeconds, false)
    return
  }
  if (compactVisualWaveformActive.value) {
    if (applyStablePresentationSeekTarget(safeTargetSeconds)) return
    startStableSeekSyncHandoff(revision, safeTargetSeconds)
    forceRenderStableSeekTarget(safeTargetSeconds)
    return
  }
  applyPreviewPlaybackPosition(safeTargetSeconds, true, true)
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

const {
  buildSongGridSignature,
  clearPendingLocalGridSignature,
  clearPersistTimer,
  clearBpmTapResetTimer,
  resetPreviewBpmTap,
  schedulePreviewBpmTapReset,
  persistGridDefinition,
  schedulePersistGridDefinition,
  shouldDeferSongGridSync
} = createHorizontalBrowseDetailGridPersistence({
  song: () => props.song,
  previewBpm,
  previewFirstBeatMs,
  previewBarBeatOffset,
  previewTimeBasisOffsetMs,
  bpmTapTimestamps
})

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

const syncGridStateFromSongForDisplay = () => {
  syncGridStateFromSong()
  if (!presentationLinkedGridVisualPending.value) {
    syncVisualGridStateFromPreview()
  }
}

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

const {
  clearPlaybackStableFrameRenderTimer,
  schedulePlaybackStableFrameRender,
  prepareStableFrameForAnchor,
  applyIncomingPreviewTimeScale,
  commitLinkedGridVisualTransaction: commitLinkedGridVisualPresentationTransaction
} = createHorizontalBrowseDetailPresentationActions({
  currentSeconds: () => props.currentSeconds,
  compactVisualWaveformActive,
  previewStartSec,
  localGridShiftPhaseOffsetSec,
  waveformPlaybackActive: () => waveformPlaybackActive.value,
  normalizePreviewTimelineSeconds,
  resolveVisibleDurationSec,
  resolveWaveformCurrentSeconds,
  clampPreviewStart,
  stopStableCanvasPlayback,
  drawWaveformNow,
  measureStableCanvasPresentation,
  getLastAppliedPreviewTimeScale: presentationState.getLastAppliedPreviewTimeScale,
  setLastAppliedPreviewTimeScale: presentationState.setLastAppliedPreviewTimeScale,
  resolveIncomingPreviewTimeScale,
  invalidateWaveformTiles,
  resetGridRenderer,
  maybeContinueWaveformSource,
  scheduleDraw,
  syncGridStateFromSong,
  syncVisualGridStateFromPreview,
  applyPreviewPlaybackPosition,
  publishLinkedGridVisualPhaseSample,
  markLinkedGridVisualTransactionCommitted: () => {
    linkedGridVisualTransactionCommitted = true
  }
})

const commitLinkedGridVisualTransaction = () =>
  props.song?.filePath ? commitLinkedGridVisualPresentationTransaction() : false

const { handleSharedZoomState, handlePresentationState } =
  createHorizontalBrowseDetailPresentationConsumer({
    deck: resolveDetailDeck,
    direction: () => props.direction,
    presentationState: () => props.presentationState,
    previewZoom,
    previewMaxZoom,
    previewStartSec,
    waveformPlaybackActive: () => waveformPlaybackActive.value,
    resolveWaveformCurrentSeconds,
    resolveVisibleDurationSec,
    clampPreviewStart,
    resetGridRenderer,
    maybeContinueWaveformSource,
    schedulePlaybackStableFrameRender,
    clearPlaybackStableFrameRenderTimer,
    scheduleDraw,
    applyPresentationSeekTarget
  })

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
    linkedDragActive: () => presentationLinkedDragActive.value,
    linkedDragAnchorSec: () => presentationLinkedDragAnchorSec.value,
    resolvePlaybackActive: () => waveformPlaybackActive.value,
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
  clearPendingLocalGridSignature()
  dragReleaseHandoff.clear()

  clearPersistTimer()
  clearPlaybackStableFrameRenderTimer()
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
    syncGridStateFromSongForDisplay()
    return
  }

  try {
    previewLoading.value = true
    syncGridStateFromSongForDisplay()
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
    syncGridStateFromSongForDisplay()
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
      props.song?.timeBasisOffsetMs,
      presentationLinkedGridVisualPending.value
    ] as const,
  ([, , , , linkedGridVisualPending]) => {
    if (linkedGridVisualPending) {
      emitToolbarState()
      return
    }
    const songGridSignature = buildSongGridSignature()
    if (shouldDeferSongGridSync(songGridSignature)) return
    syncGridStateFromSongForDisplay()
    if (!linkedGridVisualPending) {
      scheduleGridOverlayDraw()
    }
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
  () =>
    [
      presentationLinkedGridActive.value,
      props.direction,
      props.song?.filePath ?? '',
      visualGridRenderBpm.value,
      visualGridFirstBeatMs.value,
      visualGridBarBeatOffset.value,
      props.currentSeconds,
      props.playbackRate,
      waveformPlaybackActive.value,
      resolveWaveformLayout()
    ] as const,
  () => {
    publishLinkedGridVisualPhaseSample()
  },
  { immediate: true, flush: 'sync' }
)

watch(
  () => [resolveIncomingPreviewTimeScale(), presentationLinkedGridVisualPending.value] as const,
  ([, linkedGridVisualPending]) => {
    if (linkedGridVisualPending) {
      return
    }
    applyIncomingPreviewTimeScale()
  }
)

watch(
  () => {
    const numeric = Number(props.waveformGain)
    if (!Number.isFinite(numeric)) return 1
    return clampNumber(numeric, 0, 16)
  },
  () => {
    invalidateWaveformTiles({ preserveDisplay: compactVisualWaveformActive.value })
    scheduleDraw()
  }
)

watch(
  () => props.sharedZoomState,
  (state) => {
    handleSharedZoomState(state)
  },
  { immediate: true }
)

watch(
  () => props.presentationState?.revision ?? 0,
  () => handlePresentationState(props.presentationState),
  { immediate: true, flush: 'sync' }
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
        if (dragPresentationReleaseActive.value) {
          stablePlaybackReanchorGate.suppress()
          holdStablePlaybackToggleRender()
          return
        }
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

watchHorizontalBrowseDetailPlaybackPosition({
  direction: () => props.direction,
  currentSeconds: () => props.currentSeconds,
  playbackActive: () => waveformPlaybackActive.value,
  songKey: () => props.song?.filePath ?? '',
  playbackSyncRevision: () => playbackSyncRevision.value,
  seekRevision: () => props.seekRevision,
  seekTargetSeconds: () => props.seekTargetSeconds,
  playbackRate: () => props.playbackRate,
  linkedGridVisualPending: () => presentationLinkedGridVisualPending.value,
  linkedGridVisualTransactionCommitted: () => linkedGridVisualTransactionCommitted,
  setLinkedGridVisualTransactionCommitted: (value) => {
    linkedGridVisualTransactionCommitted = value
  },
  dragging,
  compactVisualWaveformActive,
  dragPresentationReleaseActive,
  normalizePreviewTimelineSeconds,
  playbackDiscontinuityDetector,
  applyPreviewPlaybackPosition,
  dragReleaseHandoff,
  applyStablePresentationSeekTarget,
  startStableSeekSyncHandoff,
  isStableSeekSyncHandoffActive,
  forceRenderStableSeekTarget,
  isStablePlaybackToggleRenderHeld,
  stopStableCanvasPlayback,
  consumeDragReleaseStablePresentationOffsetLimit,
  measureStableCanvasPresentation,
  hideStableCanvasPresentation,
  applyStableCanvasPresentation,
  reanchorStableCanvasPlayback,
  resolveWaveformPlaybackRate,
  maybeContinueWaveformSource,
  stablePlaybackReanchorCanReanchor: stablePlaybackReanchorGate.canReanchor
})

watch(
  () => [Number(props.seekRevision) || 0, Number(props.seekTargetSeconds) || 0] as const,
  ([revision, targetSeconds]) => {
    if (!revision) return
    const state = props.presentationState
    if (state?.owner === 'seek' && state.sourceDeck === resolveDetailDeck()) {
      return
    }
    applyPresentationSeekTarget(targetSeconds, revision)
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
      previewTimeBasisOffsetMs.value,
      presentationLinkedGridVisualPending.value
    ] as const,
  ([, , , , , linkedGridVisualPending]) => {
    if (linkedGridVisualPending) {
      emitToolbarState()
      return
    }
    syncVisualGridStateFromPreview()
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
    invalidateWaveformTiles({ preserveDisplay: compactVisualWaveformActive.value })
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
  clearPlaybackStableFrameRenderTimer()
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
    prepareStableFrameForAnchor,
    commitLinkedGridVisualTransaction,
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
      <canvas
        ref="waveformCanvasBackRef"
        class="raw-detail-waveform__canvas raw-detail-waveform__canvas--waveform raw-detail-waveform__canvas--buffer-back"
      />
    </div>
    <div ref="overlaySurfaceRef" class="raw-detail-waveform__overlay-surface">
      <canvas
        ref="overlayCanvasRef"
        class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay"
      />
      <canvas
        ref="overlayCanvasBackRef"
        class="raw-detail-waveform__canvas raw-detail-waveform__canvas--overlay raw-detail-waveform__canvas--buffer-back"
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
