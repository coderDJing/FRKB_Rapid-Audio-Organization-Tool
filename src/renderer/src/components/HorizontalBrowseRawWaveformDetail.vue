<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import HorizontalBrowseCueMarker from '@renderer/components/HorizontalBrowseCueMarker.vue'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { useRuntimeStore } from '@renderer/stores/runtime'
import {
  HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_ZOOM_STEP_FACTOR
} from '@renderer/components/horizontalBrowseWaveform.constants'
import { normalizeHorizontalBrowsePathKey } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
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
import { pickRawDataByFile } from '@renderer/components/mixtapeBeatAlignRawWaveform'
import { useHorizontalBrowseRawWaveformCanvas } from '@renderer/components/useHorizontalBrowseRawWaveformCanvas'
import { useHorizontalBrowseRawWaveformStream } from '@renderer/components/useHorizontalBrowseRawWaveformStream'

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
  toggleMetronome: () => void
  cycleMetronomeVolume: () => void
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

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

const props = defineProps<{
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoomState?: HorizontalBrowseSharedZoomState
  currentSeconds?: number
  playing?: boolean
  playbackRate?: number
  gridBpm?: number
  loopRange?: HorizontalBrowseLoopRange | null
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
const rawStreamActive = ref(false)

const HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MS = 2
const HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MS = 8

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let dragStartClientX = 0
let dragStartSec = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null

const {
  wrapRef,
  waveformCanvasRef,
  gridCanvasRef,
  resolvePreviewTimeScale,
  resolvePreviewDurationSec,
  resolveVisibleDurationSec,
  resolvePreviewAnchorSec,
  clampPreviewStart,
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
  dispose: disposeWaveformCanvas
} = useHorizontalBrowseRawWaveformCanvas({
  song: () => props.song,
  direction: () => props.direction,
  playbackRate: () => props.playbackRate,
  rawData,
  mixxxData,
  previewStartSec,
  previewZoom,
  previewBpm,
  previewFirstBeatMs,
  previewBarBeatOffset,
  dragging,
  rawStreamActive
})

const resolveDisplayGridBpm = () =>
  Number.isFinite(Number(props.gridBpm)) && Number(props.gridBpm) > 0
    ? normalizePreviewBpm(Number(props.gridBpm))
    : Number.isFinite(Number(props.song?.bpm)) && Number(props.song?.bpm) > 0
      ? normalizePreviewBpm(Number(props.song?.bpm))
      : 0

const normalizeSharedZoom = (value: unknown) => {
  const numeric =
    typeof value === 'object' && value !== null && 'value' in value
      ? Number((value as { value?: unknown }).value)
      : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
  return clampNumber(numeric, HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM, HORIZONTAL_BROWSE_DETAIL_MAX_ZOOM)
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
  setLastZoomAnchor(resolvePreviewAnchorSec(), HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO)
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

  setLastZoomAnchor(anchorSec, ratio)
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
const detailVisible = computed(() => true)
const loopMaskStyle = computed(() => {
  const loopRange = props.loopRange
  if (!loopRange) return null
  const visibleDurationSec = resolveVisibleDurationSec()
  if (!Number.isFinite(visibleDurationSec) || visibleDurationSec <= 0) return null
  const viewStartSec = clampPreviewStart(previewStartSec.value)
  const viewEndSec = viewStartSec + visibleDurationSec
  const visibleStartSec = Math.max(viewStartSec, Number(loopRange.startSec) || 0)
  const visibleEndSec = Math.min(viewEndSec, Number(loopRange.endSec) || 0)
  if (visibleEndSec <= visibleStartSec) return null
  return {
    left: `${((visibleStartSec - viewStartSec) / visibleDurationSec) * 100}%`,
    width: `${((visibleEndSec - visibleStartSec) / visibleDurationSec) * 100}%`
  }
})

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
  metronomeEnabled,
  metronomeVolumeLevel,
  metronomeSupported,
  setMetronomeEnabled,
  setMetronomeVolumeLevel
} = useMixtapeBeatAlignMetronome({
  dialogVisible: detailVisible,
  previewPlaying,
  bpm: previewBpm,
  firstBeatMs: previewFirstBeatMsComputed,
  resolveAnchorSec: resolvePreviewAnchorSec
})

const canToggleMetronome = computed(() => canAdjustGrid.value && metronomeSupported.value)
const canAdjustMetronomeVolume = computed(() => canToggleMetronome.value)

const {
  emitToolbarState,
  syncGridStateFromSong,
  handlePreviewBpmInputUpdate,
  handlePreviewBpmInputBlur,
  handlePreviewBpmTap,
  toggleBarLinePicking,
  setBarLineAtPlayhead,
  shiftGrid,
  toggleMetronome,
  cycleMetronomeVolume
} = useHorizontalBrowseGridToolbar({
  canAdjustGrid,
  previewLoading,
  previewBpm,
  previewBpmInput,
  previewFirstBeatMs,
  previewBarBeatOffset,
  bpmTapTimestamps,
  previewBarLinePicking,
  metronomeEnabled,
  metronomeVolumeLevel,
  canToggleMetronome,
  canAdjustMetronomeVolume,
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
  handleGridShift,
  handleMetronomeToggle: () => setMetronomeEnabled(!metronomeEnabled.value),
  handleMetronomeVolumeCycle: () => {
    const currentLevel = Number(metronomeVolumeLevel.value)
    const nextLevel = currentLevel >= 3 ? 1 : ((currentLevel + 1) as 1 | 2 | 3)
    setMetronomeVolumeLevel(nextLevel)
  }
})

const {
  resolveWaveformTargetRate,
  cancelRawWaveformStream,
  beginRawWaveformStream,
  handleRawLoadPriorityHintChange,
  mount: mountRawWaveformStream,
  dispose: disposeRawWaveformStream
} = useHorizontalBrowseRawWaveformStream({
  song: () => props.song,
  direction: () => props.direction,
  rawLoadPriorityHint: () => props.rawLoadPriorityHint,
  previewLoading,
  rawStreamActive,
  rawData,
  mixxxData,
  clearStreamDrawScheduling,
  scheduleRawStreamDirtyDraw,
  scheduleDraw,
  storeRawWaveform
})

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken

  clearPersistTimer()
  clearStreamDrawScheduling()
  cancelRawWaveformStream()
  invalidateWaveformTiles()
  previewLoading.value = false
  rawStreamActive.value = false
  rawData.value = null
  mixxxData.value = null
  previewStartSec.value = 0
  resetGridRenderer()
  clearCanvas()
  resetLastZoomAnchor()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSong()
    return
  }

  try {
    previewLoading.value = true
    const targetRate = resolveWaveformTargetRate(!!props.deferWaveformLoad)
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
      storeRawWaveform(filePath, picked)
      rawStreamActive.value = false
    } else {
      beginRawWaveformStream(filePath, targetRate, currentToken)
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
    [props.song?.bpm, props.song?.firstBeatMs, props.song?.barBeatOffset, props.gridBpm] as const,
  () => {
    syncGridStateFromSong()
    resetGridRenderer()
    scheduleDraw()
  }
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
    setLastZoomAnchor(anchorSec, anchorRatio)
    previewZoom.value = nextZoom
    const nextVisible = resolveVisibleDurationSec()
    previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * anchorRatio)
    resetGridRenderer()
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
  ([seconds, _playing, songKey]) => {
    if (dragging.value) return
    const safeSongKey = String(songKey || '').trim()
    const safeSeconds = Math.max(0, seconds)
    if (!safeSongKey) {
      previewStartSec.value = resolvePlaybackAlignedStart(0)
      scheduleDraw()
      return
    }
    previewStartSec.value = resolvePlaybackAlignedStart(safeSeconds)
    setLastZoomAnchor(safeSeconds, HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO)
    scheduleDraw()
  }
)

