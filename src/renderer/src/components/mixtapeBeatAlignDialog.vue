<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import MixtapeBeatAlignGridAdjustToolbar from '@renderer/components/mixtapeBeatAlignGridAdjustToolbar.vue'
import MixtapeBeatAlignTopControls from '@renderer/components/mixtapeBeatAlignTopControls.vue'
import { useMixtapeBeatAlignGridAdjust } from '@renderer/components/mixtapeBeatAlignGridAdjust'
import { rebuildBeatAlignOverviewCache } from '@renderer/components/mixtapeBeatAlignOverviewCache'
import { createBeatAlignPreviewRenderer } from '@renderer/components/mixtapeBeatAlignPreviewRenderer'
import { useMixtapeBeatAlignPlayback } from '@renderer/components/mixtapeBeatAlignPlayback'
import { useMixtapeBeatAlignMetronome } from '@renderer/components/mixtapeBeatAlignMetronome'
import { pickRawDataByFile } from '@renderer/components/mixtapeBeatAlignRawWaveform'
import {
  isValidMixxxWaveformData,
  pickMixxxDataByFile
} from '@renderer/components/mixtapeBeatAlignWaveformData'
import type { RawWaveformData, RawWaveformLevel } from '@renderer/composables/mixtape/types'
import { buildRawWaveformPyramid } from '@renderer/composables/mixtape/waveformPyramid'

