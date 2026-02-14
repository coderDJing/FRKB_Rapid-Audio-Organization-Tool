<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'
import { drawMixxxRgbWaveform } from '@renderer/composables/mixtape/waveformDraw'
import type { RawWaveformData, RawWaveformLevel } from '@renderer/composables/mixtape/types'
import {
  buildRawWaveformPyramid,
  resolveRawWaveformLevel
} from '@renderer/composables/mixtape/waveformPyramid'

const props = defineProps({
  trackTitle: {
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
  masterTempo: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits<{
  (event: 'cancel'): void
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

let previewRaf = 0
let overviewRaf = 0
let previewDragStartClientX = 0
let previewDragStartSec = 0
let overviewDragStartX = 0
let overviewDragOffset = 0
let overviewDragMoved = false
let overviewSuppressClick = false
let overviewCacheCanvas: HTMLCanvasElement | null = null
const overviewRawPyramidMap = new Map<string, RawWaveformLevel[]>()
const overviewRawKey = ref('')

const PREVIEW_MAX_ZOOM = 100
const PREVIEW_HIRES_TARGET_RATE = 44100
const PREVIEW_RAW_TARGET_RATE = 2400
const OVERVIEW_MAX_RENDER_COLUMNS = 960
const OVERVIEW_IS_HALF_WAVEFORM = false
const OVERVIEW_WAVEFORM_VERTICAL_PADDING = 8
const PREVIEW_DRAG_MAX_SAMPLES_PER_PIXEL = 20
const PREVIEW_IDLE_MAX_SAMPLES_PER_PIXEL = 180

const bpmDisplay = computed(() => {
  const bpmValue = Number(props.bpm)
  if (!Number.isFinite(bpmValue) || bpmValue <= 0) return 'N/A'
  return bpmValue.toFixed(3).replace(/\.?0+$/, '')
})

const firstBeatDisplay = computed(() => {
  const value = Number(props.firstBeatMs)
  if (!Number.isFinite(value)) return '0 ms'
  return `${Math.round(value)} ms`
})

const masterTempoDisplay = computed(() => (props.masterTempo !== false ? 'ON' : 'OFF'))

const cancel = () => {
  closeWithAnimation(() => {
    emit('cancel')
  })
}

const normalizePathKey = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()

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

const clampPreviewStart = (value: number) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  if (!total || !visible) return 0
  const maxStart = Math.max(0, total - visible)
  return Math.max(0, Math.min(maxStart, value))
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveOverviewViewportMetrics = () => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  const wrapWidth = Math.max(0, Number(overviewWrapRef.value?.clientWidth || 0))
  if (!total || !visible || wrapWidth <= 0) {
    return { left: 0, width: 0, wrapWidth: 0 }
  }
  const safeVisible = clampNumber(visible, 0.0001, total)
  if (safeVisible >= total) {
    return { left: 0, width: wrapWidth, wrapWidth }
  }
  const rawWidth = (safeVisible / total) * wrapWidth
  const width = clampNumber(rawWidth, 12, wrapWidth)
  const maxStart = Math.max(0, total - safeVisible)
  const safeStart = clampPreviewStart(previewStartSec.value)
  const startRatio = maxStart > 0 ? safeStart / maxStart : 0
  const maxLeft = Math.max(0, wrapWidth - width)
  const left = startRatio * maxLeft
  return { left, width, wrapWidth }
}

const overviewViewportStyle = computed(() => {
  const { left, width } = resolveOverviewViewportMetrics()
  return {
    left: `${left}px`,
    width: `${width}px`,
    opacity: width > 0 ? '1' : '0'
  }
})

const isValidMixxxWaveformData = (data: MixxxWaveformData | null): data is MixxxWaveformData => {
  if (!data) return false
  const low = data.bands?.low
  const mid = data.bands?.mid
  const high = data.bands?.high
  const all = data.bands?.all
  if (!low || !mid || !high || !all) return false

  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  if (!frameCount) return false

  const isMatch = (arr?: Uint8Array) => (!arr ? true : arr.length === frameCount)
  return (
    isMatch(low.peakLeft) &&
    isMatch(low.peakRight) &&
    isMatch(mid.peakLeft) &&
    isMatch(mid.peakRight) &&
    isMatch(high.peakLeft) &&
    isMatch(high.peakRight) &&
    isMatch(all.peakLeft) &&
    isMatch(all.peakRight)
  )
}

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

  const width = Math.max(1, Math.floor(wrap.clientWidth))
  const height = Math.max(1, Math.floor(wrap.clientHeight))
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  resizePreviewCanvas(canvas, ctx, width, height)

  const totalDuration = resolvePreviewDurationSec()
  const visibleDuration = totalDuration > 0 ? resolveVisibleDurationSec() : 0
  const safeDuration = Math.max(0.001, visibleDuration || totalDuration || 1)
  const rangeStartSec = totalDuration > 0 ? clampPreviewStart(previewStartSec.value) : 0

  if (totalDuration > 0) {
    previewStartSec.value = rangeStartSec
  } else {
    previewStartSec.value = 0
  }
  const isInteracting = previewDragging.value || overviewDragging.value

  drawBeatAlignRekordboxWaveform(ctx, {
    width,
    height,
    bpm: Number(props.bpm) || 0,
    firstBeatMs: Number(props.firstBeatMs) || 0,
    rangeStartSec,
    rangeDurationSec: safeDuration,
    mixxxData: previewMixxxData.value,
    showBackground: false,
    maxSamplesPerPixel: isInteracting
      ? PREVIEW_DRAG_MAX_SAMPLES_PER_PIXEL
      : PREVIEW_IDLE_MAX_SAMPLES_PER_PIXEL,
    showDetailHighlights: !isInteracting,
    showCenterLine: !isInteracting
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

const rebuildOverviewCache = () => {
  const wrap = overviewWrapRef.value
  if (!wrap) {
    overviewCacheCanvas = null
    return
  }

  const width = Math.max(1, Math.floor(wrap.clientWidth))
  const height = Math.max(1, Math.floor(wrap.clientHeight))
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const renderWidth = Math.max(160, Math.min(width, OVERVIEW_MAX_RENDER_COLUMNS))
  const renderPixelWidth = Math.max(1, Math.floor(renderWidth * dpr))
  const renderPixelHeight = Math.max(1, Math.floor(height * dpr))

  if (!overviewCacheCanvas) {
    overviewCacheCanvas = document.createElement('canvas')
  }
  if (
    overviewCacheCanvas.width !== renderPixelWidth ||
    overviewCacheCanvas.height !== renderPixelHeight
  ) {
    overviewCacheCanvas.width = renderPixelWidth
    overviewCacheCanvas.height = renderPixelHeight
  }

  const cacheCtx = overviewCacheCanvas.getContext('2d')
  if (!cacheCtx) return

  cacheCtx.setTransform(1, 0, 0, 1, 0, 0)
  cacheCtx.clearRect(0, 0, renderPixelWidth, renderPixelHeight)
  cacheCtx.scale(dpr, dpr)
  const mixxxData = overviewMixxxData.value
  if (!mixxxData) return
  const low = mixxxData.bands?.low
  const mid = mixxxData.bands?.mid
  const high = mixxxData.bands?.high
  const all = mixxxData.bands?.all
  if (!low || !mid || !high || !all) return
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  if (!frameCount) return

  const duration = Number(mixxxData.duration) || 0
  const raw = overviewRawData.value
  const rawSpan = Math.max(0, duration)
  const rawSamplesPerPixel =
    raw && rawSpan > 0 ? (raw.rate * rawSpan) / Math.max(1, renderWidth * dpr) : 0
  const resolvedRaw = resolveRawWaveformLevel(
    overviewRawPyramidMap,
    overviewRawKey.value,
    raw,
    rawSamplesPerPixel
  )

  const verticalPadding = Math.max(
    0,
    Math.min(Math.floor(height / 3), OVERVIEW_WAVEFORM_VERTICAL_PADDING)
  )
  const drawHeight = Math.max(1, height - verticalPadding * 2)
  cacheCtx.save()
  cacheCtx.translate(0, verticalPadding)
  drawMixxxRgbWaveform(cacheCtx, renderWidth, drawHeight, mixxxData, OVERVIEW_IS_HALF_WAVEFORM, {
    startFrame: 0,
    endFrame: frameCount,
    startTime: 0,
    endTime: Math.max(0, duration),
    raw: resolvedRaw
  })
  cacheCtx.restore()
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

const handleZoomSliderInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null
  const value = Number(target?.value || PREVIEW_MIN_ZOOM)
  if (!Number.isFinite(value) || value <= 0) return
  setPreviewZoom(value, 0.5)
}

const zoomIn = () => setPreviewZoom(previewZoom.value * 1.25, 0.5)
const zoomOut = () => setPreviewZoom(previewZoom.value / 1.25, 0.5)

const handlePreviewWheel = (event: WheelEvent) => {
  const wrap = previewWrapRef.value
  if (!wrap) return
  event.preventDefault()

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
  schedulePreviewDraw()
}

const stopPreviewDragging = () => {
  if (!previewDragging.value) return
  previewDragging.value = false
  window.removeEventListener('mousemove', handlePreviewDragMove)
  window.removeEventListener('mouseup', stopPreviewDragging)
  schedulePreviewDraw()
}

const handlePreviewMouseDown = (event: MouseEvent) => {
  if (event.button !== 0) return
  if (!previewMixxxData.value) return

  previewDragging.value = true
  previewDragStartClientX = event.clientX
  previewDragStartSec = previewStartSec.value
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
  if (!total || !visible) return
  const safeRatio = clampNumber(ratio, 0, 1)
  const targetCenter = safeRatio * total
  previewStartSec.value = clampPreviewStart(targetCenter - visible / 2)
  schedulePreviewDraw()
}

const setPreviewStartByOverviewLeft = (left: number) => {
  const total = resolvePreviewDurationSec()
  const visible = resolveVisibleDurationSec()
  const { width, wrapWidth } = resolveOverviewViewportMetrics()
  if (!total || !visible || wrapWidth <= 0) return
  const maxLeft = Math.max(0, wrapWidth - width)
  const clampedLeft = clampNumber(left, 0, maxLeft)
  const maxStart = Math.max(0, total - visible)
  const start = maxLeft > 0 ? (clampedLeft / maxLeft) * maxStart : 0
  previewStartSec.value = clampPreviewStart(start)
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
  window.removeEventListener('mousemove', handleOverviewMouseMove as EventListener)
  window.removeEventListener('mouseup', stopOverviewDragging as EventListener)
  if (typeof document !== 'undefined') {
    document.body.style.userSelect = ''
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
}

const pickMixxxDataByFile = (response: any, fileKey: string): MixxxWaveformData | null => {
  const items = Array.isArray(response?.items) ? response.items : []
  const item = items.find((entry: any) => normalizePathKey(entry?.filePath) === fileKey)
  const data = (item?.data ?? null) as MixxxWaveformData | null
  return isValidMixxxWaveformData(data) ? data : null
}

const decodeRawFloatArray = (input: unknown): Float32Array | null => {
  if (!input) return null
  if (input instanceof Float32Array) return input

  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }

  if (input instanceof ArrayBuffer) {
    return new Float32Array(input)
  }

  if (typeof input === 'string') {
    try {
      const bytes = Uint8Array.from(atob(input), (char) => char.charCodeAt(0))
      return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
    } catch {
      return null
    }
  }

  return null
}

const decodeRawWaveformData = (payload: any): RawWaveformData | null => {
  if (!payload) return null
  const minLeft = decodeRawFloatArray(payload.minLeft ?? payload.min)
  const maxLeft = decodeRawFloatArray(payload.maxLeft ?? payload.max)
  const minRight = decodeRawFloatArray(payload.minRight ?? payload.min)
  const maxRight = decodeRawFloatArray(payload.maxRight ?? payload.max)
  if (!minLeft || !maxLeft || !minRight || !maxRight) return null

  const frames = Math.max(
    0,
    Math.min(
      Number(payload.frames) || Number.POSITIVE_INFINITY,
      minLeft.length,
      maxLeft.length,
      minRight.length,
      maxRight.length
    )
  )

  return {
    duration: Number(payload.duration) || 0,
    sampleRate: Number(payload.sampleRate) || 0,
    rate: Number(payload.rate) || 0,
    frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight
  }
}

const pickRawDataByFile = (response: any, fileKey: string): RawWaveformData | null => {
  const items = Array.isArray(response?.items) ? response.items : []
  const item = items.find((entry: any) => normalizePathKey(entry?.filePath) === fileKey)
  return decodeRawWaveformData(item?.data ?? null)
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
  overviewMixxxData.value = pickMixxxDataByFile(cacheResult, fileKey)
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

  previewMixxxData.value = null
  overviewMixxxData.value = null
  overviewRawData.value = null
  overviewRawKey.value = ''
  overviewRawPyramidMap.clear()
  previewError.value = ''
  previewZoom.value = PREVIEW_MIN_ZOOM
  previewStartSec.value = 0
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
  try {
    const fileKey = normalizePathKey(normalized)
    const [hiresResult, cacheResult, rawResult] = await Promise.all([
      window.electron.ipcRenderer
        .invoke('mixtape-waveform-hires:batch', {
          filePaths: [normalized],
          targetRate: PREVIEW_HIRES_TARGET_RATE
        })
        .catch(() => null),
      window.electron.ipcRenderer
        .invoke('mixtape-waveform-cache:batch', {
          filePaths: [normalized]
        })
        .catch(() => null),
      window.electron.ipcRenderer
        .invoke('mixtape-waveform-raw:batch', {
          filePaths: [normalized],
          targetRate: PREVIEW_RAW_TARGET_RATE
        })
        .catch(() => null)
    ])

    previewMixxxData.value = pickMixxxDataByFile(hiresResult, fileKey)
    overviewMixxxData.value = pickMixxxDataByFile(cacheResult, fileKey)
    overviewRawData.value = pickRawDataByFile(rawResult, fileKey)
    overviewRawKey.value = fileKey
    if (overviewRawData.value) {
      overviewRawPyramidMap.set(fileKey, buildRawWaveformPyramid(overviewRawData.value))
    } else {
      overviewRawPyramidMap.delete(fileKey)
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
  } catch {
    previewError.value = t('mixtape.gridAdjustWaveformUnavailable')
  } finally {
    previewLoading.value = false
    schedulePreviewDraw()
    scheduleOverviewRebuild()
  }
}

const handleWindowResize = () => {
  schedulePreviewDraw()
  scheduleOverviewRebuild()
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
  () => dialogVisible.value,
  (visible) => {
    if (visible) {
      schedulePreviewDraw()
      scheduleOverviewRebuild()
    }
  }
)

onMounted(() => {
  window.addEventListener('resize', handleWindowResize, { passive: true })
  try {
    window.electron.ipcRenderer.on('mixtape-waveform-updated', handleMixtapeWaveformUpdated)
  } catch {}
})

onBeforeUnmount(() => {
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
  stopPreviewDragging()
  stopOverviewDragging()
  window.removeEventListener('resize', handleWindowResize)
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
        <div v-if="trackTitle" class="track-name" :title="trackTitle">
          {{ trackTitle }}
        </div>
        <div class="meta-row">
          <div class="meta-item">{{ t('mixtape.bpm') }}: {{ bpmDisplay }}</div>
          <div class="meta-item">{{ t('mixtape.firstBeatOffset') }}: {{ firstBeatDisplay }}</div>
          <div class="meta-item">{{ t('mixtape.masterTempo') }}: {{ masterTempoDisplay }}</div>
        </div>
        <div class="preview-toolbar">
          <div class="preview-hint">{{ t('mixtape.gridAdjustViewHint') }}</div>
          <div class="preview-zoom">
            <span>{{ t('mixtape.gridAdjustZoom') }}：</span>
            <button class="zoom-btn" type="button" @click="zoomOut">-</button>
            <input
              class="zoom-slider"
              type="range"
              :min="PREVIEW_MIN_ZOOM"
              :max="PREVIEW_MAX_ZOOM"
              step="0.1"
              :value="previewZoom"
              @input="handleZoomSliderInput"
            />
            <button class="zoom-btn" type="button" @click="zoomIn">+</button>
            <span class="zoom-value">{{ previewZoom.toFixed(1) }}x</span>
          </div>
        </div>
        <div
          ref="previewWrapRef"
          class="preview-canvas-wrap"
          :class="{ 'is-dragging': previewDragging }"
          @mousedown="handlePreviewMouseDown"
          @wheel.prevent="handlePreviewWheel"
        >
          <canvas ref="previewCanvasRef" class="preview-canvas"></canvas>
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

<style lang="scss" scoped>
.dialog-body {
  padding: 16px 20px 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.track-name {
  font-size: 12px;
  color: var(--text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 12px;
  color: var(--text-weak);
}

.meta-item {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
}

.preview-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.preview-hint {
  font-size: 12px;
  color: var(--text-weak);
  white-space: nowrap;
}

.preview-zoom {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-weak);
}

.zoom-slider {
  width: 190px;
}

.zoom-btn {
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  border-radius: 3px;
}

.zoom-btn:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.zoom-value {
  min-width: 42px;
  text-align: right;
}

.preview-canvas-wrap {
  position: relative;
  height: 176px;
  border: 1px solid rgba(124, 166, 212, 0.3);
  border-radius: 6px;
  background: transparent;
  cursor: grab;
  overflow: hidden;
}

.preview-canvas-wrap.is-dragging {
  cursor: grabbing;
}

.preview-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.overview-canvas-wrap {
  position: relative;
  height: 66px;
  border: 1px solid rgba(124, 166, 212, 0.28);
  border-radius: 6px;
  background: transparent;
  overflow: hidden;
  cursor: grab;
}

.overview-canvas-wrap.is-dragging {
  cursor: grabbing;
}

.overview-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.overview-viewport {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  border: 1px solid rgba(145, 205, 255, 0.95);
  background: rgba(145, 205, 255, 0.08);
  border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25) inset;
  pointer-events: none;
  will-change: transform;
}

.preview-status {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 12px;
  color: var(--text-weak);
  background: rgba(5, 10, 16, 0.6);
  padding: 6px 10px;
  border-radius: 4px;
  pointer-events: none;
}

.preview-status.is-error {
  color: #f6a2a2;
}
</style>