watch(
  () => canAdjustGrid.value,
  () => {
    emitToolbarState()
  }
)

watch(
  () => [previewBpm.value, previewFirstBeatMs.value, previewBarBeatOffset.value] as const,
  () => {
    resetGridRenderer()
    scheduleDraw()
    emitToolbarState()
  }
)

watch(
  () =>
    [
      metronomeEnabled.value,
      metronomeVolumeLevel.value,
      canToggleMetronome.value,
      canAdjustMetronomeVolume.value
    ] as const,
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
  if (wrapRef.value) {
    resizeObserver = new ResizeObserver(() => {
      invalidateWaveformTiles()
      resetGridRenderer()
      scheduleDraw()
    })
    resizeObserver.observe(wrapRef.value)
  }
  mountRawWaveformStream()
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
  shiftGridSmallLeft: () => shiftGrid(-HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MS),
  shiftGridLargeLeft: () => shiftGrid(-HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MS),
  shiftGridSmallRight: () => shiftGrid(HORIZONTAL_BROWSE_GRID_SHIFT_SMALL_MS),
  shiftGridLargeRight: () => shiftGrid(HORIZONTAL_BROWSE_GRID_SHIFT_LARGE_MS),
  updateBpmInput: handlePreviewBpmInputUpdate,
  blurBpmInput: handlePreviewBpmInputBlur,
  tapBpm: handlePreviewBpmTap,
  toggleMetronome,
  cycleMetronomeVolume
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
    <div v-if="loopMaskStyle" class="raw-detail-waveform__loop-mask" :style="loopMaskStyle"></div>
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

.raw-detail-waveform__loop-mask {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--shell-cue-accent, #d98921) 28%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 46%, transparent),
    0 0 0 1px color-mix(in srgb, var(--shell-cue-accent, #d98921) 14%, transparent);
  pointer-events: none;
  z-index: 1;
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