const props = defineProps({
  trackTitle: {
    type: String,
    default: ''
  },
  trackKey: {
    type: String,
    default: ''
  },
  filePath: {
    type: String,
    default: ''
  },
  bpm: {
    type: Number,
    default: 128
  },
  firstBeatMs: {
    type: Number,
    default: 0
  },
  barBeatOffset: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits<{
  (event: 'cancel'): void
  (
    event: 'save-grid-definition',
    payload: { barBeatOffset: number; firstBeatMs: number; bpm: number }
  ): void
}>()

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const previewWrapRef = ref<HTMLDivElement | null>(null)
const previewCanvasRef = ref<HTMLCanvasElement | null>(null)
const overviewWrapRef = ref<HTMLDivElement | null>(null)
const overviewCanvasRef = ref<HTMLCanvasElement | null>(null)
const previewLoading = ref(false)
const previewError = ref('')
const previewMixxxData = ref<MixxxWaveformData | null>(null)
const overviewMixxxData = ref<MixxxWaveformData | null>(null)
const overviewRawData = ref<RawWaveformData | null>(null)
const PREVIEW_MIN_ZOOM = 50
const previewZoom = ref(PREVIEW_MIN_ZOOM)
const previewStartSec = ref(0)
const previewDragging = ref(false)
const overviewDragging = ref(false)
const previewBarBeatOffset = ref(0)
const previewFirstBeatMs = ref(0)
const previewBpm = ref(128)
const previewBpmInput = ref('128.00')
const bpmTapTimestamps = ref<number[]>([])

let previewRaf = 0
let overviewRaf = 0
let previewDragStartClientX = 0
let previewDragStartSec = 0
let previewDragLastAnchorSec = 0
let previewDragLastTs = 0
let previewDragScrubbing = false
let previewDragScrubToken = 0
let overviewDragStartX = 0
let overviewDragOffset = 0
let overviewDragMoved = false
let overviewSuppressClick = false
let overviewCacheCanvas: HTMLCanvasElement | null = null
let previewLoadSequence = 0
let previewWarmupTimer: ReturnType<typeof setTimeout> | null = null
let bpmTapResetTimer: ReturnType<typeof setTimeout> | null = null
const overviewRawPyramidMap = new Map<string, RawWaveformLevel[]>()
const overviewRawKey = ref('')

const PREVIEW_MAX_ZOOM = 100
const PREVIEW_HIRES_TARGET_RATE = 4000
const PREVIEW_RAW_TARGET_RATE = 2400
const PREVIEW_WARMUP_DELAY_MS = 600
const PREVIEW_WARMUP_EAGER_DELAY_MS = 0
const OVERVIEW_MAX_RENDER_COLUMNS = 960
const OVERVIEW_IS_HALF_WAVEFORM = false
const OVERVIEW_WAVEFORM_VERTICAL_PADDING = 8
const PREVIEW_MAX_SAMPLES_PER_PIXEL = 180
const PREVIEW_PLAY_MAX_SAMPLES_PER_PIXEL = 20
const PREVIEW_PLAY_ANCHOR_RATIO = 1 / 3
const PREVIEW_SHORTCUT_FALLBACK_BPM = 128
const PREVIEW_BPM_DECIMALS = 2
const PREVIEW_BPM_STEP = 0.01
const PREVIEW_BPM_MIN = 1
const PREVIEW_BPM_MAX = 300
const PREVIEW_SHORTCUT_BEATS = 4
const PREVIEW_BAR_BEAT_INTERVAL = 32
const PREVIEW_BAR_LINE_HIT_RADIUS_PX = 14
const PREVIEW_GRID_SHIFT_SMALL_MS = 5
const PREVIEW_GRID_SHIFT_LARGE_MS = 20
const PREVIEW_BPM_TAP_RESET_MS = 5000
const PREVIEW_BPM_TAP_MIN_DELTA_MS = 50
const PREVIEW_BPM_TAP_MAX_DELTA_MS = 2000
const PREVIEW_BPM_TAP_MAX_COUNT = 8
const previewRenderer = createBeatAlignPreviewRenderer()

const bpmDisplay = computed(() => {
  const bpmValue = Number(previewBpm.value)
  if (!Number.isFinite(bpmValue) || bpmValue <= 0) return 'N/A'
  return bpmValue.toFixed(PREVIEW_BPM_DECIMALS)
})

const trackKeyDisplay = computed(() => {
  const raw = String(props.trackKey || '').trim()
  if (!raw) return ''
  return raw.toLowerCase() === 'o' ? '-' : raw
})

const trackMetaDisplay = computed(() => {
  const chunks = [`${t('mixtape.bpm')} ${bpmDisplay.value}`]
  if (trackKeyDisplay.value) {
    chunks.push(`${t('columns.key')} ${trackKeyDisplay.value}`)
  }
  return chunks.join(' · ')
})

const trackNameTitle = computed(() => {
  const title = String(props.trackTitle || '').trim()
  const meta = trackMetaDisplay.value
  if (!title) return meta
  return meta ? `${title} · ${meta}` : title
})

const normalizePreviewBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return PREVIEW_SHORTCUT_FALLBACK_BPM
  const clamped = Math.max(PREVIEW_BPM_MIN, Math.min(PREVIEW_BPM_MAX, numeric))
  return Number(clamped.toFixed(PREVIEW_BPM_DECIMALS))
}

const formatPreviewBpm = (value: unknown) =>
  normalizePreviewBpm(value).toFixed(PREVIEW_BPM_DECIMALS)

const parsePreviewBpmInput = (value: string) => {
  const normalized = String(value || '')
    .trim()
    .replace(',', '.')
  if (!normalized) return null
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return null
  const numeric = Number(normalized)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return normalizePreviewBpm(numeric)
}

const syncPreviewBpmFromProps = () => {
  previewBpm.value = normalizePreviewBpm(props.bpm)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
  resetPreviewBpmTap()
}

const handlePreviewBpmInputUpdate = (value: string) => {
  const parsed = parsePreviewBpmInput(value)
  if (parsed === null) {
    previewBpmInput.value = formatPreviewBpm(previewBpm.value)
    return
  }
  previewBpm.value = parsed
  previewBpmInput.value = formatPreviewBpm(parsed)
  resetPreviewBpmTap()
}

const handlePreviewBpmInputBlur = () => {
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
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
  for (let i = 1; i < bpmTapTimestamps.value.length; i += 1) {
    const delta = bpmTapTimestamps.value[i] - bpmTapTimestamps.value[i - 1]
    if (delta > PREVIEW_BPM_TAP_MIN_DELTA_MS && delta < PREVIEW_BPM_TAP_MAX_DELTA_MS) {
      deltas.push(delta)
    }
  }
  if (!deltas.length) return
  const avgMs = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  if (!Number.isFinite(avgMs) || avgMs <= 0) return
  const tappedBpm = 60000 / avgMs
  previewBpm.value = normalizePreviewBpm(tappedBpm)
  previewBpmInput.value = formatPreviewBpm(previewBpm.value)
}

const closeDialog = () => {
  stopPreviewPlayback({ syncPosition: false })
  closeWithAnimation(() => emit('cancel'))
}

const cancel = () => closeDialog()

const save = () => {
  emit('save-grid-definition', {
    barBeatOffset: normalizeBeatOffset(previewBarBeatOffset.value, PREVIEW_BAR_BEAT_INTERVAL),
    firstBeatMs: Math.max(0, Number(previewFirstBeatMs.value) || 0),
    bpm: normalizePreviewBpm(previewBpm.value)
  })
  closeDialog()
}

const normalizePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const normalizedFilePath = computed(() => String(props.filePath || '').trim())
syncPreviewBpmFromProps()

const resolvePreviewDurationSec = () => {
  const mixxxDuration = Number(previewMixxxData.value?.duration || 0)
  if (Number.isFinite(mixxxDuration) && mixxxDuration > 0) return mixxxDuration
  return 0
}

const resolveVisibleDurationSec = () => {
  const total = resolvePreviewDurationSec()
  if (!total) return 0
  const zoomValue = Number(previewZoom.value)
  const safeZoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : PREVIEW_MIN_ZOOM
  return total / safeZoom
}

const resolvePreviewLeadingPadSec = () => {
  const visible = resolveVisibleDurationSec()
  if (!Number.isFinite(visible) || visible <= 0) return 0
  return visible * PREVIEW_PLAY_ANCHOR_RATIO
}

const resolvePreviewVirtualSpanSec = () => {
  const total = resolvePreviewDurationSec()
  const leadingPad = resolvePreviewLeadingPadSec()
  return Math.max(0.0001, total + leadingPad)
}

const clampPreviewStart = (value: number) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  if (!total || !visible) return 0
  const minStart = -resolvePreviewLeadingPadSec()
  const maxStart = Math.max(0, total - visible)
  return Math.max(minStart, Math.min(maxStart, value))
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

const resolvePreviewAnchorSec = (startSec: number = previewStartSec.value) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  if (!total || !visible) return 0
  const safeStart = clampPreviewStart(startSec)
  return clampNumber(safeStart + visible * PREVIEW_PLAY_ANCHOR_RATIO, 0, total)
}

