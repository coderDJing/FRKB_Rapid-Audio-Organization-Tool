<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { createBeatAlignPreviewRenderer } from '@renderer/components/mixtapeBeatAlignPreviewRenderer'
import {
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  PREVIEW_MAX_ZOOM,
  PREVIEW_MIN_ZOOM,
  PREVIEW_RAW_TARGET_RATE,
  clampNumber,
  resolveVisibleDurationSecByZoom
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { pickRawDataByFile } from '@renderer/components/mixtapeBeatAlignRawWaveform'

const props = defineProps<{
  song: ISongInfo | null
  direction: 'up' | 'down'
}>()

const runtime = useRuntimeStore()
const wrapRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const rawData = ref<RawWaveformData | null>(null)
const mixxxData = ref<MixxxWaveformData | null>(null)
const previewZoom = ref(PREVIEW_MIN_ZOOM)
const previewStartSec = ref(0)
const dragging = ref(false)

const previewRenderer = createBeatAlignPreviewRenderer()

let resizeObserver: ResizeObserver | null = null
let loadToken = 0
let drawRaf = 0
let dragStartClientX = 0
let dragStartSec = 0

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

const clampPreviewStart = (value: number) => {
  const duration = resolvePreviewDurationSec()
  const visibleDuration = resolveVisibleDurationSec()
  if (!duration || !visibleDuration) return 0
  return clampNumber(value, 0, Math.max(0, duration - visibleDuration))
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
    bpm: Number(props.song?.bpm) || 128,
    firstBeatMs: 0,
    barBeatOffset: 0,
    rangeStartSec: previewStartSec.value,
    rangeDurationSec: visibleDuration,
    mixxxData: mixxxData.value,
    rawData: rawData.value,
    maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
    showDetailHighlights: true,
    showCenterLine: false,
    showBackground: false,
    showBeatGrid: true,
    waveformLayout: props.direction === 'up' ? 'top-half' : 'bottom-half'
  })
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
  scheduleDraw()
}

const loadWaveform = async () => {
  const currentSong = props.song
  const currentToken = ++loadToken
  rawData.value = null
  mixxxData.value = null
  previewZoom.value = PREVIEW_MIN_ZOOM
  previewStartSec.value = 0
  previewRenderer.reset()
  clearCanvas()

  const filePath = String(currentSong?.filePath || '').trim()
  if (!filePath) return

  try {
    const response = await window.electron.ipcRenderer.invoke('mixtape-waveform-raw:batch', {
      filePaths: [filePath],
      targetRate: PREVIEW_RAW_TARGET_RATE,
      preferSharedDecode: true
    })

    if (currentToken !== loadToken) return
    const picked = pickRawDataByFile(response, normalizePathKey(filePath), normalizePathKey)
    rawData.value = picked
    mixxxData.value = picked ? createRawPlaceholderMixxxData(picked) : null
    previewStartSec.value = 0
    scheduleDraw()
  } catch {
    if (currentToken !== loadToken) return
    rawData.value = null
    mixxxData.value = null
    previewRenderer.reset()
    clearCanvas()
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
  () => props.direction,
  () => {
    previewRenderer.reset()
    scheduleDraw()
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
  scheduleDraw()
})

onUnmounted(() => {
  loadToken += 1
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
</script>

<template>
  <div
    ref="wrapRef"
    :class="[
      'raw-detail-waveform',
      `raw-detail-waveform--${props.direction}`,
      { 'is-dragging': dragging }
    ]"
    @mousedown.stop="handleMouseDown"
    @wheel.prevent.stop="handleWheel"
  >
    <canvas ref="canvasRef" class="raw-detail-waveform__canvas"></canvas>
  </div>
</template>

<style scoped lang="scss">
.raw-detail-waveform {
  width: 100%;
  height: 66.6667%;
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
</style>
