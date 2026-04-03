<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { createBeatAlignPreviewRenderer } from '@renderer/components/mixtapeBeatAlignPreviewRenderer'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import {
  PREVIEW_BAR_BEAT_INTERVAL,
  PREVIEW_BAR_LINE_HIT_RADIUS_PX,
  PREVIEW_BPM_MAX,
  PREVIEW_BPM_MIN,
  PREVIEW_PLAY_ANCHOR_RATIO,
  PREVIEW_BPM_STEP,
  PREVIEW_BPM_TAP_MAX_COUNT,
  PREVIEW_BPM_TAP_MAX_DELTA_MS,
  PREVIEW_BPM_TAP_MIN_DELTA_MS,
  PREVIEW_BPM_TAP_RESET_MS,
  PREVIEW_GRID_SHIFT_LARGE_MS,
  PREVIEW_GRID_SHIFT_SMALL_MS,
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  PREVIEW_MAX_ZOOM,
  PREVIEW_MIN_ZOOM,
  PREVIEW_RAW_TARGET_RATE,
  clampNumber,
  formatPreviewBpm,
  normalizeBeatOffset,
  normalizePreviewBpm,
  parsePreviewBpmInput,
  resolvePreviewAnchorSecByRange,
  resolveVisibleDurationSecByZoom
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { pickRawDataByFile } from '@renderer/components/mixtapeBeatAlignRawWaveform'

type HorizontalBrowseGridToolbarState = {
  disabled: boolean
  bpmInputValue: string
  bpmStep: number
  bpmMin: number
  bpmMax: number
  barLinePicking: boolean
}

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

const props = defineProps<{
  song: ISongInfo | null
  direction: 'up' | 'down'
  sharedZoom?: number
}>()

const emit = defineEmits<{
  (event: 'toolbar-state-change', value: HorizontalBrowseGridToolbarState): void
  (event: 'zoom-change', value: number): void
}>()

const runtime = useRuntimeStore()
const wrapRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const rawData = ref<RawWaveformData | null>(null)
const mixxxData = ref<MixxxWaveformData | null>(null)
const previewLoading = ref(false)
const previewStartSec = ref(0)
const dragging = ref(false)
const previewBarBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewBpm = ref(normalizePreviewBpm(128))
const previewBpmInput = ref(formatPreviewBpm(128))
const bpmTapTimestamps = ref<number[]>([])
const previewZoom = ref(PREVIEW_MIN_ZOOM)

const previewRenderer = createBeatAlignPreviewRenderer()

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let drawRaf = 0
let dragStartClientX = 0
let dragStartSec = 0
let persistTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null

const normalizePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const createRawPlaceholderMixxxData = (waveform: RawWaveformData): MixxxWaveformData => {
  const single = (value: number) => new Uint8Array([value])
  return {
    duration: Math.max(0, Number(waveform.duration) || 0),
    sampleRate: Math.max(1, Number(waveform.sampleRate) || 1),
    step: Math.max(
      1,
      Math.floor((Number(waveform.sampleRate) || 1) / Math.max(1, Number(waveform.rate) || 1))
    ),
    bands: {
      low: { left: single(128), right: single(128) },
      mid: { left: single(188), right: single(188) },
      high: { left: single(232), right: single(232) },
      all: { left: single(220), right: single(220) }
    }
  }
}

const resolvePreviewDurationSec = () => {
  const duration = Number(rawData.value?.duration || mixxxData.value?.duration || 0)
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

const resolveVisibleDurationSec = () =>
  resolveVisibleDurationSecByZoom(resolvePreviewDurationSec(), Number(previewZoom.value))

const resolvePreviewAnchorSec = () =>
  resolvePreviewAnchorSecByRange(
    previewStartSec.value,
    resolvePreviewDurationSec(),
    resolveVisibleDurationSec()
  )

const clampPreviewStart = (value: number) => {
  const duration = resolvePreviewDurationSec()
  const visibleDuration = resolveVisibleDurationSec()
  if (!duration || !visibleDuration) return 0
  return clampNumber(value, 0, Math.max(0, duration - visibleDuration))
}

const normalizeSharedZoom = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return PREVIEW_MIN_ZOOM
  return clampNumber(numeric, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM)
}

const clearCanvas = () => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

const drawWaveform = () => {
  const wrap = wrapRef.value
  const canvas = canvasRef.value
  if (!wrap || !canvas) return

  if (!rawData.value || !mixxxData.value) {
    previewRenderer.reset()
    clearCanvas()
    return
  }

  const duration = resolvePreviewDurationSec()
  const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
  previewStartSec.value = clampPreviewStart(previewStartSec.value)

  previewRenderer.draw({
    canvas,
    wrap,
    bpm: Number(previewBpm.value) || 128,
    firstBeatMs: Number(previewFirstBeatMs.value) || 0,
    barBeatOffset: Number(previewBarBeatOffset.value) || 0,
    rangeStartSec: previewStartSec.value,
    rangeDurationSec: visibleDuration,
    mixxxData: mixxxData.value,
    rawData: rawData.value,
    maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
    showDetailHighlights: true,
    showCenterLine: false,
    showBackground: false,
    showBeatGrid: true,
    allowScrollReuse: false,
    waveformLayout: props.direction === 'up' ? 'top-half' : 'bottom-half'
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

const emitToolbarState = () => {
  emit('toolbar-state-change', {
    disabled: !canAdjustGrid.value,
    bpmInputValue: previewBpmInput.value,
    bpmStep: PREVIEW_BPM_STEP,
    bpmMin: PREVIEW_BPM_MIN,
    bpmMax: PREVIEW_BPM_MAX,
    barLinePicking: previewBarLinePicking.value
  })
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

const syncGridStateFromSong = () => {
  previewBpm.value = normalizePreviewBpm(props.song?.bpm)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
  previewFirstBeatMs.value = Math.max(0, Number(props.song?.firstBeatMs) || 0)
  previewBarBeatOffset.value = normalizeBeatOffset(
    Number(props.song?.barBeatOffset) || 0,
    PREVIEW_BAR_BEAT_INTERVAL
  )
  resetPreviewBpmTap()
  resetBarLinePicking()
  emitToolbarState()
}

const scheduleDraw = () => {
  if (drawRaf) return
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0
    drawWaveform()
  })
}

const stopDragging = () => {
  if (!dragging.value) return
  dragging.value = false
  window.removeEventListener('mousemove', handleDragMove)
  window.removeEventListener('mouseup', stopDragging)
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
  window.addEventListener('mousemove', handleDragMove, { passive: false })
  window.addEventListener('mouseup', stopDragging, { passive: true })
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
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  previewZoom.value = clampNumber(previewZoom.value * factor, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM)
  const nextVisible = resolveVisibleDurationSec()
  previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * ratio)
  emit('zoom-change', previewZoom.value)
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

const handlePreviewBpmInputUpdate = (value: string) => {
  const parsed = parsePreviewBpmInput(value)
  if (parsed === null) {
    previewBpmInput.value = formatPreviewBpm(previewBpm.value)
    emitToolbarState()
    return
  }
  previewBpm.value = parsed
  previewBpmInput.value = formatPreviewBpm(parsed)
  resetPreviewBpmTap()
  emitToolbarState()
  scheduleDraw()
  schedulePersistGridDefinition()
}

const handlePreviewBpmInputBlur = () => {
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
  emitToolbarState()
  void persistGridDefinition()
}

const handlePreviewBpmTap = () => {
  if (!canAdjustGrid.value) return
  const now = Date.now()
  const lastTap = bpmTapTimestamps.value[bpmTapTimestamps.value.length - 1]
  if (lastTap && now - lastTap > PREVIEW_BPM_TAP_RESET_MS) {
    bpmTapTimestamps.value = []
  }
  bpmTapTimestamps.value.push(now)
  if (bpmTapTimestamps.value.length > PREVIEW_BPM_TAP_MAX_COUNT) {
    bpmTapTimestamps.value = bpmTapTimestamps.value.slice(-PREVIEW_BPM_TAP_MAX_COUNT)
  }
  schedulePreviewBpmTapReset()

  if (bpmTapTimestamps.value.length < 2) return
  const deltas: number[] = []
  for (let index = 1; index < bpmTapTimestamps.value.length; index += 1) {
    const delta = bpmTapTimestamps.value[index] - bpmTapTimestamps.value[index - 1]
    if (delta > PREVIEW_BPM_TAP_MIN_DELTA_MS && delta < PREVIEW_BPM_TAP_MAX_DELTA_MS) {
      deltas.push(delta)
    }
  }
  if (!deltas.length) return
  const avgMs = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  if (!Number.isFinite(avgMs) || avgMs <= 0) return
  previewBpm.value = normalizePreviewBpm(60000 / avgMs)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
  emitToolbarState()
  scheduleDraw()
  schedulePersistGridDefinition()
}

const toggleBarLinePicking = () => {
  handleBarLinePickingToggle()
  emitToolbarState()
}

const setBarLineAtPlayhead = () => {
  handleSetBarLineAtPlayhead()
  emitToolbarState()
  schedulePersistGridDefinition()
}

const shiftGrid = (deltaMs: number) => {
  handleGridShift(deltaMs)
  emitToolbarState()
  schedulePersistGridDefinition()
}

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  clearPersistTimer()
  previewLoading.value = false
  rawData.value = null
  mixxxData.value = null
  previewStartSec.value = 0
  previewRenderer.reset()
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) {
    syncGridStateFromSong()
    return
  }

  try {
    previewLoading.value = true
    const response = await window.electron.ipcRenderer.invoke('mixtape-waveform-raw:batch', {
      filePaths: [filePath],
      targetRate: PREVIEW_RAW_TARGET_RATE,
      preferSharedDecode: true
    })

    if (currentToken !== loadToken) return
    const picked = pickRawDataByFile(response, normalizePathKey(filePath), normalizePathKey)
    rawData.value = picked
    mixxxData.value = picked ? createRawPlaceholderMixxxData(picked) : null
    previewLoading.value = false
    syncGridStateFromSong()
    previewStartSec.value = 0
    scheduleDraw()
  } catch {
    if (currentToken !== loadToken) return
    previewLoading.value = false
    rawData.value = null
    mixxxData.value = null
    previewRenderer.reset()
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
  () => [props.song?.bpm, props.song?.firstBeatMs, props.song?.barBeatOffset] as const,
  () => {
    syncGridStateFromSong()
    previewRenderer.reset()
    scheduleDraw()
  }
)

watch(
  () => props.direction,
  () => {
    previewRenderer.reset()
    scheduleDraw()
  }
)

watch(
  () => props.sharedZoom,
  (value) => {
    const nextZoom = normalizeSharedZoom(value)
    if (Math.abs(nextZoom - previewZoom.value) <= 0.000001) return
    const anchorSec = resolvePreviewAnchorSec()
    previewZoom.value = nextZoom
    const nextVisible = resolveVisibleDurationSec()
    previewStartSec.value = clampPreviewStart(anchorSec - nextVisible * PREVIEW_PLAY_ANCHOR_RATIO)
    previewRenderer.reset()
    scheduleDraw()
  },
  { immediate: true }
)

watch(
  () => [previewBpm.value, previewFirstBeatMs.value, previewBarBeatOffset.value] as const,
  () => {
    previewRenderer.reset()
    scheduleDraw()
    emitToolbarState()
  }
)

watch(
  () => runtime.setting?.themeMode,
  () => {
    previewRenderer.reset()
    scheduleDraw()
  }
)

onMounted(() => {
  if (wrapRef.value) {
    resizeObserver = new ResizeObserver(() => {
      previewRenderer.reset()
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
  stopDragging()
  previewRenderer.dispose()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (drawRaf) {
    cancelAnimationFrame(drawRaf)
    drawRaf = 0
  }
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
    <canvas ref="canvasRef" class="raw-detail-waveform__canvas"></canvas>
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
  cursor: grab;
}

.raw-detail-waveform.is-dragging {
  cursor: grabbing;
}

.raw-detail-waveform--up {
  margin-top: auto;
}

.raw-detail-waveform--down {
  margin-bottom: auto;
}

.raw-detail-waveform__canvas {
  display: block;
  width: 100%;
  height: 100%;
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