const resolveOverviewViewportMetrics = () => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  const leadingPad = resolvePreviewLeadingPadSec()
  const virtualSpan = resolvePreviewVirtualSpanSec()
  const wrapWidth = Math.max(0, Number(overviewWrapRef.value?.clientWidth || 0))
  if (!total || !visible || wrapWidth <= 0) {
    return { left: 0, width: 0, wrapWidth: 0 }
  }
  const safeVisible = clampNumber(visible, 0.0001, total)
  if (safeVisible >= virtualSpan) {
    return { left: 0, width: wrapWidth, wrapWidth }
  }
  const rawWidth = (safeVisible / virtualSpan) * wrapWidth
  const width = clampNumber(rawWidth, 12, wrapWidth)
  const maxLeftTime = Math.max(0, virtualSpan - safeVisible)
  const safeStart = clampPreviewStart(previewStartSec.value)
  const leftTime = safeStart + leadingPad
  const startRatio = maxLeftTime > 0 ? leftTime / maxLeftTime : 0
  const maxLeft = Math.max(0, wrapWidth - width)
  const left = startRatio * maxLeft
  return { left, width, wrapWidth }
}

const overviewViewportStyle = computed(() => {
  const { left, width } = resolveOverviewViewportMetrics()
  return {
    transform: `translate3d(${left}px, 0, 0)`,
    width: `${width}px`,
    opacity: width > 0 ? '1' : '0'
  }
})

const resizePreviewCanvas = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
) => {
  const pixelRatio = window.devicePixelRatio || 1
  const scaledWidth = Math.max(1, Math.floor(width * pixelRatio))
  const scaledHeight = Math.max(1, Math.floor(height * pixelRatio))
  if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
    canvas.width = scaledWidth
    canvas.height = scaledHeight
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(pixelRatio, pixelRatio)
}

const drawPreviewCanvas = () => {
  const canvas = previewCanvasRef.value
  const wrap = previewWrapRef.value
  if (!canvas || !wrap) return

  const totalDuration = resolvePreviewDurationSec()
  const visibleDuration = totalDuration > 0 ? resolveVisibleDurationSec() : 0
  const safeDuration = Math.max(0.001, visibleDuration || totalDuration || 1)
  const rangeStartSec = totalDuration > 0 ? clampPreviewStart(previewStartSec.value) : 0

  if (totalDuration > 0) {
    previewStartSec.value = rangeStartSec
  } else {
    previewStartSec.value = 0
  }
  const isPlaybackRendering = previewPlaying.value && !previewDragging.value
  previewRenderer.draw({
    canvas,
    wrap,
    bpm: Number(previewBpm.value) || 0,
    firstBeatMs: Number(previewFirstBeatMs.value) || 0,
    barBeatOffset: previewBarBeatOffset.value,
    rangeStartSec,
    rangeDurationSec: safeDuration,
    mixxxData: previewMixxxData.value,
    maxSamplesPerPixel: isPlaybackRendering
      ? PREVIEW_PLAY_MAX_SAMPLES_PER_PIXEL
      : PREVIEW_MAX_SAMPLES_PER_PIXEL,
    showDetailHighlights: !isPlaybackRendering,
    showCenterLine: true
  })
}

const drawOverviewCanvas = () => {
  const canvas = overviewCanvasRef.value
  const wrap = overviewWrapRef.value
  if (!canvas || !wrap) return

  const width = Math.max(1, Math.floor(wrap.clientWidth))
  const height = Math.max(1, Math.floor(wrap.clientHeight))
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  resizePreviewCanvas(canvas, ctx, width, height)

  if (overviewCacheCanvas) {
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
      overviewCacheCanvas,
      0,
      0,
      overviewCacheCanvas.width,
      overviewCacheCanvas.height,
      0,
      0,
      width,
      height
    )
  }
}

const schedulePreviewDraw = () => {
  if (previewRaf) return
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0
    drawPreviewCanvas()
  })
}

