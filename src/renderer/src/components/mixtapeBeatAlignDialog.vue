<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
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
  (event: 'update-bar-beat-offset', value: number): void
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
const previewBarLinePicking = ref(false)
const previewBarLineHoverCenterPx = ref(0)
const previewBarLineHoverHit = ref(false)

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
const PREVIEW_SHORTCUT_BEATS = 4
const PREVIEW_BAR_BEAT_INTERVAL = 32
const PREVIEW_BAR_LINE_HIT_RADIUS_PX = 14
const PREVIEW_BAR_LINE_HIT_DIAMETER_PX = PREVIEW_BAR_LINE_HIT_RADIUS_PX * 2
const previewRenderer = createBeatAlignPreviewRenderer()

const bpmDisplay = computed(() => {
  const bpmValue = Number(props.bpm)
  if (!Number.isFinite(bpmValue) || bpmValue <= 0) return 'N/A'
  return bpmValue.toFixed(3).replace(/\.?0+$/, '')
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

const cancel = () => {
  stopPreviewPlayback({ syncPosition: false })
  closeWithAnimation(() => {
    emit('cancel')
  })
}

const normalizePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

const normalizedFilePath = computed(() => String(props.filePath || '').trim())

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
const previewBarLineHoverVisible = computed(
  () => previewBarLinePicking.value && previewBarLineHoverHit.value
)
const previewBarLineHitRangeStyle = computed(() => ({
  left: `${Math.round(previewBarLineHoverCenterPx.value - PREVIEW_BAR_LINE_HIT_RADIUS_PX)}px`,
  width: `${PREVIEW_BAR_LINE_HIT_DIAMETER_PX}px`
}))
const previewBarLineGlowStyle = computed(() => ({
  left: `${Math.round(previewBarLineHoverCenterPx.value)}px`
}))

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
    bpm: Number(props.bpm) || 0,
    firstBeatMs: Number(props.firstBeatMs) || 0,
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
  metronomeSupported,
  toggleMetronome: togglePreviewMetronome
} = useMixtapeBeatAlignMetronome({
  dialogVisible,
  previewPlaying,
  bpm: computed(() => Number(props.bpm) || 0),
  firstBeatMs: computed(() => Number(props.firstBeatMs) || 0),
  resolveAnchorSec: () => getPreviewPlaybackSec()
})

const canToggleMetronome = computed(() => {
  if (previewLoading.value) return false
  if (!previewMixxxData.value) return false
  return metronomeSupported.value
})

const handleMetronomeToggle = () => {
  if (!canToggleMetronome.value) return
  togglePreviewMetronome()
}

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

const clearPreviewBarLineHover = () => {
  previewBarLineHoverHit.value = false
}

const resolveBarLinePickCandidateByClientX = (clientX: number) => {
  const wrap = previewWrapRef.value
  if (!wrap) return null
  const bpmValue = Number(props.bpm)
  if (!Number.isFinite(bpmValue) || bpmValue <= 0) return null
  const beatSec = 60 / bpmValue
  if (!Number.isFinite(beatSec) || beatSec <= 0) return null

  const rect = wrap.getBoundingClientRect()
  if (!Number.isFinite(rect.width) || rect.width <= 0) return null
  const localX = clampNumber(clientX - rect.left, 0, rect.width)
  const ratio = localX / rect.width
  const totalDuration = resolvePreviewDurationSec()
  const visibleDuration = totalDuration > 0 ? resolveVisibleDurationSec() : 0
  const rangeDurationSec = Math.max(0.001, visibleDuration || totalDuration || 0)
  if (!Number.isFinite(rangeDurationSec) || rangeDurationSec <= 0) return null
  const rangeStartSec = totalDuration > 0 ? clampPreviewStart(previewStartSec.value) : 0
  const targetSec = rangeStartSec + ratio * rangeDurationSec
  const firstBeatSec = (Number(props.firstBeatMs) || 0) / 1000
  const beatIndex = Math.round((targetSec - firstBeatSec) / beatSec)
  if (!Number.isFinite(beatIndex)) return null
  const beatTimeSec = firstBeatSec + beatIndex * beatSec
  const lineRatio = (beatTimeSec - rangeStartSec) / rangeDurationSec
  const lineX = clampNumber(lineRatio * rect.width, 0, rect.width)
  const distancePx = Math.abs(localX - lineX)
  return {
    beatIndex,
    lineX,
    hit: distancePx <= PREVIEW_BAR_LINE_HIT_RADIUS_PX
  }
}

const updatePreviewBarLineHover = (clientX: number) => {
  if (!previewBarLinePicking.value) return
  const candidate = resolveBarLinePickCandidateByClientX(clientX)
  if (!candidate || !candidate.hit) {
    clearPreviewBarLineHover()
    return
  }
  previewBarLineHoverCenterPx.value = candidate.lineX
  previewBarLineHoverHit.value = true
}

const applyBarLineDefinitionByClientX = (clientX: number) => {
  const candidate = resolveBarLinePickCandidateByClientX(clientX)
  if (!candidate || !candidate.hit) {
    clearPreviewBarLineHover()
    return false
  }
  previewBarBeatOffset.value = normalizeBeatOffset(candidate.beatIndex, PREVIEW_BAR_BEAT_INTERVAL)
  emit('update-bar-beat-offset', previewBarBeatOffset.value)
  previewBarLinePicking.value = false
  clearPreviewBarLineHover()
  schedulePreviewDraw()
  return true
}

const handleBarLinePickingToggle = () => {
  if (previewLoading.value || !previewMixxxData.value) return
  previewBarLinePicking.value = !previewBarLinePicking.value
  clearPreviewBarLineHover()
}

const handlePreviewMouseMove = (event: MouseEvent) => {
  if (!previewBarLinePicking.value) return
  if (previewDragging.value) return
  updatePreviewBarLineHover(event.clientX)
}

const handlePreviewMouseLeave = () => {
  if (!previewBarLinePicking.value) return
  clearPreviewBarLineHover()
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
  if (previewBarLinePicking.value) {
    event.preventDefault()
    event.stopPropagation()
    if (!applyBarLineDefinitionByClientX(event.clientX)) {
      updatePreviewBarLineHover(event.clientX)
    }
    return
  }

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
  previewBarBeatOffset.value = normalizeBeatOffset(props.barBeatOffset, PREVIEW_BAR_BEAT_INTERVAL)
  previewBarLinePicking.value = false
  clearPreviewBarLineHover()
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
    previewBarLinePicking.value = false
    clearPreviewBarLineHover()
    return
  }

  if (event.code === 'Space' || event.key === ' ') {
    event.preventDefault()
    handlePreviewPlaybackToggle()
    return
  }

  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault()
    const bpmValue = Number(props.bpm)
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
  () => [props.bpm, props.firstBeatMs],
  () => {
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
      previewBarLinePicking.value = false
      clearPreviewBarLineHover()
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
  clearPreviewBarLineHover()
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
        <div class="preview-toolbar">
          <div class="preview-tools">
            <button
              class="playback-icon-btn"
              type="button"
              :disabled="!canTogglePreviewPlayback"
              :title="
                previewDecoding
                  ? t('mixtape.transportDecoding')
                  : previewPlaying
                    ? t('mixtape.pause')
                    : t('mixtape.play')
              "
              :aria-label="
                previewDecoding
                  ? t('mixtape.transportDecoding')
                  : previewPlaying
                    ? t('mixtape.pause')
                    : t('mixtape.play')
              "
              @click="handlePreviewPlaybackToggle"
            >
              <svg
                v-if="previewDecoding"
                class="is-spinning"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="8" cy="8" r="5.5"></circle>
              </svg>
              <svg
                v-else-if="previewPlaying"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="4" y="3" width="3" height="10" rx="0.9"></rect>
                <rect x="9" y="3" width="3" height="10" rx="0.9"></rect>
              </svg>
              <svg v-else viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <polygon points="5,3.5 12.5,8 5,12.5"></polygon>
              </svg>
            </button>
            <button
              class="barline-btn"
              type="button"
              :class="{ 'is-active': previewBarLinePicking }"
              :disabled="previewLoading || !previewMixxxData"
              @click="handleBarLinePickingToggle"
            >
              {{
                previewBarLinePicking
                  ? t('mixtape.gridAdjustSetBarLineCancel')
                  : t('mixtape.gridAdjustSetBarLine')
              }}
            </button>
            <button
              class="waveform-action-btn"
              type="button"
              :class="{ 'is-active': metronomeEnabled }"
              :disabled="!canToggleMetronome"
              :title="metronomeEnabled ? t('mixtape.metronomeOn') : t('mixtape.metronomeOff')"
              :aria-label="metronomeEnabled ? t('mixtape.metronomeOn') : t('mixtape.metronomeOff')"
              @click="handleMetronomeToggle"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 2h7l-1.2 11h-4.6L4.5 2Z"></path>
                <path d="M8 5.3v3.8"></path>
                <circle cx="8" cy="10.9" r="1.1"></circle>
              </svg>
              <span>{{ t('mixtape.metronome') }}</span>
            </button>
          </div>
        </div>
        <div
          ref="previewWrapRef"
          class="preview-canvas-wrap"
          :class="{ 'is-dragging': previewDragging, 'is-bar-selecting': previewBarLinePicking }"
          @mousedown="handlePreviewMouseDown"
          @mousemove="handlePreviewMouseMove"
          @mouseleave="handlePreviewMouseLeave"
          @wheel.prevent="handlePreviewWheel"
        >
          <canvas ref="previewCanvasRef" class="preview-canvas"></canvas>
          <div
            v-if="previewBarLineHoverVisible"
            class="preview-barline-hit-range"
            :style="previewBarLineHitRangeStyle"
          ></div>
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
        <div class="button" @click="cancel">{{ t('common.close') }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped src="./mixtapeBeatAlignDialog.scss"></style>