const {
  previewPlaying,
  previewDecoding,
  previewAnchorStyle,
  canTogglePreviewPlayback,
  startPreviewScrub,
  updatePreviewScrub,
  stopPreviewScrub,
  seekPreviewAnchorSec,
  nudgePreviewBySec,
  getPreviewPlaybackSec,
  handlePreviewPlaybackToggle,
  warmupPreviewPlayback,
  stopPreviewPlayback,
  cleanupPreviewPlayback
} = useMixtapeBeatAlignPlayback({
  filePathRef: normalizedFilePath,
  previewLoading,
  previewMixxxData,
  previewStartSec,
  resolveVisibleDurationSec,
  resolvePreviewDurationSec,
  clampPreviewStart,
  schedulePreviewDraw,
  isViewportInteracting: () => previewDragging.value || overviewDragging.value
})

const {
  metronomeEnabled,
  metronomeVolumeLevel,
  metronomeSupported,
  setMetronomeEnabled,
  setMetronomeVolumeLevel
} = useMixtapeBeatAlignMetronome({
  dialogVisible,
  previewPlaying,
  bpm: computed(() => Number(previewBpm.value) || 0),
  firstBeatMs: computed(() => Number(previewFirstBeatMs.value) || 0),
  resolveAnchorSec: () => getPreviewPlaybackSec()
})

const canToggleMetronome = computed(() => {
  if (previewLoading.value) return false
  if (!previewMixxxData.value) return false
  return metronomeSupported.value
})

const canAdjustMetronomeVolume = computed(() => canToggleMetronome.value)

const canStopPreviewPlayback = computed(() => {
  if (previewPlaying.value) return true
  if (previewLoading.value) return false
  return !!previewMixxxData.value
})

const handleMetronomeToggle = () => {
  if (!canToggleMetronome.value) return
  setMetronomeEnabled(!metronomeEnabled.value)
}

const handleMetronomeVolumeCycle = () => {
  if (!canAdjustMetronomeVolume.value) return
  const currentLevel = Number(metronomeVolumeLevel.value)
  const nextLevel = currentLevel >= 3 ? 1 : ((currentLevel + 1) as 1 | 2 | 3)
  setMetronomeVolumeLevel(nextLevel)
}

const handlePreviewStopToStart = () => {
  stopPreviewPlayback({ syncPosition: false })
  previewStartSec.value = clampPreviewStart(-resolvePreviewLeadingPadSec())
  schedulePreviewDraw()
}

const previewFirstBeatMsComputed = computed(() => Number(previewFirstBeatMs.value) || 0)

const {
  canAdjustGrid,
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
  previewWrapRef,
  previewLoading,
  previewMixxxData,
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
  getPreviewPlaybackSec,
  schedulePreviewDraw,
  barBeatInterval: PREVIEW_BAR_BEAT_INTERVAL,
  barLineHitRadiusPx: PREVIEW_BAR_LINE_HIT_RADIUS_PX
})

const clearPreviewWarmupTimer = () => {
  if (!previewWarmupTimer) return
  clearTimeout(previewWarmupTimer)
  previewWarmupTimer = null
}
const schedulePreviewWarmup = (
  filePath: string,
  requestSeq: number,
  delayMs: number = PREVIEW_WARMUP_DELAY_MS
) => {
  clearPreviewWarmupTimer()
  const normalized = filePath.trim()
  if (!normalized) return
  previewWarmupTimer = setTimeout(
    () => {
      previewWarmupTimer = null
      if (requestSeq !== previewLoadSequence) return
      if (normalizePathKey(props.filePath) !== normalizePathKey(normalized)) return
      void warmupPreviewPlayback(normalized)
    },
    Math.max(0, Number(delayMs) || 0)
  )
}
const rebuildOverviewCache = () => {
  overviewCacheCanvas = rebuildBeatAlignOverviewCache({
    wrap: overviewWrapRef.value,
    cacheCanvas: overviewCacheCanvas,
    mixxxData: overviewMixxxData.value,
    rawData: overviewRawData.value,
    rawPyramidMap: overviewRawPyramidMap,
    rawKey: overviewRawKey.value,
    maxRenderColumns: OVERVIEW_MAX_RENDER_COLUMNS,
    isHalfWaveform: OVERVIEW_IS_HALF_WAVEFORM,
    waveformVerticalPadding: OVERVIEW_WAVEFORM_VERTICAL_PADDING,
    leadingPadSec: resolvePreviewLeadingPadSec()
  })
}

const scheduleOverviewRebuild = () => {
  if (overviewRaf) return
  overviewRaf = requestAnimationFrame(() => {
    overviewRaf = 0
    rebuildOverviewCache()
    drawOverviewCanvas()
  })
}

const setPreviewZoom = (targetZoom: number, anchorRatio: number = 0.5) => {
  const total = resolvePreviewDurationSec()
  if (!total) return
  const clampedZoom = Math.max(PREVIEW_MIN_ZOOM, Math.min(PREVIEW_MAX_ZOOM, targetZoom))
  const beforeDuration = resolveVisibleDurationSec()
  const anchor = previewStartSec.value + beforeDuration * Math.max(0, Math.min(1, anchorRatio))
  previewZoom.value = clampedZoom
  const nextDuration = resolveVisibleDurationSec()
  previewStartSec.value = clampPreviewStart(anchor - nextDuration * anchorRatio)
  schedulePreviewDraw()
}

const handlePreviewWheel = (event: WheelEvent) => {
  const wrap = previewWrapRef.value
  if (!wrap) return
  event.preventDefault()
  stopPreviewPlayback({ syncPosition: true })

  const rect = wrap.getBoundingClientRect()
  const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  setPreviewZoom(previewZoom.value * factor, Math.max(0, Math.min(1, ratio)))
}

const handlePreviewDragMove = (event: MouseEvent) => {
  if (!previewDragging.value) return

  const wrap = previewWrapRef.value
  if (!wrap) return

  const width = Math.max(1, wrap.clientWidth)
  const visibleDuration = resolveVisibleDurationSec()
  if (!visibleDuration) return

  const deltaX = event.clientX - previewDragStartClientX
  const deltaSec = (deltaX / width) * visibleDuration
  previewStartSec.value = clampPreviewStart(previewDragStartSec - deltaSec)

  const anchorSec = resolvePreviewAnchorSec(previewStartSec.value)
  const now = performance.now()
  if (previewDragScrubbing) {
    const dtSec = Math.max(0.001, (now - previewDragLastTs) / 1000)
    const velocitySecPerSec = (anchorSec - previewDragLastAnchorSec) / dtSec
    updatePreviewScrub(anchorSec, velocitySecPerSec)
  }
  previewDragLastAnchorSec = anchorSec
  previewDragLastTs = now
  schedulePreviewDraw()
}

const stopPreviewDragging = () => {
  if (!previewDragging.value) return
  previewDragging.value = false
  window.removeEventListener('mousemove', handlePreviewDragMove)
  window.removeEventListener('mouseup', stopPreviewDragging)
  const finalAnchorSec = resolvePreviewAnchorSec()
  previewDragScrubToken += 1
  if (previewDragScrubbing) {
    previewDragScrubbing = false
    void stopPreviewScrub(finalAnchorSec)
  } else if (previewPlaying.value) {
    void seekPreviewAnchorSec(finalAnchorSec)
  }
  schedulePreviewDraw()
}

const handlePreviewMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) return
  if (!previewMixxxData.value) return
  if (handlePreviewMouseDownForBarLinePicking(event)) return

  previewDragging.value = true
  previewDragStartClientX = event.clientX
  previewDragStartSec = previewStartSec.value
  previewDragLastAnchorSec = resolvePreviewAnchorSec(previewDragStartSec)
  previewDragLastTs = performance.now()
  previewDragScrubbing = false
  if (previewPlaying.value) {
    const token = ++previewDragScrubToken
    void startPreviewScrub(previewDragLastAnchorSec).then((started) => {
      if (!started) return
      if (token !== previewDragScrubToken || !previewDragging.value) {
        void stopPreviewScrub(resolvePreviewAnchorSec())
        return
      }
      previewDragScrubbing = true
      previewDragLastAnchorSec = resolvePreviewAnchorSec()
      previewDragLastTs = performance.now()
      updatePreviewScrub(previewDragLastAnchorSec, 0)
    })
  }
  window.addEventListener('mousemove', handlePreviewDragMove, { passive: false })
  window.addEventListener('mouseup', stopPreviewDragging, { passive: true })
}

const resolveOverviewPointer = (event: MouseEvent) => {
  const rect = overviewWrapRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return null
  const x = clampNumber(event.clientX - rect.left, 0, rect.width)
  return { rect, x }
}

const setPreviewStartByOverviewCenterRatio = (ratio: number) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  const leadingPad = resolvePreviewLeadingPadSec()
  const virtualSpan = resolvePreviewVirtualSpanSec()
  if (!total || !visible || !virtualSpan) return
  const safeRatio = clampNumber(ratio, 0, 1)
  const targetCenter = safeRatio * virtualSpan
  previewStartSec.value = clampPreviewStart(targetCenter - visible / 2 - leadingPad)
  schedulePreviewDraw()
}

const setPreviewStartByOverviewLeft = (left: number) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  const leadingPad = resolvePreviewLeadingPadSec()
  const virtualSpan = resolvePreviewVirtualSpanSec()
  const { width, wrapWidth } = resolveOverviewViewportMetrics()
  if (!total || !visible || wrapWidth <= 0 || !virtualSpan) return
  const maxLeft = Math.max(0, wrapWidth - width)
  const clampedLeft = clampNumber(left, 0, maxLeft)
  const maxLeftTime = Math.max(0, virtualSpan - visible)
  const leftTime = maxLeft > 0 ? (clampedLeft / maxLeft) * maxLeftTime : 0
  previewStartSec.value = clampPreviewStart(leftTime - leadingPad)
  schedulePreviewDraw()
}

const handleOverviewMouseMove = (event: MouseEvent) => {
  if (!overviewDragging.value) return
  const pointer = resolveOverviewPointer(event)
  if (!pointer) return
  const { x, rect } = pointer
  if (!overviewDragMoved && Math.abs(x - overviewDragStartX) > 2) {
    overviewDragMoved = true
  }
  const { width } = resolveOverviewViewportMetrics()
  const maxLeft = Math.max(0, rect.width - width)
  const nextLeft = clampNumber(x - overviewDragOffset, 0, maxLeft)
  setPreviewStartByOverviewLeft(nextLeft)
  event.preventDefault()
}

const stopOverviewDragging = () => {
  if (!overviewDragging.value) return
  overviewDragging.value = false
  overviewSuppressClick = overviewDragMoved
  overviewDragMoved = false
  window.removeEventListener('mousemove', handleOverviewMouseMove)
  window.removeEventListener('mouseup', stopOverviewDragging)
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = ''
  }
  if (previewPlaying.value) {
    void seekPreviewAnchorSec(resolvePreviewAnchorSec())
  }
  schedulePreviewDraw()
}

const handleOverviewMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) return
  if (!previewMixxxData.value) return
  const pointer = resolveOverviewPointer(event)
  if (!pointer) return
  const { x, rect } = pointer
  const { left, width } = resolveOverviewViewportMetrics()

  overviewDragStartX = x
  overviewDragMoved = false
  overviewSuppressClick = false

  if (width > 0 && x >= left && x <= left + width) {
    overviewDragOffset = x - left
  } else {
    overviewDragOffset = width > 0 ? width / 2 : 0
    setPreviewStartByOverviewCenterRatio(x / rect.width)
  }

  overviewDragging.value = true
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = 'none'
  }
  window.addEventListener('mousemove', handleOverviewMouseMove, { passive: false })
  window.addEventListener('mouseup', stopOverviewDragging, { passive: true })
  event.preventDefault()
}

const handleOverviewClick = (event: MouseEvent) => {
  if (overviewSuppressClick) {
    overviewSuppressClick = false
    return
  }
  const pointer = resolveOverviewPointer(event)
  if (!pointer) return
  setPreviewStartByOverviewCenterRatio(pointer.x / pointer.rect.width)
  if (previewPlaying.value) {
    void seekPreviewAnchorSec(resolvePreviewAnchorSec())
  }
}

const fetchOverviewWaveformFromCache = async (filePath: string) => {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized || !window?.electron?.ipcRenderer?.invoke) {
    overviewMixxxData.value = null
    overviewRawData.value = null
    overviewRawKey.value = ''
    overviewRawPyramidMap.clear()
    scheduleOverviewRebuild()
    return
  }
  const fileKey = normalizePathKey(normalized)
  const cacheResult = await window.electron.ipcRenderer
    .invoke('mixtape-waveform-cache:batch', {
      filePaths: [normalized]
    })
    .catch(() => null)
  overviewMixxxData.value = pickMixxxDataByFile(cacheResult, fileKey, normalizePathKey)
  scheduleOverviewRebuild()
}

const handleMixtapeWaveformUpdated = (_event: any, payload: { filePath?: string }) => {
  const currentKey = normalizePathKey(props.filePath)
  const updatedKey = normalizePathKey(payload?.filePath)
  if (!currentKey || !updatedKey || currentKey !== updatedKey) return
  void fetchOverviewWaveformFromCache(props.filePath)
}

const loadPreviewWaveform = async (filePath: string) => {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  const requestSeq = ++previewLoadSequence
  clearPreviewWarmupTimer()
  stopPreviewPlayback({ syncPosition: false })
  previewRenderer.reset()
  previewLoading.value = false
  previewMixxxData.value = null
  overviewMixxxData.value = null
  overviewRawData.value = null
  overviewRawKey.value = ''
  overviewRawPyramidMap.clear()
  previewError.value = ''
  previewZoom.value = PREVIEW_MIN_ZOOM
  previewStartSec.value = 0
  syncPreviewBpmFromProps()
  previewBarBeatOffset.value = normalizeBeatOffset(props.barBeatOffset, PREVIEW_BAR_BEAT_INTERVAL)
  previewFirstBeatMs.value = Math.max(0, Number(props.firstBeatMs) || 0)
  resetBarLinePicking()
  stopPreviewDragging()
  stopOverviewDragging()
  schedulePreviewDraw()
  scheduleOverviewRebuild()
  if (!normalized || !window?.electron?.ipcRenderer?.invoke) {
    previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
    schedulePreviewDraw()
    scheduleOverviewRebuild()
    return
  }
  previewLoading.value = true
  // 对话框一打开即开始预解码，避免用户首次点击播放时才触发解码等待
  schedulePreviewWarmup(normalized, requestSeq, PREVIEW_WARMUP_EAGER_DELAY_MS)
  try {
    const fileKey = normalizePathKey(normalized)
    const hiresPromise = window.electron.ipcRenderer
      .invoke('mixtape-waveform-hires:batch', {
        filePaths: [normalized],
        targetRate: PREVIEW_HIRES_TARGET_RATE
      })
      .catch(() => null)
    const cachePromise = window.electron.ipcRenderer
      .invoke('mixtape-waveform-cache:batch', {
        filePaths: [normalized]
      })
      .catch(() => null)
    const rawPromise = window.electron.ipcRenderer
      .invoke('mixtape-waveform-raw:batch', {
        filePaths: [normalized],
        targetRate: PREVIEW_RAW_TARGET_RATE
      })
      .catch(() => null)
    const [hiresResult, cacheResult] = await Promise.all([hiresPromise, cachePromise])
    if (requestSeq !== previewLoadSequence) return
    previewMixxxData.value = pickMixxxDataByFile(hiresResult, fileKey, normalizePathKey)
    overviewMixxxData.value = pickMixxxDataByFile(cacheResult, fileKey, normalizePathKey)
    if (
      !isValidMixxxWaveformData(previewMixxxData.value) &&
      isValidMixxxWaveformData(overviewMixxxData.value)
    ) {
      previewMixxxData.value = overviewMixxxData.value
    }
    if (previewMixxxData.value) {
      previewStartSec.value = clampPreviewStart(-resolvePreviewLeadingPadSec())
    }
    if (!overviewMixxxData.value) {
      try {
        window.electron.ipcRenderer.send('mixtape-waveform:queue-visible', {
          filePaths: [normalized]
        })
      } catch {}
    }
    if (!previewMixxxData.value) {
      previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
    }
    previewLoading.value = false
    schedulePreviewDraw()
    scheduleOverviewRebuild()
    const rawResult = await rawPromise
    if (requestSeq !== previewLoadSequence) return
    overviewRawData.value = pickRawDataByFile(rawResult, fileKey, normalizePathKey)
    overviewRawKey.value = fileKey
    if (overviewRawData.value) {
      overviewRawPyramidMap.set(fileKey, buildRawWaveformPyramid(overviewRawData.value))
    } else {
      overviewRawPyramidMap.delete(fileKey)
    }
    scheduleOverviewRebuild()
  } catch {
    if (requestSeq !== previewLoadSequence) return
    previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
    previewLoading.value = false
    schedulePreviewDraw()
    scheduleOverviewRebuild()
  }
}

const handleWindowResize = () => {
  schedulePreviewDraw()
  scheduleOverviewRebuild()
}

const isEditableEventTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = element.tagName?.toLowerCase() || ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (!dialogVisible.value) return
  if (isEditableEventTarget(event.target)) return

  if (event.code === 'Escape' && previewBarLinePicking.value) {
    event.preventDefault()
    resetBarLinePicking()
    return
  }

  if (event.code === 'Space' || event.key === ' ') {
    event.preventDefault()
    handlePreviewPlaybackToggle()
    return
  }

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault()
    const bpmValue = Number(previewBpm.value)
    const safeBpm =
      Number.isFinite(bpmValue) && bpmValue > 0 ? bpmValue : PREVIEW_SHORTCUT_FALLBACK_BPM
    const deltaSec = (60 / safeBpm) * PREVIEW_SHORTCUT_BEATS
    void nudgePreviewBySec(event.code === 'ArrowLeft' ? -deltaSec : deltaSec)
  }
}

watch(
  () => props.filePath,
  (nextPath) => {
    void loadPreviewWaveform(nextPath)
  },
  { immediate: true }
)

watch(
  () => props.bpm,
  () => {
    syncPreviewBpmFromProps()
  }
)

watch(
  () => previewBpm.value,
  () => {
    schedulePreviewDraw()
  }
)

watch(
  () => props.firstBeatMs,
  (next) => {
    previewFirstBeatMs.value = Math.max(0, Number(next) || 0)
    schedulePreviewDraw()
  }
)

watch(
  () => props.barBeatOffset,
  (next) => {
    const normalized = normalizeBeatOffset(next, PREVIEW_BAR_BEAT_INTERVAL)
    if (previewBarBeatOffset.value === normalized) return
    previewBarBeatOffset.value = normalized
    schedulePreviewDraw()
  }
)

watch(
  () => dialogVisible.value,
  (visible) => {
    if (visible) {
      schedulePreviewDraw()
      scheduleOverviewRebuild()
    } else {
      resetPreviewBpmTap()
      resetBarLinePicking()
      stopPreviewPlayback({ syncPosition: false })
    }
  }
)

onMounted(() => {
  window.addEventListener('resize', handleWindowResize, { passive: true })
  window.addEventListener('keydown', handleWindowKeydown)
  try {
    window.electron.ipcRenderer.on('mixtape-waveform-updated', handleMixtapeWaveformUpdated)
  } catch {}
})

onBeforeUnmount(() => {
  previewLoadSequence += 1
  clearPreviewWarmupTimer()
  resetPreviewBpmTap()
  cleanupPreviewPlayback()
  previewRenderer.dispose()
  if (previewRaf) {
    cancelAnimationFrame(previewRaf)
    previewRaf = 0
  }
  if (overviewRaf) {
    cancelAnimationFrame(overviewRaf)
    overviewRaf = 0
  }
  overviewCacheCanvas = null
  overviewRawPyramidMap.clear()
  resetBarLinePicking()
  stopPreviewDragging()
  stopOverviewDragging()
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener('keydown', handleWindowKeydown)
  try {
    window.electron.ipcRenderer.removeListener(
      'mixtape-waveform-updated',
      handleMixtapeWaveformUpdated
    )
  } catch {}
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      v-dialog-drag="'.dialog-title'"
      class="inner"
      style="width: 820px; height: 520px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>{{ t('mixtape.beatAlignDialogTitle') }}</span>
      </div>
      <div class="dialog-body">
        <div v-if="trackTitle" class="track-name" :title="trackNameTitle">
          <span class="track-name__title">{{ trackTitle }}</span>
          <span class="track-name__meta"> · {{ trackMetaDisplay }}</span>
        </div>
        <MixtapeBeatAlignTopControls
          :preview-decoding="previewDecoding"
          :preview-playing="previewPlaying"
          :can-toggle-preview-playback="canTogglePreviewPlayback"
          :can-stop-preview-playback="canStopPreviewPlayback"
          :can-adjust-grid="canAdjustGrid"
          :preview-bar-line-picking="previewBarLinePicking"
          :metronome-enabled="metronomeEnabled"
          :metronome-volume-level="metronomeVolumeLevel"
          :can-toggle-metronome="canToggleMetronome"
          :can-adjust-metronome-volume="canAdjustMetronomeVolume"
          @toggle-playback="handlePreviewPlaybackToggle"
          @stop-to-start="handlePreviewStopToStart"
          @toggle-barline-pick="handleBarLinePickingToggle"
          @toggle-metronome="handleMetronomeToggle"
          @cycle-metronome-volume="handleMetronomeVolumeCycle"
        />
        <div
          ref="previewWrapRef"
          class="preview-canvas-wrap"
          :class="{ 'is-dragging': previewDragging, 'is-bar-selecting': previewBarLinePicking }"
          @mousedown="handlePreviewMouseDown"
          @mousemove="handlePreviewMouseMoveForBarLinePicking"
          @mouseleave="handlePreviewMouseLeaveForBarLinePicking"
          @wheel.prevent="handlePreviewWheel"
        >
          <canvas ref="previewCanvasRef" class="preview-canvas"></canvas>
          <div
            v-if="previewBarLineHoverVisible"
            class="preview-barline-glow"
            :style="previewBarLineGlowStyle"
          ></div>
          <div
            class="preview-anchor-line"
            :class="{ 'is-active': previewPlaying }"
            :style="previewAnchorStyle"
          ></div>
          <div v-if="previewLoading" class="preview-status">
            {{ t('mixtape.gridAdjustWaveformLoading') }}
          </div>
          <div v-else-if="previewError" class="preview-status is-error">
            {{ previewError }}
          </div>
        </div>
        <MixtapeBeatAlignGridAdjustToolbar
          :disabled="!canAdjustGrid"
          :bpm-input-value="previewBpmInput"
          :bpm-step="PREVIEW_BPM_STEP"
          :bpm-min="PREVIEW_BPM_MIN"
          :bpm-max="PREVIEW_BPM_MAX"
          @set-bar-line="handleSetBarLineAtPlayhead"
          @shift-left-large="handleGridShift(-PREVIEW_GRID_SHIFT_LARGE_MS)"
          @shift-left-small="handleGridShift(-PREVIEW_GRID_SHIFT_SMALL_MS)"
          @shift-right-small="handleGridShift(PREVIEW_GRID_SHIFT_SMALL_MS)"
          @shift-right-large="handleGridShift(PREVIEW_GRID_SHIFT_LARGE_MS)"
          @update-bpm-input="handlePreviewBpmInputUpdate"
          @blur-bpm-input="handlePreviewBpmInputBlur"
          @tap-bpm="handlePreviewBpmTap"
        />
        <div
          ref="overviewWrapRef"
          class="overview-canvas-wrap"
          :class="{ 'is-dragging': overviewDragging }"
          @mousedown="handleOverviewMouseDown"
          @click="handleOverviewClick"
        >
          <canvas ref="overviewCanvasRef" class="overview-canvas"></canvas>
          <div class="overview-viewport" :style="overviewViewportStyle"></div>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" @click="save">{{ t('common.save') }}</div>
        <div class="button" @click="cancel">{{ t('common.cancel') }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped src="./mixtapeBeatAlignDialog.scss"></style>
